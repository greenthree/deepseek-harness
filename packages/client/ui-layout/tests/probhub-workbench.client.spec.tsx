// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { probHubController } from '../src/client/probhub-controller.ts'
import { ProbHubWorkbench, type ProbHubWorkbenchProps } from '../src/client/ProbHubWorkbench.tsx'
import type { JobView, SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'

const SESSION = 'session-a' as SessionId

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function useSessionsWithJobs(jobsBySession: SessionListState['jobsBySession'] = {}): ProbHubWorkbenchProps['useSessions'] {
  return select => select({
    ids: [SESSION], byId: {}, current: SESSION, phase: 'ready',
    subagentsByParent: {}, jobsBySession, currentAddress: undefined,
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  void probHubController.refresh(undefined)
})

describe('ProbHub workbench report projection', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        state: 'ready',
        workspaceId: 'workspace-a',
        problems: [{ id: 'A01', title: 'Alpha', judge: 'standard', difficulty: 'easy', status: 'current', revision: 'rev-a' }],
        report: {
          ok: true,
          problems: [{
            id: 'A01',
            tests: { total: { cases: 4 } },
            groups: [{ name: 'negative', role: 'wrong-solution-killer' }],
            aggregateConstraints: { state: 'matched', multiCaseDetected: true },
            judgeQa: { state: 'passed', declared_cases: 2, matched_cases: 2 },
            calibration: { state: 'current' },
          }],
        },
      }),
    } as Response)))
  })

  it('renders Core report summaries in the problem and health tabs', async () => {
    await act(async () => { await probHubController.refresh('session-a') })
    const useSessions = useSessionsWithJobs()
    render(<ProbHubWorkbench sessionId="session-a" useSessions={useSessions} />)

    expect(screen.getAllByText('Alpha')).not.toHaveLength(0)
    expect(screen.getByText('测试点')).toBeTruthy()
    expect(screen.getByText('4')).toBeTruthy()
    expect(screen.getByRole('complementary', { name: 'AI 副驾驶' }).textContent).toContain('题目验证上下文')

    await act(async () => { screen.getByRole('button', { name: '查看健康' }).click() })
    expect(screen.getByRole('button', { name: '健康与评测' }).getAttribute('aria-selected')).toBe('true')

    expect(screen.getByText('健康摘要')).toBeTruthy()
    expect(screen.getAllByText('Judge QA')).not.toHaveLength(0)
    expect(screen.getByText('matched')).toBeTruthy()
    expect(screen.getAllByText('passed')).not.toHaveLength(0)
    expect(screen.getByText('1 个错解覆盖组')).toBeTruthy()
  })

  it('shows only ProbHub jobs and preserves every lifecycle status in health', async () => {
    await act(async () => { await probHubController.refresh('session-a') })
    const statuses: JobView['status'][] = ['running', 'stopping', 'completed', 'failed', 'killed']
    const jobs = [
      ...statuses.map((status, index) => ({
        id: `probhub-${index}` as JobView['id'], kind: 'probhub', label: `judge-${status}`, status, startedAt: 1,
      })),
      { id: 'bash-1' as JobView['id'], kind: 'bash', label: 'not-probhub', status: 'running' as const, startedAt: 1 },
    ]
    const useSessions = useSessionsWithJobs({ [SESSION]: jobs })
    render(<ProbHubWorkbench sessionId="session-a" useSessions={useSessions} />)

    await act(async () => { screen.getByRole('button', { name: '健康与评测' }).click() })
    const taskRegion = screen.getByRole('region', { name: 'ProbHub 后台任务' })
    expect(taskRegion.querySelectorAll('li')).toHaveLength(5)
    for (const status of statuses) {
      expect(taskRegion.querySelector(`[data-status="${status}"]`)).toBeTruthy()
      expect(taskRegion.textContent).toContain(status)
    }
    expect(taskRegion.textContent).not.toContain('not-probhub')
  })

  it('starts a non-publishing checkpoint job from the delivery checklist', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (input) => {
      const url = requestUrl(input)
      if (url.includes('/probhub/api/jobs')) {
        return new Response(JSON.stringify({ ok: true, state: 'ready', job: { id: 'probhub-1', operation: 'checkpoint', problemId: 'A01' } }), { status: 200 })
      }
      return new Response(JSON.stringify({
        state: 'ready', workspaceId: 'workspace-a',
        problems: [{ id: 'A01', title: 'Alpha', status: 'stale', lintOk: true, revision: 'a'.repeat(64) }],
        report: { ok: true, problems: [{ id: 'A01', judgeQa: { state: 'passed' }, calibration: { state: 'current' } }] },
      }), { status: 200 })
    })
    await act(async () => { await probHubController.refresh('session-a') })
    render(<ProbHubWorkbench sessionId="session-a" useSessions={useSessionsWithJobs()} />)
    await act(async () => { screen.getByRole('button', { name: '健康与评测' }).click() })

    expect(screen.getByRole('region', { name: 'ProbHub 交付清单' })).toBeTruthy()
    await act(async () => { screen.getByRole('button', { name: 'Checkpoint' }).click() })
    expect((await screen.findByRole('status')).textContent).toContain('probhub-1')
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).includes('/probhub/api/jobs'))).toBe(true)
  })

  it('shows the isolated preview PDF only when Core reports a generation', async () => {
    vi.mocked(fetch).mockImplementation(async (_input, init) => init?.method === 'HEAD'
      ? new Response(null, { status: 200, headers: { 'content-type': 'application/pdf' } })
      : new Response(JSON.stringify({
        state: 'ready', workspaceId: 'workspace-a',
        problems: [{ id: 'A01', title: 'Alpha', status: 'current', generation: 'gen-1' }],
      }), { status: 200 }))
    await act(async () => { await probHubController.refresh('session-a') })
    render(<ProbHubWorkbench sessionId="session-a" useSessions={useSessionsWithJobs()} />)
    await act(async () => { screen.getByRole('button', { name: '试卷 PDF' }).click() })
    await waitFor(() => { expect(screen.getByTitle('A01 试卷 PDF 预览')).toBeTruthy() })
    const frame = screen.getByTitle('A01 试卷 PDF 预览')
    expect(frame.getAttribute('src')).toBe('/probhub/api/problems/A01/preview?sessionId=session-a')
    expect(screen.getByText('隔离 preview generation')).toBeTruthy()
  })

  it('renders concrete formal-delivery blockers returned by the Host gate', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (input) => {
      const url = requestUrl(input)
      if (url.includes('/probhub/api/delivery-check')) {
        return new Response(JSON.stringify({
          ok: false,
          state: 'ready',
          delivery: {
            ok: false,
            state: 'blocked',
            problemIds: ['A01'],
            checks: {
              revision: { A01: { sealed: false, consistent: false, sourceHash: 'a'.repeat(64), dataHash: 'b'.repeat(64) } },
              generation: { generationId: 'gen-1', state: 'draft', complete: false, allSealed: false, missing: [{ problemId: 'A01', reason: 'no checkpoint' }], staleFields: [], problems: [] },
              packages: { A01: { state: 'missing', ok: false, verification: { ok: false, state: 'missing' } } },
            },
            blockers: [
              { code: 'generation_incomplete' },
              { code: 'sealed_revision_invalid', problemId: 'A01' },
            ],
            report: { ok: true },
          },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        state: 'ready', workspaceId: 'workspace-a',
        problems: [{ id: 'A01', title: 'Alpha', status: 'current', revision: 'a'.repeat(64) }],
      }), { status: 200 })
    })
    await act(async () => { await probHubController.refresh('session-a') })
    render(<ProbHubWorkbench sessionId="session-a" useSessions={useSessionsWithJobs()} />)
    await act(async () => { screen.getByRole('button', { name: '健康与评测' }).click() })
    await act(async () => { screen.getByRole('button', { name: '检查正式交付' }).click() })
    const blockers = await screen.findByRole('list', { name: '正式交付阻断原因' })
    expect(blockers.textContent).toContain('预览 generation 未完成')
    expect(blockers.textContent).toContain('sealed revision 无效 · A01')
    const details = screen.getByRole('region', { name: '正式交付摘要' })
    expect(details.textContent).toContain('gen-1 · draft')
    expect(details.textContent).toContain('source / data')
    expect(details.textContent).toContain('Core report')
    expect(details.textContent).toContain('passed')
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).includes('/probhub/api/delivery-check'))).toBe(true)
  })

  it('rejects malformed nested delivery details instead of rendering them', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (input) => {
      if (requestUrl(input).includes('/probhub/api/delivery-check')) {
        return new Response(JSON.stringify({
          delivery: {
            ok: true,
            state: 'ready',
            problemIds: ['A01'],
            checks: { revision: { A01: { sealed: 'yes', consistent: true } }, generation: {}, packages: {} },
            blockers: [],
          },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ state: 'ready', workspaceId: 'workspace-a', problems: [{ id: 'A01', title: 'Alpha', status: 'current' }] }), { status: 200 })
    })
    await act(async () => { await probHubController.refresh('session-a') })
    render(<ProbHubWorkbench sessionId="session-a" useSessions={useSessionsWithJobs()} />)
    await act(async () => { screen.getByRole('button', { name: '健康与评测' }).click() })
    await act(async () => { screen.getByRole('button', { name: '检查正式交付' }).click() })
    expect((await screen.findByRole('alert')).textContent).toContain('交付门禁返回了无效检查详情')
    expect(screen.queryByRole('region', { name: '正式交付摘要' })).toBeNull()
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).includes('/probhub/api/delivery-check'))).toBe(true)
  })

  it('cancels a running ProbHub job from the health task list', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (input) => {
      const url = requestUrl(input)
      if (url.includes('/probhub/api/jobs/cancel')) return new Response(JSON.stringify({ ok: true, state: 'ready', cancelled: true }), { status: 200 })
      return new Response(JSON.stringify({ state: 'ready', workspaceId: 'workspace-a', problems: [{ id: 'A01', title: 'Alpha' }] }), { status: 200 })
    })
    await act(async () => { await probHubController.refresh('session-a') })
    const useSessions = useSessionsWithJobs({ [SESSION]: [{ id: 'probhub-1' as JobView['id'], kind: 'probhub', label: 'judge A01', status: 'running', startedAt: 1 }] })
    render(<ProbHubWorkbench sessionId="session-a" useSessions={useSessions} />)
    await act(async () => { screen.getByRole('button', { name: '健康与评测' }).click() })
    act(() => { screen.getByRole('button', { name: '取消' }).click() })
    expect((await screen.findByRole('status')).textContent).toContain('probhub-1')
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).includes('/probhub/api/jobs/cancel'))).toBe(true)
  })

  it('applies a validated Host tab hint without POSTing selection context', async () => {
    await act(async () => { await probHubController.refresh('session-a') })
    const useSessions = useSessionsWithJobs()
    render(<ProbHubWorkbench sessionId="session-a" useSessions={useSessions} />)
    const calls = vi.mocked(fetch).mock.calls.length

    act(() => { probHubController.requestTab('health', 'session-a', 'A01') })
    expect(screen.getByRole('button', { name: '健康与评测' }).getAttribute('aria-selected')).toBe('true')
    expect(vi.mocked(fetch).mock.calls).toHaveLength(calls)

    // Session and problem fences fail closed, and still do not perform a
    // network write when a forged remote frame is presented to the controller.
    act(() => { probHubController.requestTab('pdf', 'other-session', 'A01') })
    expect(screen.getByRole('button', { name: '健康与评测' }).getAttribute('aria-selected')).toBe('true')
    act(() => { probHubController.requestTab('pdf', 'session-a', 'missing') })
    expect(screen.getByRole('button', { name: '健康与评测' }).getAttribute('aria-selected')).toBe('true')
    expect(vi.mocked(fetch).mock.calls).toHaveLength(calls)
  })

  it('replays a valid tab hint received while the overview is loading', async () => {
    let resolveOverview!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveOverview = resolve })))
    const refreshPromise = probHubController.refresh('session-a')
    act(() => { probHubController.requestTab('health', 'session-a', 'A01') })
    resolveOverview({
      ok: true,
      status: 200,
      json: async () => ({
        state: 'ready',
        problems: [{ id: 'A01', title: 'Alpha' }],
      }),
    } as Response)
    await act(async () => { await refreshPromise })
    const useSessions: ProbHubWorkbenchProps['useSessions'] = select => select({
      ids: [SESSION], byId: {}, current: SESSION, phase: 'ready',
      subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    })
    render(<ProbHubWorkbench sessionId="session-a" useSessions={useSessions} />)
    expect(screen.getByRole('button', { name: '健康与评测' }).getAttribute('aria-selected')).toBe('true')
  })

  it('loads the statement editor through the source bridge with the Core revision', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (input, init) => {
      const url = requestUrl(input)
      if (url.includes('/probhub/api/source')) {
        return new Response(JSON.stringify({
          ok: true,
          state: 'ready',
          source: { target: 'statement', content: '# Editable\n', revision: 'a'.repeat(64), bytes: 11 },
          impact: { source: true, data: false, formalArtifacts: true },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      void init
      return new Response(JSON.stringify({
        state: 'ready', workspaceId: 'workspace-a',
        problems: [{ id: 'A01', title: 'Alpha', judge: 'standard', status: 'current', revision: 'a'.repeat(64) }],
        report: { ok: true, problems: [{ id: 'A01', tests: { total: { cases: 1 } } }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    await act(async () => { await probHubController.refresh('session-a') })
    render(<ProbHubWorkbench sessionId="session-a" useSessions={useSessionsWithJobs()} />)

    await act(async () => { screen.getByRole('button', { name: '编辑题面' }).click() })
    const editor = await screen.findByRole('textbox', { name: '题面编辑器' })
    expect((editor as HTMLTextAreaElement).value).toBe('# Editable\n')
    expect(screen.getByText(/revision a{12}/)).toBeTruthy()
    await act(async () => { fireEvent.change(editor, { target: { value: '# Changed\n' } }) })
    expect(screen.getByRole('button', { name: '保存源文件' }).hasAttribute('disabled')).toBe(false)
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).includes('/probhub/api/source'))).toBe(true)
  })

  it('lists source targets and switches files without losing unsaved edits', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (input) => {
      const url = requestUrl(input)
      if (url.includes('/probhub/api/source-targets')) {
        return new Response(JSON.stringify({
          ok: true,
          state: 'ready',
          targets: [
            { target: 'statement', kind: 'statement', bytes: 10 },
            { target: 'config', kind: 'config', bytes: 20 },
            { target: 'code:std.cpp', kind: 'code', name: 'std.cpp', bytes: 30 },
            { target: 'sample-input:01.in', kind: 'sample-input', name: '01.in', bytes: 2 },
            { target: 'secret-input:01.in', kind: 'secret-input', name: '01.in', bytes: 2 },
          ],
        }), { status: 200 })
      }
      if (url.includes('/probhub/api/source')) {
        const target = new URL(url, 'http://localhost').searchParams.get('target') ?? 'statement'
        const content = target === 'code:std.cpp' ? 'int main() {}\n' : '# Editable\n'
        return new Response(JSON.stringify({
          ok: true,
          state: 'ready',
          source: { target, content, revision: 'a'.repeat(64), bytes: content.length },
          impact: { source: !target.includes('input'), data: target.includes('input'), formalArtifacts: true },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        state: 'ready', workspaceId: 'workspace-a',
        problems: [{ id: 'A01', title: 'Alpha', judge: 'standard', status: 'current', revision: 'a'.repeat(64) }],
      }), { status: 200 })
    })
    await act(async () => { await probHubController.refresh('session-a') })
    render(<ProbHubWorkbench sessionId="session-a" useSessions={useSessionsWithJobs()} />)

    await act(async () => { screen.getByRole('button', { name: '编辑题面' }).click() })
    await screen.findByRole('textbox', { name: '题面编辑器' })
    const targetPicker = screen.getByRole('combobox', { name: '编辑目标' })
    expect(targetPicker.querySelectorAll('option')).toHaveLength(5)
    await act(async () => { fireEvent.change(targetPicker, { target: { value: 'code:std.cpp' } }) })
    await waitFor(() => {
      const currentEditor = screen.getByRole('textbox', { name: '题面编辑器' })
      if (!(currentEditor instanceof HTMLTextAreaElement)) throw new Error('expected a textarea editor')
      expect(currentEditor.value).toBe('int main() {}\n')
    })

    await act(async () => { fireEvent.change(screen.getByRole('textbox', { name: '题面编辑器' }), { target: { value: 'changed\n' } }) })
    expect(screen.getByRole('combobox', { name: '编辑目标' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '保存源文件' }).hasAttribute('disabled')).toBe(false)
  })
})
