import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import css from './ProbHubWorkbench.module.css'
import { useProbHub } from './probhub-controller.ts'

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
const TABS = ['题面', '健康与评测', '试卷 PDF'] as const
type Tab = (typeof TABS)[number]

function statusLabel(status: string | undefined): string {
  if (status === 'current') return 'current'
  if (status === 'stale') return 'stale'
  if (status === 'blocked') return 'blocked'
  if (status === 'warn') return 'warn'
  return status ?? 'unavailable'
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

function WorkbenchBody({ problem, report, tab }: {
  problem: ProbHubProblem | undefined
  report: ProbHubProblemReport | undefined
  tab: Tab
}) {
  if (problem === undefined) {
    return <StateNotice overview={EMPTY_OVERVIEW} />
  }
  if (tab === '题面') {
    return (
      <div className={css.previewStack}>
        <div className={css.previewCard}>
          <div className={css.previewEyebrow}>题面预览 · 只读</div>
          <h3>{problem.title || problem.id}</h3>
          <p>题面内容来自当前 Session 的规范工作区；工作台只展示经过 Core 校验的摘要，不写入题目规范源。</p>
          <div className={css.skeletonLine} /><div className={css.skeletonLine} /><div className={css.skeletonLineShort} />
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
    if (problem.status === undefined && report === undefined) return <StateNotice overview={EMPTY_OVERVIEW} />
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
export function ProbHubWorkbench({ sessionId, children }: { sessionId?: string | undefined; children?: ReactNode }) {
  const { snapshot: overview, selectedId } = useProbHub()
  const [tab, setTab] = useState<Tab>('题面')
  const [copilotOpen, setCopilotOpen] = useState(false)

  const problems = overview.problems ?? []
  const selected = useMemo(() => problems.find(problem => problem.id === selectedId) ?? problems[0], [problems, selectedId])
  const selectedReport = useMemo(
    () => overview.report?.problems?.find(report => report.id === selected?.id),
    [overview.report, selected?.id],
  )
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
            {isNotice ? <StateNotice overview={overview} /> : <WorkbenchBody problem={selected} report={selectedReport} tab={tab} />}
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
        </div>}
        <div className={css.conversationSlot}>
          {children ?? <div className={css.emptyConversation}>当前 Session 尚无 AI 消息。选择题目只改变上下文，不会创建或修改会话。</div>}
        </div>
      </aside>
    </div>
  )
}
