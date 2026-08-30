import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { JobView, SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ProbHubWorkbench.module.css'
import { listProbHubSourceTargets, probHubController, readProbHubSource, saveProbHubSource, useProbHub, type ProbHubSourceDocument, type ProbHubSourceError, type ProbHubSourceTarget } from './probhub-controller.ts'

/** Read-only projection returned by the Harness ProbHub prefix route. */
export interface ProbHubProblem {
  id: string
  index?: number
  title?: string
  judge?: string
  difficulty?: string
  status?: string
  revision?: string
  generation?: string
}

export interface ProbHubProblemReport {
  id?: string
  name?: string
  difficulty?: number
  tags?: string[]
  limits?: Record<string, number>
  tests?: Record<string, Record<string, number>>
  groups?: Array<{ name?: string; role?: string; total_cases?: number; secret_cases?: number }>
  aggregateConstraints?: { state?: string; multiCaseDetected?: boolean; summary?: Record<string, number> }
  calibration?: { state?: string; status?: string }
  judgeQa?: { state?: string; status?: string; declared_cases?: number; evidence_cases?: number; matched_cases?: number }
  mutation?: { state?: string; status?: string; summary?: Record<string, number> }
  killMatrix?: { evidenceState?: string; rows?: Array<{ program?: string; overall?: string }> }
  diagnostics?: Array<{ code?: string; severity?: string; message?: string }>
}

export interface ProbHubReport {
  ok: boolean
  analysisState?: string
  summary?: Record<string, number>
  problems?: ProbHubProblemReport[]
  diagnostics?: Array<{ code?: string; severity?: string; message?: string }>
}

export interface ProbHubOverview {
  state: 'ready' | 'migration_required' | 'unavailable' | 'error'
  workspaceId?: string
  workspace?: { schemaVersion?: number }
  revision?: string
  generation?: string
  problems?: ProbHubProblem[]
  selectedId?: string
  report?: ProbHubReport
}

const EMPTY_OVERVIEW: ProbHubOverview = { state: 'unavailable', problems: [] }
const EMPTY_JOBS: readonly JobView[] = []
const TABS = ['题面', '健康与评测', '试卷 PDF'] as const
type Tab = (typeof TABS)[number]

function assertNever(value: never): never {
  throw new Error(`unexpected ProbHub UI value: ${String(value)}`)
}

function displayTab(tab: 'statement' | 'health' | 'pdf'): Tab {
  switch (tab) {
    case 'statement': return '题面'
    case 'health': return '健康与评测'
    case 'pdf': return '试卷 PDF'
    default: return assertNever(tab)
  }
}

export interface ProbHubWorkbenchProps {
  sessionId?: string | undefined
  useSessions: SnapshotSelectorHook<SessionListState>
  children?: ReactNode
}

interface SourceEditorState {
  readonly target: string
  readonly content: string
  readonly originalContent: string
  readonly revision: string
  readonly bytes: number
  readonly impact?: ProbHubSourceDocument['impact']
  readonly loading?: boolean
  readonly saving?: boolean
  readonly error?: ProbHubSourceError
  readonly message?: string
}

function sourceTargetLabel(target: ProbHubSourceTarget): string {
  if (target.kind === 'statement') return '题面 · problem.md'
  if (target.kind === 'config') return '配置 · probhub.yaml'
  if (target.kind === 'code') return `代码 · ${target.name ?? target.target}`
  if (target.kind === 'sample-input') return `样例输入 · ${target.name ?? target.target}`
  return `正式输入 · ${target.name ?? target.target}`
}

function clearEditorFeedback(state: SourceEditorState): SourceEditorState {
  const next = { ...state }
  delete next.error
  delete next.message
  return next
}

function statusLabel(status: string | undefined): string {
  if (status === 'current') return 'current'
  if (status === 'stale') return 'stale'
  if (status === 'blocked') return 'blocked'
  if (status === 'warn') return 'warn'
  return status ?? 'unavailable'
}

/** The health tab only owns ProbHub jobs; shell and plugin jobs stay in ui-jobs. */
function filterProbHubJobs(jobs: readonly JobView[]): readonly JobView[] {
  return jobs.filter(job => job.kind === 'probhub')
}

/** Keep the displayed lifecycle vocabulary closed to the JobView contract. */
function jobStatusLabel(status: JobView['status']): JobView['status'] {
  switch (status) {
    case 'running': return 'running'
    case 'stopping': return 'stopping'
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'killed': return 'killed'
    default: return assertNever(status)
  }
}


function StateNotice({ overview }: { overview: ProbHubOverview }) {
  const title = overview.state === 'migration_required'
    ? '需要迁移到 Workspace Schema v1'
    : overview.state === 'unavailable'
      ? 'ProbHub 尚未连接'
      : '暂时无法读取题目状态'
  const detail = overview.state === 'migration_required'
    ? '当前 Session 没有可执行的 .probhub/workspace.yaml。工作台保持只读。'
    : overview.state === 'unavailable'
      ? '等待 Harness Host 提供同源只读摘要；不会读取旧 meta.json 或生成物。'
      : '读取失败时保持 fail closed，不展示可能过期的题面、PDF 或 evidence。'
  return (
    <div className={css.stateNotice} role="status">
      <span className={css.noticeMark} aria-hidden="true">i</span>
      <div><strong>{title}</strong><p>{detail}</p></div>
    </div>
  )
}

function WorkbenchBody({
  problem,
  report,
  jobs,
  tab,
  editor,
  sourceTargets,
  onOpenEditor,
  onSelectEditorTarget,
  onChangeEditor,
  onSaveEditor,
  onReloadEditor,
}: {
  problem: ProbHubProblem | undefined
  report: ProbHubProblemReport | undefined
  jobs: readonly JobView[]
  tab: Tab
  editor: SourceEditorState | undefined
  sourceTargets: readonly ProbHubSourceTarget[]
  onOpenEditor: () => void
  onSelectEditorTarget: (target: string) => void
  onChangeEditor: (content: string) => void
  onSaveEditor: () => void
  onReloadEditor: () => void
}) {
  if (problem === undefined) {
    return <StateNotice overview={EMPTY_OVERVIEW} />
  }
  if (tab === '题面') {
    const editorTarget = editor === undefined ? undefined : sourceTargets.find(target => target.target === editor.target)
    return (
      <div className={css.previewStack}>
        <div className={css.previewCard}>
          <div className={css.previewEyebrow}>题面预览 · 只读</div>
          <h3>{problem.title || problem.id}</h3>
          <p>题面内容来自当前 Session 的规范工作区。编辑会先校验 Core revision，保存只写入白名单中的当前源文件。</p>
          {editor === undefined && <>
            <div className={css.skeletonLine} /><div className={css.skeletonLine} /><div className={css.skeletonLineShort} />
            <button className={css.editorButton} type="button" onClick={onOpenEditor}>编辑题面</button>
          </>}
          {editor?.loading && <div className={css.editorNotice}>正在读取题面…</div>}
          {editor && !editor.loading && <div className={css.editorPanel}>
            <div className={css.editorHeader}>
              <div><strong>{editorTarget === undefined ? '源文件编辑' : sourceTargetLabel(editorTarget)}</strong><small>workspace-write · revision {editor.revision.slice(0, 12)}…</small></div>
              <button className={css.editorButtonSecondary} type="button" onClick={onReloadEditor} disabled={editor.saving}>重新读取</button>
            </div>
            <label className={css.editorTargetRow}>编辑目标
              <select
                className={css.editorTargetSelect}
                aria-label="编辑目标"
                value={editor.target}
                disabled={editor.saving || editor.content !== editor.originalContent}
                onChange={(event) => { onSelectEditorTarget(event.target.value) }}
              >
                {sourceTargets.map(target => <option key={target.target} value={target.target}>{sourceTargetLabel(target)}</option>)}
              </select>
            </label>
            <textarea className={css.sourceEditor} value={editor.content} onChange={(event) => { onChangeEditor(event.target.value) }} spellCheck={false} aria-label="题面编辑器" />
            {editor.impact && <div className={css.impactNotice}>保存后将标记 source 与正式 PDF/ZIP 为 stale，需要重新 lint、验证和分发。</div>}
            {editor.error && <div className={css.editorError} role="alert">{editor.error.message}{editor.error.code === 'source_conflict' && ' 请重新读取后再保存。'}</div>}
            {editor.message && <div className={css.editorSuccess} role="status">{editor.message}</div>}
            <div className={css.editorActions}>
              <span>{editor.bytes} bytes</span>
              <button className={css.editorButton} type="button" onClick={onSaveEditor} disabled={editor.saving || editor.content === editor.originalContent}>{editor.saving ? '保存中…' : '保存源文件'}</button>
            </div>
          </div>}
        </div>
        <div className={css.metaGrid}>
          <div><span>Judge</span><strong>{problem.judge ?? 'Standard'}</strong></div>
          <div><span>难度</span><strong>{problem.difficulty ?? '待定'}</strong></div>
          <div><span>revision</span><strong>{problem.revision ?? '—'}</strong></div>
          <div><span>generation</span><strong>{problem.generation ?? '—'}</strong></div>
          {report?.tests?.total && <div><span>测试点</span><strong>{report.tests.total.cases ?? '—'}</strong></div>}
          {report?.aggregateConstraints?.state && <div><span>累计约束</span><strong>{report.aggregateConstraints.state}</strong></div>}
        </div>
      </div>
    )
  }
  if (tab === '健康与评测') {
    if (problem.status === undefined && report === undefined && jobs.length === 0) return <StateNotice overview={EMPTY_OVERVIEW} />
    return (
      <div className={css.previewStack}>
        <div className={css.healthCard}>
          <span className={css.healthIcon}>{problem.status === 'current' && report?.judgeQa?.state !== 'failed' ? '✓' : '!'}</span>
          <div><strong>健康摘要</strong><p>状态、数据覆盖、累计约束和 Judge QA 均来自 Core 的脱敏报告。</p></div>
          <span className={css.healthStatus}>{statusLabel(problem.status ?? report?.judgeQa?.state)}</span>
        </div>
        {report && <div className={css.reportGrid}>
          <div className={css.reportCard}><span>数据组</span><strong>{report.groups?.length ?? 0}</strong><small>{report.groups?.filter(group => group.role === 'wrong-solution-killer').length ?? 0} 个错解覆盖组</small></div>
          <div className={css.reportCard}><span>Judge QA</span><strong>{report.judgeQa?.state ?? 'not-configured'}</strong><small>{report.judgeQa?.matched_cases ?? 0}/{report.judgeQa?.declared_cases ?? 0} cases</small></div>
          <div className={css.reportCard}><span>累计约束</span><strong>{report.aggregateConstraints?.state ?? 'not-detected'}</strong><small>{report.aggregateConstraints?.multiCaseDetected ? '检测到多测' : '未检测到多测'}</small></div>
          <div className={css.reportCard}><span>校准</span><strong>{report.calibration?.state ?? 'missing'}</strong><small>本机测量仅作参考</small></div>
        </div>}
        {jobs.length > 0 && <section className={css.jobSummary} aria-label="ProbHub 后台任务">
          <div className={css.jobSummaryHeader}>
            <div><strong>后台评测任务</strong><small>当前 Session 的 ProbHub Job</small></div>
            <span>{jobs.length}</span>
          </div>
          <ul className={css.jobList}>
            {jobs.map((job) => {
              const status = jobStatusLabel(job.status)
              return (
                <li key={job.id} className={css.jobRow} data-status={status}>
                  <span className={css.jobDot} data-status={status} aria-hidden="true" />
                  <div className={css.jobIdentity}>
                    <strong title={job.label}>{job.label}</strong>
                    {job.detail && <small title={job.detail}>{job.detail}</small>}
                  </div>
                  <span className={css.jobStatus} data-status={status}>{status}</span>
                </li>
              )
            })}
          </ul>
        </section>}
      </div>
    )
  }
  return (
    <div className={css.pdfPlaceholder}>
      <div className={css.pdfIcon}>PDF</div>
      <strong>试卷 PDF 预览</strong>
      <p>PDF 由 ProbHub Core 生成。当前仅展示 generation 与可用性；正式构建仍需显式交付操作。</p>
      <button type="button" disabled>打开只读预览</button>
    </div>
  )
}

/**
 * Read-only ProbHub workbench. The fetch is intentionally a narrow same-origin
 * projection; a missing route never falls back to legacy files or invents
 * problem data.
 */
export function ProbHubWorkbench({ sessionId, useSessions, children }: ProbHubWorkbenchProps) {
  const { snapshot: overview, selectedId, tabRequest } = useProbHub()
  const [tab, setTab] = useState<Tab>('题面')
  const [copilotOpen, setCopilotOpen] = useState(false)
  const [editor, setEditor] = useState<SourceEditorState | undefined>()
  const [sourceTargets, setSourceTargets] = useState<readonly ProbHubSourceTarget[]>([])
  const appliedTabRequest = useRef(0)
  const editorRequest = useRef(0)
  const lastStableSession = useRef(sessionId)
  const lastStableProblem = useRef<string | undefined>(undefined)

  const problems = overview.problems ?? []
  const sessionJobs = useSessions(state => sessionId === undefined
    ? EMPTY_JOBS
    : state.jobsBySession[sessionId as SessionId] ?? EMPTY_JOBS)
  const jobs = useMemo(() => filterProbHubJobs(sessionJobs), [sessionJobs])
  const selected = useMemo(() => problems.find(problem => problem.id === selectedId) ?? problems[0], [problems, selectedId])
  const selectedReport = useMemo(
    () => overview.report?.problems?.find(report => report.id === selected?.id),
    [overview.report, selected?.id],
  )
  useEffect(() => {
    const sessionChanged = lastStableSession.current !== sessionId
    const problemChanged = selected?.id !== undefined
      && lastStableProblem.current !== undefined
      && selected.id !== lastStableProblem.current
    if (sessionChanged || problemChanged) {
      setEditor(undefined)
      setSourceTargets([])
    }
    lastStableSession.current = sessionId
    if (selected?.id !== undefined) lastStableProblem.current = selected.id
  }, [selected?.id, sessionId])
  const readEditorTarget = async (target: string): Promise<void> => {
    if (sessionId === undefined || selected === undefined) return
    const targetSession = sessionId
    const targetProblem = selected.id
    const requestId = ++editorRequest.current
    setEditor((current) => {
      const base = current ?? { target, content: '', originalContent: '', revision: '', bytes: 0 }
      const next = clearEditorFeedback(base)
      return {
        ...next,
        target,
        loading: true,
        saving: false,
      }
    })
    const result = await readProbHubSource(targetSession, targetProblem, target)
    if (requestId !== editorRequest.current || targetSession !== sessionId || targetProblem !== selected.id) return
    if (result.error !== undefined || result.document === undefined) {
      setEditor(current => current === undefined ? current : { ...current, loading: false, error: result.error ?? { code: 'source_read_failed', message: '无法读取源文件' } })
      return
    }
    setEditor({ ...result.document, originalContent: result.document.content })
  }
  const openEditor = async (): Promise<void> => {
    if (sessionId === undefined || selected === undefined) return
    const targetSession = sessionId
    const targetProblem = selected.id
    const requestId = ++editorRequest.current
    setEditor({ target: 'statement', content: '', originalContent: '', revision: '', bytes: 0, loading: true })
    const [targetsResult, result] = await Promise.all([
      listProbHubSourceTargets(targetSession, targetProblem),
      readProbHubSource(targetSession, targetProblem),
    ])
    if (requestId !== editorRequest.current || targetSession !== sessionId || targetProblem !== selected.id) return
    if (targetsResult.targets !== undefined) setSourceTargets(targetsResult.targets)
    if (result.error !== undefined || result.document === undefined) {
      setEditor({ target: 'statement', content: '', originalContent: '', revision: '', bytes: 0, error: result.error ?? { code: 'source_read_failed', message: '无法读取题面' } })
      return
    }
    if (targetsResult.targets === undefined) setSourceTargets([{ target: result.document.target, kind: 'statement', bytes: result.document.bytes }])
    setEditor({ ...result.document, originalContent: result.document.content })
  }
  const selectEditorTarget = (target: string): void => {
    if (editor !== undefined && editor.content !== editor.originalContent) {
      setEditor(current => current === undefined ? current : { ...current, error: { code: 'source_unsaved', message: '请先保存或重新读取当前文件，再切换编辑目标。' } })
      return
    }
    if (!sourceTargets.some(item => item.target === target)) return
    void readEditorTarget(target)
  }
  const reloadEditor = (): void => { void readEditorTarget(editor?.target ?? 'statement') }
  const saveEditor = async (): Promise<void> => {
    if (sessionId === undefined || selected === undefined || editor === undefined || editor.loading || editor.saving) return
    const targetSession = sessionId
    const targetProblem = selected.id
    setEditor(current => current === undefined ? current : { ...current, saving: true })
    const result = await saveProbHubSource(targetSession, targetProblem, editor.target, editor.content, editor.revision)
    if (targetSession !== sessionId || targetProblem !== selected.id) return
    if (result.error !== undefined || result.document === undefined) {
      setEditor(current => current === undefined ? current : { ...current, saving: false, error: result.error ?? { code: 'source_write_failed', message: '保存题面失败' } })
      return
    }
    setEditor({ ...result.document, originalContent: result.document.content, message: '已保存。题目状态将在刷新后更新为 stale。' })
    void probHubController.refresh(sessionId)
  }
  useEffect(() => {
    if (tabRequest === undefined || tabRequest.sequence <= appliedTabRequest.current) return
    // The controller already rejects foreign identities, but retain the
    // component-side fence for remounts and stale snapshots: a location hint
    // may only move the currently rendered Session/problem.
    if (tabRequest.sessionId !== sessionId || tabRequest.problemId !== selected?.id) return
    appliedTabRequest.current = tabRequest.sequence
    setTab(displayTab(tabRequest.tab))
  }, [selected?.id, sessionId, tabRequest])
  const workspaceLabel = overview.workspaceId
    ?? (overview.workspace?.schemaVersion === 1 ? 'Schema v1 workspace' : '未返回 workspace')
  const isNotice = overview.state !== 'ready'

  return (
    <div className={css.shell} data-probhub-workbench data-layout="workbench">
      <section className={css.workbench} aria-label="ProbHub 工作台">
        <header className={css.workbenchHeader}>
          <div><span className={css.kicker}>PROBHUB WORKSPACE</span><h2>题目工作台</h2></div>
          <div className={css.headerFacts}><span>{workspaceLabel}</span><span className={css.readOnlyBadge}>只读 P1</span></div>
          <button className={css.drawerToggle} data-ai-toggle type="button" aria-expanded={copilotOpen} onClick={() => { setCopilotOpen(open => !open) }}>AI 副驾驶</button>
        </header>
        <div className={css.workbenchBody}>
          <main className={css.problemMain}>
            <div className={css.problemTitleRow}>
              <div><span className={css.kicker}>题目详情</span><h3>{selected ? (selected.title || selected.id) : (isNotice ? '等待题目列表' : '选择题目')}</h3></div>
              {selected && <span className={css.judgePill}>{selected.judge ?? 'Standard'}</span>}
            </div>
            <nav className={css.tabs} aria-label="题目视图">
              {TABS.map(item => <button key={item} type="button" aria-selected={tab === item} data-active={tab === item || undefined} onClick={() => { setTab(item) }}>{item}</button>)}
            </nav>
            {isNotice
              ? <StateNotice overview={overview} />
              : <WorkbenchBody
                problem={selected}
                report={selectedReport}
                jobs={jobs}
                tab={tab}
                editor={editor}
                sourceTargets={sourceTargets}
                onOpenEditor={() => { void openEditor() }}
                onSelectEditorTarget={selectEditorTarget}
                onChangeEditor={(content) => {
                  setEditor(current => current === undefined
                    ? current
                    : { ...clearEditorFeedback(current), content, bytes: new TextEncoder().encode(content).byteLength })
                }}
                onSaveEditor={() => { void saveEditor() }}
                onReloadEditor={reloadEditor}
              />}
          </main>
        </div>
      </section>
      <aside className={css.copilot} data-ai-panel data-open={copilotOpen || undefined} aria-label="AI 副驾驶">
        <header className={css.copilotHeader}>
          <div><span className={css.kicker}>DEEPSEEK HARNESS</span><h2>AI 副驾驶</h2></div>
          <span className={css.liveDot}>只读上下文</span>
        </header>
        <div className={css.bindingCard}><span>当前 Session</span><strong>{sessionId ?? '未选择 Session'}</strong><small>{selected ? `${selected.id} · ${selected.title || selected.id}` : '尚未绑定题目'}</small></div>
        {selectedReport && <div className={css.copilotSummary} aria-label="题目验证上下文">
          <span>题目验证上下文</span>
          <strong>{selectedReport.aggregateConstraints?.state ?? '约束待检查'} · {selectedReport.judgeQa?.state ?? 'QA 未配置'}</strong>
          <small>数据组 {selectedReport.groups?.length ?? 0} · 测试点 {selectedReport.tests?.total?.cases ?? '—'} · 校准 {selectedReport.calibration?.state ?? 'missing'}</small>
          <div className={css.copilotLinks} aria-label="副驾驶定位">
            <button type="button" data-target-tab="健康与评测" onClick={() => { setTab('健康与评测') }}>查看健康</button>
            <button type="button" data-target-tab="题面" onClick={() => { setTab('题面') }}>查看题面</button>
          </div>
        </div>}
        <div className={css.conversationSlot}>
          {children ?? <div className={css.emptyConversation}>当前 Session 尚无 AI 消息。选择题目只改变上下文，不会创建或修改会话。</div>}
        </div>
      </aside>
    </div>
  )
}
