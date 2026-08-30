// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
    expect(screen.getByText('Judge QA')).toBeTruthy()
    expect(screen.getByText('matched')).toBeTruthy()
    expect(screen.getByText('passed')).toBeTruthy()
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
    expect(screen.getByRole('button', { name: '保存题面' }).hasAttribute('disabled')).toBe(false)
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).includes('/probhub/api/source'))).toBe(true)
  })
})
