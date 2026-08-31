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

/** One allowlisted source target returned by the Host bridge. */
export interface ProbHubSourceTarget {
  readonly target: string
  readonly kind: 'statement' | 'config' | 'code' | 'sample-input' | 'secret-input'
  readonly name?: string
  readonly bytes: number
}

/** Structured source edit failure; callers decide how to render it. */
export interface ProbHubSourceError {
  readonly code: string
  readonly message: string
  readonly expectedRevision?: string
  readonly currentRevision?: string
}

/** Core jobs that the workbench may start explicitly; build stays excluded. */
export type ProbHubDeliveryOperation = 'judge' | 'stress' | 'judge-qa' | 'mutation' | 'checkpoint' | 'seal' | 'assemble'

/** A delivery job accepted by the Host Job bridge. */
export interface ProbHubDeliveryJob {
  readonly id: string
  readonly operation: ProbHubDeliveryOperation
  readonly problemId?: string
}

/** Bounded generation state used by the formal publication summary. */
export interface ProbHubDeliveryGeneration {
  readonly generationId?: string
  readonly state?: string
  readonly complete?: boolean
  readonly allSealed?: boolean
  readonly missing: readonly string[]
  readonly staleFields: readonly string[]
  readonly problems: readonly {
    readonly problemId: string
    readonly state?: string
    readonly revisionId?: string
    readonly sourceHash?: string
    readonly dataHash?: string
  }[]
}

/** One source/sealed revision comparison from the formal publication gate. */
export interface ProbHubDeliveryRevision {
  readonly status?: string
  readonly sealed: boolean
  readonly consistent: boolean
  readonly sourceHash?: string
  readonly dataHash?: string
  readonly sealedRevision?: string
}

/** Bounded package verification counts returned by the formal gate. */
export interface ProbHubDeliveryVerification {
  readonly ok: boolean
  readonly state?: string
  readonly code?: string
  readonly verificationScope?: string
  readonly errorCount?: number
  readonly warningCount?: number
  readonly fileCount?: number
  readonly sampleCount?: number
  readonly secretCount?: number
}

/** One canonical package check from the formal publication gate. */
export interface ProbHubDeliveryPackage extends ProbHubDeliveryVerification {
  readonly verification?: ProbHubDeliveryVerification
}

/** Minimal bounded report projection retained by the delivery summary. */
export interface ProbHubDeliveryReport {
  readonly ok: boolean
  readonly summary?: Record<string, number>
}

/** Read-only formal delivery gate projection returned by the Host. */
export interface ProbHubDeliveryGate {
  readonly ok: boolean
  readonly state: 'ready' | 'blocked' | 'error'
  readonly problemIds: readonly string[]
  readonly checks: {
    readonly revision: Record<string, ProbHubDeliveryRevision>
    readonly generation: ProbHubDeliveryGeneration
    readonly packages: Record<string, ProbHubDeliveryPackage>
  }
  readonly blockers: readonly { readonly code: string; readonly problemId?: string; readonly detail?: string }[]
  readonly report?: ProbHubDeliveryReport
}

const DELIVERY_MARKER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u

function deliveryMarker(value: unknown): string | undefined {
  return typeof value === 'string' && DELIVERY_MARKER.test(value) ? value : undefined
}

function deliveryCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : undefined
}

