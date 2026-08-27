import type { SidebarProbHubOwnerProps } from './contract/slots.ts'
import css from './SidebarRoot.module.css'

/** Compact read-only problem list shown beneath the Session browser. */
export function ProbHubSection({ wide, probHub }: SidebarProbHubOwnerProps) {
  const overview = probHub?.snapshot ?? { state: 'unavailable' as const, problems: [] }
  const select = probHub?.select ?? (() => {})
  if (!wide) return null
  if (overview.state !== 'ready') return <div className={css.probHubNotice}>{overview.state === 'migration_required' ? 'ProbHub 需要迁移' : 'ProbHub 未连接'}</div>
  return (
    <div className={css.probHubSection} aria-label="ProbHub 题目">
      <div className={css.probHubHeading}><strong>ProbHub 题目</strong><span>{overview.problems?.length ?? 0}</span></div>
      {(overview.problems ?? []).map(problem => (
        <button className={css.probHubItem} type="button" key={problem.id} onClick={() => { select(problem.id) }}>
          <span className={css.probHubId}>{problem.id}</span>
          <span className={css.probHubTitle}>{problem.title || problem.id}</span>
          <span className={css.probHubStatus} data-status={problem.status ?? 'pending'} />
        </button>
      ))}
    </div>
  )
}
