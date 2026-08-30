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

/** One editable Schema v1 source document returned by the Host bridge. */
export interface ProbHubSourceDocument {
  readonly target: string
  readonly content: string
  readonly revision: string
  readonly bytes: number
  readonly impact: { readonly source: boolean; readonly data: boolean; readonly formalArtifacts: boolean }
}

/** Structured source edit failure; callers decide how to render it. */
export interface ProbHubSourceError {
  readonly code: string
  readonly message: string
  readonly expectedRevision?: string
  readonly currentRevision?: string
}

function parseSourceImpact(value: unknown): ProbHubSourceDocument['impact'] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const impact = value as Record<string, unknown>
  return typeof impact.source === 'boolean' && typeof impact.data === 'boolean' && typeof impact.formalArtifacts === 'boolean'
    ? { source: impact.source, data: impact.data, formalArtifacts: impact.formalArtifacts }
    : undefined
}

/** Read one allowlisted source target through the same-origin Host bridge. */
export async function readProbHubSource(
  currentSession: string,
  problemId: string,
  target = 'statement',
): Promise<{ readonly document?: ProbHubSourceDocument; readonly error?: ProbHubSourceError }> {
  const params = new URLSearchParams({ sessionId: currentSession, problemId, target })
  const response = await fetch(`/probhub/api/source?${params.toString()}`, { headers: { accept: 'application/json' } }).catch(() => undefined)
  if (response === undefined) return { error: { code: 'source_unavailable', message: '无法连接 ProbHub 源文件服务' } }
  let body: unknown
  try { body = await response.json() } catch { return { error: { code: 'source_invalid_response', message: '源文件服务返回了无效响应' } } }
  if (!response.ok || body === null || typeof body !== 'object' || Array.isArray(body)) {
    const value = body as Record<string, unknown> | null
    return {
      error: {
        code: typeof value?.code === 'string' ? value.code : 'source_read_failed',
        message: typeof value?.error === 'string' ? value.error : '无法读取源文件',
      },
    }
  }
  const value = body as Record<string, unknown>
  const source = value.source
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return { error: { code: 'source_invalid_response', message: '源文件服务缺少 source 响应' } }
  const record = source as Record<string, unknown>
  if (typeof record.target !== 'string' || typeof record.content !== 'string' || typeof record.revision !== 'string' || typeof record.bytes !== 'number') {
    return { error: { code: 'source_invalid_response', message: '源文件服务返回了不完整文档' } }
  }
  const impact = parseSourceImpact(value.impact)
  if (impact === undefined) return { error: { code: 'source_invalid_response', message: '源文件服务返回了不完整影响预览' } }
  return {
    document: {
      target: record.target,
      content: record.content,
      revision: record.revision,
      bytes: record.bytes,
      impact,
    },
  }
}

/** Save one allowlisted source target using an exact Core source revision. */
export async function saveProbHubSource(
  currentSession: string,
  problemId: string,
  target: string,
  content: string,
  expectedRevision: string,
): Promise<{ readonly document?: ProbHubSourceDocument; readonly error?: ProbHubSourceError }> {
  const params = new URLSearchParams({ sessionId: currentSession, problemId })
  const response = await fetch(`/probhub/api/source?${params.toString()}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ problemId, target, content, expectedRevision }),
  }).catch(() => undefined)
  if (response === undefined) return { error: { code: 'source_unavailable', message: '无法连接 ProbHub 源文件服务' } }
  let body: unknown
  try { body = await response.json() } catch { return { error: { code: 'source_invalid_response', message: '源文件服务返回了无效响应' } } }
  if (!response.ok || body === null || typeof body !== 'object' || Array.isArray(body)) {
    const value = body as Record<string, unknown> | null
    return {
      error: {
        code: typeof value?.code === 'string' ? value.code : response.status === 409 ? 'source_conflict' : 'source_write_failed',
        message: typeof value?.error === 'string' ? value.error : '保存源文件失败',
        ...(typeof value?.expectedRevision === 'string' ? { expectedRevision: value.expectedRevision } : {}),
        ...(typeof value?.currentRevision === 'string' ? { currentRevision: value.currentRevision } : {}),
      },
    }
  }
  const value = body as Record<string, unknown>
  const source = value.source
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return { error: { code: 'source_invalid_response', message: '源文件服务缺少 source 响应' } }
  const record = source as Record<string, unknown>
  if (typeof record.target !== 'string' || typeof record.revision !== 'string' || typeof record.bytes !== 'number') {
    return { error: { code: 'source_invalid_response', message: '源文件服务返回了不完整保存结果' } }
  }
  const impact = parseSourceImpact(value.impact)
  if (impact === undefined) return { error: { code: 'source_invalid_response', message: '源文件服务返回了不完整影响预览' } }
  return {
    document: {
      target: record.target,
      content,
      revision: record.revision,
      bytes: record.bytes,
      impact,
    },
  }
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