function parseDeliveryGeneration(value: unknown): ProbHubDeliveryGeneration | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const generationId = deliveryMarker(record.generationId ?? record.generation_id)
  const state = deliveryMarker(record.state)
  const complete = record.complete
  const allSealed = record.allSealed ?? record.all_sealed
  if (complete !== undefined && typeof complete !== 'boolean') return undefined
  if (allSealed !== undefined && typeof allSealed !== 'boolean') return undefined
  const rawMissing = record.missing
  if (rawMissing !== undefined && (!Array.isArray(rawMissing) || rawMissing.length > 256)) return undefined
  const missing = (rawMissing ?? []).flatMap((item: unknown) => {
    const id = typeof item === 'string'
      ? deliveryMarker(item)
      : item !== null && typeof item === 'object' && !Array.isArray(item)
        ? deliveryMarker((item as Record<string, unknown>).problemId ?? (item as Record<string, unknown>).problem_id)
        : undefined
    return id === undefined ? [] : [id]
  })
  if (missing.length !== (rawMissing?.length ?? 0)) return undefined
  const rawStaleFields = record.staleFields ?? record.stale_fields
  if (rawStaleFields !== undefined && (!Array.isArray(rawStaleFields) || rawStaleFields.length > 64)) return undefined
  const staleFields = (rawStaleFields ?? []).flatMap((item: unknown) => {
    const marker = deliveryMarker(item)
    return marker === undefined ? [] : [marker]
  })
  if (staleFields.length !== (rawStaleFields?.length ?? 0)) return undefined
  const rawProblems = record.problems
  if (rawProblems !== undefined && (!Array.isArray(rawProblems) || rawProblems.length > 256)) return undefined
  const problems = (rawProblems ?? []).flatMap((item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return []
    const problem = item as Record<string, unknown>
    const problemId = deliveryMarker(problem.problemId ?? problem.problem_id)
    if (problemId === undefined) return []
    const parseMarker = (value: unknown): string | undefined => value === undefined ? undefined : deliveryMarker(value)
    const state = parseMarker(problem.state)
    const revisionId = parseMarker(problem.revisionId ?? problem.revision_id)
    const sourceHash = parseMarker(problem.sourceHash ?? problem.source_hash)
    const dataHash = parseMarker(problem.dataHash ?? problem.data_hash)
    if ((problem.state !== undefined && state === undefined)
      || (problem.revisionId !== undefined && revisionId === undefined)
      || (problem.revision_id !== undefined && revisionId === undefined)
      || (problem.sourceHash !== undefined && sourceHash === undefined)
      || (problem.source_hash !== undefined && sourceHash === undefined)
      || (problem.dataHash !== undefined && dataHash === undefined)
      || (problem.data_hash !== undefined && dataHash === undefined)) return []
    return [{
      problemId,
      ...(state === undefined ? {} : { state }),
      ...(revisionId === undefined ? {} : { revisionId }),
      ...(sourceHash === undefined ? {} : { sourceHash }),
      ...(dataHash === undefined ? {} : { dataHash }),
    }]
  })
  if (problems.length !== (rawProblems?.length ?? 0)) return undefined
  return {
    ...(generationId === undefined ? {} : { generationId }),
    ...(state === undefined ? {} : { state }),
    ...(complete === undefined ? {} : { complete }),
    ...(allSealed === undefined ? {} : { allSealed }),
    missing,
    staleFields,
    problems,
  }
}

function parseDeliveryRevision(value: unknown): ProbHubDeliveryRevision | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.sealed !== 'boolean' || typeof record.consistent !== 'boolean') return undefined
  const status = record.status === undefined ? undefined : deliveryMarker(record.status)
  if (record.status !== undefined && status === undefined) return undefined
  const sourceHash = record.sourceHash === undefined ? undefined : deliveryMarker(record.sourceHash)
  const dataHash = record.dataHash === undefined ? undefined : deliveryMarker(record.dataHash)
  const sealedRevision = record.sealedRevision === undefined ? undefined : deliveryMarker(record.sealedRevision)
  if ((record.sourceHash !== undefined && sourceHash === undefined)
    || (record.dataHash !== undefined && dataHash === undefined)
    || (record.sealedRevision !== undefined && sealedRevision === undefined)) return undefined
  return {
    ...(status === undefined ? {} : { status }),
    sealed: record.sealed,
    consistent: record.consistent,
    ...(sourceHash === undefined ? {} : { sourceHash }),
    ...(dataHash === undefined ? {} : { dataHash }),
    ...(sealedRevision === undefined ? {} : { sealedRevision }),
  }
}

