import { useSyncExternalStore } from 'react'
import type { ProbHubOverview } from './ProbHubWorkbench.tsx'

/** Plain projection passed from the layout owner to the sidebar slot. */
export interface ProbHubControllerState {
  readonly snapshot: ProbHubOverview
  readonly selectedId: string | undefined
  readonly sessionId: string | undefined
  readonly select: (id: string) => void
}

const empty: ProbHubOverview = { state: 'unavailable', problems: [] }
let snapshot: ProbHubOverview = empty
let selectedId: string | undefined
let sessionId: string | undefined
let request: AbortController | undefined
let generation = 0
const listeners = new Set<() => void>()
const emit = (): void => { for (const listener of listeners) listener() }
let state: ProbHubControllerState

const select = (id: string): void => {
  selectedId = id
  state = { snapshot, selectedId, sessionId, select }
  emit()
}

state = { snapshot, selectedId, sessionId, select }

const getSnapshot = (): ProbHubControllerState => state
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const refresh = async (nextSession: string | undefined): Promise<void> => {
  request?.abort()
  request = undefined
  const token = ++generation
  sessionId = nextSession
  selectedId = undefined
  snapshot = empty
  state = { snapshot, selectedId, sessionId, select }
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
      : { state: response.status === 409 ? 'migration_required' : 'error', problems: [] }
  } catch {
    return
  }
  if (token !== generation) return
  snapshot = { ...next, problems: Array.isArray(next.problems) ? next.problems : [] }
  selectedId = snapshot.selectedId ?? snapshot.problems?.[0]?.id
  state = { snapshot, selectedId, sessionId, select }
  emit()
}

export const probHubController = { getSnapshot, subscribe, select, refresh }
export function useProbHub() {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return { ...current, select }
}
