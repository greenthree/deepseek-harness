import { useSyncExternalStore } from 'react'
import type { ProbHubOverview } from './ProbHubWorkbench.tsx'
import type { ProbHubTab } from '@deepseek-ai/dsh-api-remotes/client'

const PROBHUB_TABS: readonly ProbHubTab[] = ['statement', 'health', 'pdf']

/** One validated, one-shot UI navigation hint from the Host. */
export interface ProbHubTabLocation {
  readonly tab: ProbHubTab
  readonly sessionId: string
  readonly problemId: string
  /** Monotonic identity so repeated requests for the same tab are observable. */
  readonly sequence: number
}

/** Plain projection passed from the layout owner to the sidebar slot. */
export interface ProbHubControllerState {
  readonly snapshot: ProbHubOverview
  readonly selectedId: string | undefined
  readonly sessionId: string | undefined
  readonly select: (id: string) => void
  /** Latest Host navigation hint; consuming it never writes to the workspace. */
  readonly tabRequest: ProbHubTabLocation | undefined
  /** Request local tab/problem positioning after strict current-state checks. */
  readonly requestTab: (tab: ProbHubTab, sessionId?: string, problemId?: string) => void
}

const empty: ProbHubOverview = { state: 'unavailable', problems: [] }
let snapshot: ProbHubOverview = empty
let selectedId: string | undefined
let sessionId: string | undefined
let tabRequest: ProbHubTabLocation | undefined
interface PendingTabRequest {
  readonly tab: ProbHubTab
  readonly sessionId: string
  readonly problemId: string
}
let pendingTabRequest: PendingTabRequest | undefined
let request: AbortController | undefined
let contextRequest: AbortController | undefined
let generation = 0
let selectionSequence = 0
let tabSequence = 0
const listeners = new Set<() => void>()
const emit = (): void => { for (const listener of listeners) listener() }
let state: ProbHubControllerState

function takePendingTabRequest(): PendingTabRequest | undefined {
  const pending = pendingTabRequest
  pendingTabRequest = undefined
  return pending
}

/**
 * Apply a Host navigation hint to local workbench state only. The target
 * Session must still be current and the problem must be present in the latest
 * validated overview. In particular this does not call {@link select}, whose
 * browser selection path POSTs prompt context to the Host.
 */
const requestTab = (tab: ProbHubTab, targetSession?: string, targetProblem?: string): void => {
  if (!PROBHUB_TABS.includes(tab)) return
  if (sessionId === undefined) return
  if (targetSession !== undefined && targetSession !== sessionId) return
  const problemId = targetProblem ?? selectedId
  if (problemId === undefined) return
  if (snapshot.state !== 'ready') {
    pendingTabRequest = { tab, sessionId, problemId }
    return
  }
  if (!snapshot.problems?.some(problem => problem.id === problemId)) return
  selectedId = problemId
  tabRequest = {
    tab,
    sessionId,
    problemId,
    sequence: ++tabSequence,
  }
  state = { snapshot, selectedId, sessionId, select, tabRequest, requestTab }
  emit()
}

const select = (id: string): void => {
  const sequence = ++selectionSequence
  selectedId = id
  tabRequest = undefined
  state = { snapshot, selectedId, sessionId, select, tabRequest, requestTab }
  emit()
  void publishSelection(sessionId, snapshot, id, sequence)
}

state = { snapshot, selectedId, sessionId, select, tabRequest, requestTab }

const getSnapshot = (): ProbHubControllerState => state
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const refresh = async (nextSession: string | undefined): Promise<void> => {
  request?.abort()
  request = undefined
  contextRequest?.abort()
  contextRequest = undefined
  const token = ++generation
  sessionId = nextSession
  selectedId = undefined
  tabRequest = undefined
  pendingTabRequest = undefined
  selectionSequence += 1
  snapshot = empty
  state = { snapshot, selectedId, sessionId, select, tabRequest, requestTab }
  emit()
  if (nextSession === undefined) return
  const controller = new AbortController()
  request = controller
  const response = await fetch(
    `/probhub/api/overview?sessionId=${encodeURIComponent(nextSession)}`,
    { headers: { accept: 'application/json' }, signal: controller.signal },
  ).catch(() => undefined)
  if (token !== generation || response === undefined) return
  let next: ProbHubOverview
  try {
    next = response.ok
      ? await response.json() as ProbHubOverview
      : {
        state: response.status === 404 ? 'unavailable' : response.status === 409 ? 'migration_required' : 'error',
        problems: [],
      }
  } catch {
    return
  }
  if (token !== generation) return
  snapshot = { ...next, problems: Array.isArray(next.problems) ? next.problems : [] }
  selectedId = snapshot.selectedId ?? snapshot.problems?.[0]?.id
  state = { snapshot, selectedId, sessionId, select, tabRequest, requestTab }
  emit()
  const pending = takePendingTabRequest()
  if (pending !== undefined && pending.sessionId === sessionId) {
    requestTab(pending.tab, pending.sessionId, pending.problemId)
  }
  if (selectedId !== undefined) void publishSelection(sessionId, snapshot, selectedId, selectionSequence)
}

/**
 * Bind the browser's selected problem to the current Host Agent context.
 * Navigation remains optimistic and read-only; failures are intentionally
 * ignored because the workbench can still render its local projection while
 * the next model request falls back to the normal ProbHub tools.
 */
async function publishSelection(
  currentSession: string | undefined,
  overview: ProbHubOverview,
  problemId: string,
  sequence: number,
): Promise<void> {
  if (currentSession === undefined || overview.state !== 'ready') return
  const problem = overview.problems?.find(item => item.id === problemId)
  if (problem === undefined) return
  contextRequest?.abort()
  const controller = new AbortController()
  contextRequest = controller
  const params = new URLSearchParams({ sessionId: currentSession, problemId, selection: String(sequence) })
  await fetch(`/probhub/api/context?${params.toString()}`, {
    method: 'POST',
    headers: { accept: 'application/json' },
    signal: controller.signal,
  }).catch(() => undefined)
  if (contextRequest === controller) contextRequest = undefined
}

/** Shared read-only controller projection used by the layout and sidebar seats. */
export const probHubController = { getSnapshot, subscribe, select, refresh, requestTab }
/**
 * Subscribe the current component to the active ProbHub workspace snapshot.
 * @returns the current controller projection for the active workspace.
 */
export function useProbHub(): ProbHubControllerState {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return { ...current, select, requestTab }
}