function parseDeliveryVerification(value: unknown): ProbHubDeliveryVerification | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.ok !== 'boolean') return undefined
  const state = record.state === undefined ? undefined : deliveryMarker(record.state)
  const code = record.code === undefined ? undefined : deliveryMarker(record.code)
  const verificationScope = record.verification_scope === undefined ? undefined : deliveryMarker(record.verification_scope)
  if ((record.state !== undefined && state === undefined)
    || (record.code !== undefined && code === undefined)
    || (record.verification_scope !== undefined && verificationScope === undefined)) return undefined
  const result: ProbHubDeliveryVerification = {
    ok: record.ok,
    ...(state === undefined ? {} : { state }),
    ...(code === undefined ? {} : { code }),
    ...(verificationScope === undefined ? {} : { verificationScope }),
  }
  for (const [input, output] of [
    ['errorCount', 'errorCount'],
    ['warningCount', 'warningCount'],
    ['fileCount', 'fileCount'],
    ['sampleCount', 'sampleCount'],
    ['secretCount', 'secretCount'],
  ] as const) {
    if (record[input] !== undefined) {
      const count = deliveryCount(record[input])
      if (count === undefined) return undefined
      Object.assign(result, { [output]: count })
    }
  }
  return result
}

function parseDeliveryChecks(value: unknown): ProbHubDeliveryGate['checks'] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const checks = value as Record<string, unknown>
  const generation = parseDeliveryGeneration(checks.generation)
  if (generation === undefined) return undefined
  const revisionRaw = checks.revision
  const packageRaw = checks.packages
  if (revisionRaw === null || typeof revisionRaw !== 'object' || Array.isArray(revisionRaw) || packageRaw === null || typeof packageRaw !== 'object' || Array.isArray(packageRaw)) return undefined
  const revision: Record<string, ProbHubDeliveryRevision> = {}
  for (const [id, raw] of Object.entries(revisionRaw).slice(0, 256)) {
    if (!DELIVERY_MARKER.test(id)) return undefined
    const parsed = parseDeliveryRevision(raw)
    if (parsed === undefined) return undefined
    revision[id] = parsed
  }
  if (Object.keys(revisionRaw).length > 256) return undefined
  const packages: Record<string, ProbHubDeliveryPackage> = {}
  for (const [id, raw] of Object.entries(packageRaw).slice(0, 256)) {
    if (!DELIVERY_MARKER.test(id) || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const record = raw as Record<string, unknown>
    const base = parseDeliveryVerification(record)
    if (base === undefined) return undefined
    const verification = record.verification === undefined ? undefined : parseDeliveryVerification(record.verification)
    if (record.verification !== undefined && verification === undefined) return undefined
    packages[id] = { ...base, ...(verification === undefined ? {} : { verification }) }
  }
  if (Object.keys(packageRaw).length > 256) return undefined
  return { revision, generation, packages }
}

function parseDeliveryReport(value: unknown): ProbHubDeliveryReport | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.ok !== 'boolean') return undefined
  const rawSummary = record.summary
  if (rawSummary === undefined) return { ok: record.ok }
  if (rawSummary === null || typeof rawSummary !== 'object' || Array.isArray(rawSummary)) return undefined
  const entries = Object.entries(rawSummary)
  if (entries.length > 64) return undefined
  const summary: Record<string, number> = {}
  for (const [key, raw] of entries) {
    if (!DELIVERY_MARKER.test(key)) return undefined
    const count = deliveryCount(raw)
    if (count === undefined) return undefined
    summary[key] = count
  }
  return { ok: record.ok, summary }
}

function parseSourceImpact(value: unknown): ProbHubSourceDocument['impact'] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const impact = value as Record<string, unknown>
  return typeof impact.source === 'boolean' && typeof impact.data === 'boolean' && typeof impact.formalArtifacts === 'boolean'
    ? { source: impact.source, data: impact.data, formalArtifacts: impact.formalArtifacts }
    : undefined
}

function parseSourceTarget(value: unknown): ProbHubSourceTarget | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.target !== 'string' || typeof record.kind !== 'string' || typeof record.bytes !== 'number' || !Number.isSafeInteger(record.bytes) || record.bytes < 0) return undefined
  const kind = record.kind
  if (kind !== 'statement' && kind !== 'config' && kind !== 'code' && kind !== 'sample-input' && kind !== 'secret-input') return undefined
  const name = record.name
  if (kind === 'statement' || kind === 'config') {
    if (name !== undefined || record.target !== kind) return undefined
    return { target: kind, kind, bytes: record.bytes }
  }
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || name.toLowerCase().endsWith('.ans') || record.target !== `${kind}:${name}`) return undefined
  return { target: record.target, kind, name, bytes: record.bytes }
}

/** List the Host-approved source files for one problem.
 * @param currentSession - Current Harness Session id.
 * @param problemId - Schema v1 problem id.
 * @returns Allowlisted source targets or a bounded error.
 */
export async function listProbHubSourceTargets(
  currentSession: string,
  problemId: string,
): Promise<{ readonly targets?: readonly ProbHubSourceTarget[]; readonly error?: ProbHubSourceError }> {
  const params = new URLSearchParams({ sessionId: currentSession, problemId })
  const response = await fetch(`/probhub/api/source-targets?${params.toString()}`, { headers: { accept: 'application/json' } }).catch(() => undefined)
  if (response === undefined) return { error: { code: 'source_unavailable', message: '无法连接 ProbHub 源文件服务' } }
  let body: unknown
  try { body = await response.json() } catch { return { error: { code: 'source_invalid_response', message: '源文件服务返回了无效响应' } } }
  if (!response.ok || body === null || typeof body !== 'object' || Array.isArray(body)) {
    const value = body as Record<string, unknown> | null
    return { error: { code: typeof value?.code === 'string' ? value.code : 'source_targets_failed', message: typeof value?.error === 'string' ? value.error : '无法读取源文件列表' } }
  }
  const rawTargets = (body as Record<string, unknown>).targets
  if (!Array.isArray(rawTargets) || rawTargets.length > 512) return { error: { code: 'source_invalid_response', message: '源文件服务返回了无效目标列表' } }
  const targets = rawTargets.flatMap((item) => {
    const target = parseSourceTarget(item)
    return target === undefined ? [] : [target]
  })
  if (targets.length !== rawTargets.length) return { error: { code: 'source_invalid_response', message: '源文件服务返回了不完整目标列表' } }
  return { targets }
}

/** Read one allowlisted source target through the same-origin Host bridge.
 * @param currentSession - Current Harness Session id.
 * @param problemId - Schema v1 problem id.
 * @param target - Allowlisted source target, defaulting to the statement.
 * @returns The source document or a bounded error.
 */
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

/** Save one allowlisted source target using an exact Core source revision.
 * @param currentSession - Current Harness Session id.
 * @param problemId - Schema v1 problem id.
 * @param target - Allowlisted source target.
 * @param content - UTF-8 source content to save.
 * @param expectedRevision - Revision read before editing.
 * @returns The saved source document or a conflict/error.
 */
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

/** Start one non-publishing delivery job through the current Host Session.
 * @param currentSession - Current Harness Session id.
 * @param operation - Allowlisted Core operation.
 * @param problemId - Problem id for a problem-scoped operation.
 * @param noCache - Whether Core should bypass its caches.
 * @param rounds - Optional bounded stress round count.
 * @param seed - Optional deterministic stress seed.
 * @returns The accepted Job identity or a bounded error.
 */
export async function startProbHubDeliveryJob(
  currentSession: string,
  operation: ProbHubDeliveryOperation,
  problemId?: string,
  noCache = false,
  rounds?: number,
  seed?: number,
): Promise<{ readonly job?: ProbHubDeliveryJob; readonly error?: ProbHubSourceError }> {
  const params = new URLSearchParams({ sessionId: currentSession })
  if (operation !== 'assemble' && problemId !== undefined) params.set('problemId', problemId)
  const response = await fetch(`/probhub/api/jobs?${params.toString()}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ operation, noCache, ...(rounds === undefined ? {} : { rounds }), ...(seed === undefined ? {} : { seed }) }),
  }).catch(() => undefined)
  if (response === undefined) return { error: { code: 'job_unavailable', message: '无法连接 ProbHub 任务服务' } }
  let body: unknown
  try { body = await response.json() } catch { return { error: { code: 'job_invalid_response', message: '任务服务返回了无效响应' } } }
  if (!response.ok || body === null || typeof body !== 'object' || Array.isArray(body)) {
    const value = body as Record<string, unknown> | null
    return { error: { code: typeof value?.code === 'string' ? value.code : 'job_start_failed', message: typeof value?.error === 'string' ? value.error : '无法启动 ProbHub 任务' } }
  }
  const value = body as Record<string, unknown>
  const job = value.job
  if (job === null || typeof job !== 'object' || Array.isArray(job)) return { error: { code: 'job_invalid_response', message: '任务服务缺少 job 响应' } }
  const record = job as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id.length === 0 || record.operation !== operation || (record.problemId !== undefined && typeof record.problemId !== 'string')) {
    return { error: { code: 'job_invalid_response', message: '任务服务返回了不完整 job 响应' } }
  }
  return { job: { id: record.id, operation, ...(record.problemId === undefined ? {} : { problemId: record.problemId }) } }
}

/** Read the formal publication prerequisites for one or more current problems.
 * @param currentSession - Current Harness Session id.
 * @param problemIds - Distinct problem ids to check.
 * @returns The bounded delivery gate or a response error.
 */
export async function checkProbHubDelivery(
  currentSession: string,
  problemIds: readonly string[],
): Promise<{ readonly delivery?: ProbHubDeliveryGate; readonly error?: ProbHubSourceError }> {
  if (problemIds.length === 0 || problemIds.length > 256 || problemIds.some(id => id.length === 0)) {
    return { error: { code: 'problem_invalid', message: '请选择至少一道有效题目' } }
  }
  const params = new URLSearchParams({ sessionId: currentSession, problemIds: problemIds.join(',') })
  const response = await fetch(`/probhub/api/delivery-check?${params.toString()}`, { headers: { accept: 'application/json' } }).catch(() => undefined)
  if (response === undefined) return { error: { code: 'delivery_unavailable', message: '无法连接 ProbHub 交付门禁' } }
  let body: unknown
  try { body = await response.json() } catch { return { error: { code: 'delivery_invalid_response', message: '交付门禁返回了无效响应' } } }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { error: { code: 'delivery_invalid_response', message: '交付门禁返回了无效结果' } }
  const value = body as Record<string, unknown>
  const delivery = value.delivery
  if (delivery === null || typeof delivery !== 'object' || Array.isArray(delivery)) {
    return { error: { code: typeof value.code === 'string' ? value.code : 'delivery_invalid_response', message: typeof value.error === 'string' ? value.error : '交付门禁缺少结果' } }
  }
  const gate = delivery as Record<string, unknown>
  if (typeof gate.ok !== 'boolean' || (gate.state !== 'ready' && gate.state !== 'blocked' && gate.state !== 'error')) {
    return { error: { code: 'delivery_invalid_response', message: '交付门禁返回了不完整结果' } }
  }
  const blockers = gate.blockers
  if (!Array.isArray(blockers) || blockers.length > 256) return { error: { code: 'delivery_invalid_response', message: '交付门禁缺少阻断原因' } }
  const parsedBlockers = blockers.flatMap((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    if (typeof record.code !== 'string') return []
    return [{
      code: record.code,
      ...(typeof record.problemId === 'string' ? { problemId: record.problemId } : {}),
      ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
    }]
  })
  if (parsedBlockers.length !== blockers.length) return { error: { code: 'delivery_invalid_response', message: '交付门禁包含无效阻断原因' } }
  const checks = gate.checks
  if (checks === null || typeof checks !== 'object' || Array.isArray(checks)) return { error: { code: 'delivery_invalid_response', message: '交付门禁缺少检查结果' } }
  const rawIds = gate.problemIds
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 256 || rawIds.some(id => typeof id !== 'string' || !DELIVERY_MARKER.test(id)) || new Set(rawIds).size !== rawIds.length) {
    return { error: { code: 'delivery_invalid_response', message: '交付门禁返回了无效题目列表' } }
  }
  const parsedChecks = parseDeliveryChecks(checks)
  if (parsedChecks === undefined) return { error: { code: 'delivery_invalid_response', message: '交付门禁返回了无效检查详情' } }
  const report = parseDeliveryReport(gate.report)
  if (report === undefined && gate.report !== undefined) return { error: { code: 'delivery_invalid_response', message: '交付门禁返回了无效 report' } }
  const parsed: ProbHubDeliveryGate = {
    ok: gate.ok,
    state: gate.state,
    problemIds: rawIds,
    checks: parsedChecks,
    blockers: parsedBlockers,
    ...(report === undefined ? {} : { report }),
  }
  return { delivery: parsed }
}

/** Cancel one current-Session ProbHub Job through the Host bridge.
 * @param currentSession - Current Harness Session id.
 * @param jobId - Job id returned by the Host.
 * @returns Whether cancellation was requested or a bounded error.
 */
export async function cancelProbHubJob(
  currentSession: string,
  jobId: string,
): Promise<{ readonly cancelled?: boolean; readonly error?: ProbHubSourceError }> {
  const params = new URLSearchParams({ sessionId: currentSession, jobId })
  const response = await fetch(`/probhub/api/jobs/cancel?${params.toString()}`, {
    method: 'POST',
    headers: { accept: 'application/json' },
  }).catch(() => undefined)
  if (response === undefined) return { error: { code: 'job_unavailable', message: '无法连接 ProbHub 任务服务' } }
  let body: unknown
  try { body = await response.json() } catch { return { error: { code: 'job_invalid_response', message: '任务服务返回了无效响应' } } }
  if (!response.ok || body === null || typeof body !== 'object' || Array.isArray(body)) {
    const value = body as Record<string, unknown> | null
    return { error: { code: typeof value?.code === 'string' ? value.code : 'job_cancel_failed', message: typeof value?.error === 'string' ? value.error : '无法取消 ProbHub 任务' } }
  }
  const value = body as Record<string, unknown>
  if (typeof value.cancelled !== 'boolean') return { error: { code: 'job_invalid_response', message: '任务服务返回了不完整取消结果' } }
  return { cancelled: value.cancelled }
}

/** Check whether the current Session has a valid isolated preview PDF.
 * @param currentSession - Current Harness Session id.
 * @param problemId - Schema v1 problem id.
 * @returns Whether the isolated preview route is currently available.
 */
export async function checkProbHubPreview(currentSession: string, problemId: string): Promise<boolean> {
  const params = new URLSearchParams({ sessionId: currentSession })
  const response = await fetch(`/probhub/api/problems/${encodeURIComponent(problemId)}/preview?${params.toString()}`, {
    method: 'HEAD',
    headers: { accept: 'application/pdf' },
  }).catch(() => undefined)
  return response?.ok === true && (response.headers.get('content-type') ?? '').toLowerCase().startsWith('application/pdf')
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
