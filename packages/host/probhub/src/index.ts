/** Read-only HTTP bridge from a Harness session to ProbHub Core. */

import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative as relativePath } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SessionId, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionId as makeSessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import z from '@deepseek-ai/schemastery'
import type { JobHooks, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ProbHubTab, ProbHubTabRequestReason } from '@deepseek-ai/dsh-api-remotes/types'
import type {} from '@deepseek-ai/dsh-api-remotes'
import {
  isSourceRevision,
  listSourceTargets,
  parseSourceTarget,
  readSource,
  resolveSourcePath,
  sourceImpact,
  sourceTargetId,
  writeSource,
} from './source-edit.ts'
import type { SourceTarget } from './source-edit.ts'

/** Core command configuration for the bridge. */
export interface Config {
  /** Node script path for the installed ProbHub Core CLI. */
  command?: string
  /** Maximum Core stdout/stderr bytes retained per request. */
  maxOutputBytes?: number
  /** Maximum time spent waiting for a read-only Core operation. */
  timeoutMs?: number
  /** Maximum UTF-8 bytes exposed by one workbench source read/write. */
  maxSourceBytes?: number
  /** Maximum bytes returned by one isolated preview PDF response. */
  maxPreviewBytes?: number
}

export const Config: z<Config> = z.object({
  command: z.string().default('probhub/bin/probhub.js'),
  maxOutputBytes: z.natural().min(1024).default(1024 * 1024),
  timeoutMs: z.natural().min(1).default(15_000),
  maxSourceBytes: z.natural().min(1024).max(8 * 1024 * 1024).default(512 * 1024),
  maxPreviewBytes: z.natural().min(1024).max(64 * 1024 * 1024).default(16 * 1024 * 1024),
})

/** Operations exposed by the background ProbHub Core producer. */
export type CoreOperation = 'judge' | 'stress' | 'judge-qa' | 'mutation' | 'checkpoint' | 'seal' | 'assemble' | 'build'

/** A validated Core operation request. Paths are always derived from Session cwd. */
export interface CoreJobRequest {
  readonly operation: CoreOperation
  readonly problemId?: string
  readonly problemIds?: readonly string[]
  readonly args?: readonly string[]
  readonly session: Session
  readonly workspace: string
}

/** Runner settings shared by the read-only bridge and background producer. */
export interface CoreRunnerConfig {
  readonly command: string
  readonly maxOutputBytes: number
}

/** Safe defaults used when the background producer is mounted directly. */
export const DEFAULT_CORE_RUNNER_CONFIG: CoreRunnerConfig = {
  command: 'probhub/bin/probhub.js',
  maxOutputBytes: 1024 * 1024,
}

/** Public bridge namespace used by the WebUI. */
export const PROBHUB_PATH = '/probhub'
/** JSON API namespace; intentionally separate from Harness `/api`. */
export const PROBHUB_API_PATH = `${PROBHUB_PATH}/api`

type State = 'ready' | 'migration_required' | 'error'
interface ProblemSummary {
  readonly id: string
  readonly status?: string
  readonly lintOk?: boolean
  readonly revision?: string
  readonly generation?: string
}
interface WorkspaceView {
  readonly workspaceId: string
  readonly schemaVersion: 1
}
/** Canonical Schema v1 workspace exposed to Host helpers. */
export interface ResolvedWorkspace extends WorkspaceView { readonly cwd: string }
interface BridgeResponse {
  readonly ok: boolean
  readonly state: State
  readonly workspace?: WorkspaceView
  readonly problems?: readonly ProblemSummary[]
  readonly status?: unknown
  readonly lint?: unknown
  readonly report?: unknown
  readonly problem?: { readonly id: string; readonly revision?: string; readonly generation?: string }
  readonly code?: string
  readonly error?: string
  readonly source?: { readonly target: string; readonly content?: string; readonly revision?: string; readonly bytes?: number }
  readonly targets?: readonly { readonly target: string; readonly kind: string; readonly name?: string; readonly bytes: number }[]
  readonly impact?: { readonly source: boolean; readonly data: boolean; readonly formalArtifacts: boolean }
  readonly expectedRevision?: string
  readonly currentRevision?: string
  readonly job?: { readonly id: string; readonly operation: CoreOperation; readonly problemId?: string }
  readonly cancelled?: boolean
  readonly delivery?: DeliveryGate
}

/** Bounded read-only result used by the UI and formal-build tool gate. */
export interface DeliveryGate {
  readonly ok: boolean
  readonly state: 'ready' | 'blocked' | 'error'
  readonly problemIds: readonly string[]
  readonly checks: {
    readonly revision: Record<string, unknown>
    readonly generation: Record<string, unknown>
    readonly packages: Record<string, Record<string, unknown>>
  }
  readonly blockers: readonly { readonly code: string; readonly problemId?: string; readonly detail?: string }[]
  readonly report?: Record<string, unknown>
}

interface DeliveryGateProblemRecord {
  readonly source_hash?: string
  readonly data_hash?: string
  readonly state?: string
  readonly stale_fields?: unknown
  readonly manifest?: Record<string, unknown>
}

/** Validated Session identity and optional live Session object. */
export interface SessionRef {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly session?: Session
}

interface ProblemSelection {
  readonly sequence: number
  readonly dispose: () => void
}

const PROBLEM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

function readProblemId(url: URL, res: ServerResponse): string | undefined {
  const problemId = url.searchParams.get('problemId')
  if (problemId !== null && PROBLEM_ID.test(problemId)) return problemId
  json(res, 400, { ok: false, state: 'error', code: 'problem_invalid', error: 'a valid Schema v1 problem id is required' })
  return undefined
}

function isProbHubTab(value: unknown): value is ProbHubTab {
  return value === 'statement' || value === 'health' || value === 'pdf'
}

function isProbHubTabRequestReason(value: unknown): value is ProbHubTabRequestReason {
  return value === 'ai-suggestion' || value === 'tool-result'
}

/**
 * Publish one bounded, UI-only workbench navigation hint for a live Agent.
 *
 * This is deliberately not a Remote method: the existing `host/remote-event`
 * carrier forwards the one-way Cordis event to `ctx.remote.$on` consumers. The
 * exact Agent identity is checked against the registry before emission, so a
 * late tool result from a disposed/replaced session cannot steer another
 * browser Session. No Core command or workspace write is performed here.
 *
 * @returns `true` when the event was emitted, `false` when identity or payload
 * validation failed.
 * @param ctx - Harness context used to emit the typed navigation event.
 * @param agent - Live Agent that owns the browser Session.
 * @param problemId - Validated Schema v1 problem id.
 * @param tab - Workbench tab to focus.
 * @param reason - Source category for the navigation hint.
 * @param source - Optional bounded tool name that caused the hint.
 */
export function emitProbHubTabRequest(
  ctx: Context,
  agent: Agent | undefined,
  problemId: string,
  tab: ProbHubTab,
  reason: ProbHubTabRequestReason,
  source?: string,
): boolean {
  const rawProblemId: unknown = problemId
  const rawTab: unknown = tab
  const rawReason: unknown = reason
  const rawSource: unknown = source
  if (agent === undefined || typeof rawProblemId !== 'string' || !PROBLEM_ID.test(rawProblemId)) return false
  if (!isProbHubTab(rawTab) || !isProbHubTabRequestReason(rawReason)) return false
  const current = ctx.get('agents')?.get(agent.id)
  if (current !== agent || agent.session.id !== agent.id) return false
  if (rawSource !== undefined && (typeof rawSource !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(rawSource))) return false
  try {
    if (rawSource === undefined) ctx.emit('probhub/tab-requested', agent.id, rawProblemId, rawTab, rawReason)
    else ctx.emit('probhub/tab-requested', agent.id, rawProblemId, rawTab, rawReason, rawSource)
    return true
  } catch {
    // Navigation is advisory. A faulty UI listener must never turn a
    // successfully started/completed Core tool into a failed tool result.
    return false
  }
}

/** Registers the `/probhub` projection and revision-guarded source route family. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved: Config = {
    command: config.command ?? 'probhub/bin/probhub.js',
    maxOutputBytes: config.maxOutputBytes ?? 1024 * 1024,
    timeoutMs: config.timeoutMs ?? 15_000,
    maxSourceBytes: config.maxSourceBytes ?? 512 * 1024,
    maxPreviewBytes: config.maxPreviewBytes ?? 16 * 1024 * 1024,
  }
  const selections = new Map<string, ProblemSelection>()
  const latestSelections = new Map<string, number>()
  const sourceLocks = new Map<string, Promise<void>>()
  const route: WebRoute = {
    kind: 'prefix',
    path: PROBHUB_PATH,
    handler: async (req, res) => handleRequest(ctx, resolved, req, res, selections, latestSelections, sourceLocks),
  }
  ctx.effect(() => {
    const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
      selections.get(agent.id)?.dispose()
      selections.delete(agent.id)
    })
    const disposeRoute = ctx.webServer.register(route)
    return () => {
      offDisposed()
      for (const selection of selections.values()) selection.dispose()
      selections.clear()
      latestSelections.clear()
      sourceLocks.clear()
      disposeRoute()
    }
  }, 'probhub: read-only routes')
}

/** Stable plugin name for profile composition. */
export const name = 'host-probhub'
/** This plugin only needs the HTTP carrier; optional services are checked per request. */
export const inject = ['webServer']

async function handleRequest(
  ctx: Context,
  config: Config,
  req: IncomingMessage,
  res: ServerResponse,
  selections: Map<string, ProblemSelection>,
  latestSelections: Map<string, number>,
  sourceLocks: Map<string, Promise<void>>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const isContextRoute = url.pathname === `${PROBHUB_API_PATH}/context`
  const isSourceRoute = url.pathname === `${PROBHUB_API_PATH}/source`
  const isSourceTargetsRoute = url.pathname === `${PROBHUB_API_PATH}/source-targets`
  const isDeliveryCheckRoute = url.pathname === `${PROBHUB_API_PATH}/delivery-check`
  const isJobRoute = url.pathname === `${PROBHUB_API_PATH}/jobs`
  const isJobCancelRoute = url.pathname === `${PROBHUB_API_PATH}/jobs/cancel`
  const allowed = isContextRoute || (isSourceRoute && req.method === 'POST') || (isJobRoute && req.method === 'POST') || (isJobCancelRoute && req.method === 'POST')
    ? req.method === 'POST'
    : req.method === 'GET' || req.method === 'HEAD'
  if (!allowed) {
    json(res, 405, { ok: false, state: 'error', code: 'method_not_allowed', error: isContextRoute || isSourceRoute ? 'POST is required' : 'GET is required' })
    return
  }
  if (url.pathname === PROBHUB_PATH || url.pathname === `${PROBHUB_PATH}/`) {
    json(res, 200, { ok: true, state: 'ready' })
    return
  }
  if (url.pathname === `${PROBHUB_API_PATH}/health`) {
    const subprocess: SubprocessRuntime | undefined = ctx.get('subprocess')
    const sandbox: SandboxProvider | undefined = ctx.get('sandbox')
    const sandboxPolicy: SandboxPolicyService | undefined = ctx.get('sandboxPolicy')
    const available = subprocess !== undefined && sandbox !== undefined && sandboxPolicy !== undefined
    json(res, 200, {
      ok: available,
      state: available ? 'ready' : 'error',
      ...(available ? {} : { code: subprocess === undefined ? 'core_bridge_unavailable' : 'sandbox_unavailable', error: 'read-only Core bridge is unavailable' }),
    })
    return
  }
  if (!url.pathname.startsWith(`${PROBHUB_API_PATH}/`)) {
    json(res, 404, { ok: false, state: 'error', code: 'not_found', error: 'unknown ProbHub route' })
    return
  }
  const rawSessionId = url.searchParams.get('sessionId')
  const sessionId = rawSessionId === null ? undefined : rawSessionId
  const session = sessionId === undefined ? undefined : await resolveSession(ctx, sessionId)
  if (session === undefined) {
    json(res, 400, { ok: false, state: 'error', code: 'session_missing', error: 'a validated current Harness session is required' })
    return
  }
  const workspace = await resolveWorkspace(session.header.cwd)
  if (workspace.kind === 'missing') {
    json(res, 409, {
      ok: false, state: 'migration_required',
      code: 'migration_required', error: 'Workspace Schema v1 is required; migrate this old workspace first',
    })
    return
  }
  if (workspace.kind === 'invalid') {
    json(res, 400, { ok: false, state: 'error', code: workspace.code, error: workspace.error })
    return
  }
  if (isContextRoute) {
    await bindProblemSelection(ctx, config, res, workspace.value, session, selections, latestSelections, url)
    return
  }
  if (isSourceRoute) {
    await handleSourceRequest(ctx, config, req, res, workspace.value, session, url, sourceLocks)
    return
  }
  if (isSourceTargetsRoute) {
    await handleSourceTargetsRequest(config, res, workspace.value, url)
    return
  }
  if (isDeliveryCheckRoute) {
    await handleDeliveryCheckRequest(ctx, config, res, workspace.value, session, url)
    return
  }
  const previewMatch = /^problems\/([^/]+)\/preview$/.exec(url.pathname.slice(`${PROBHUB_API_PATH}/`.length))
  if (previewMatch !== null) {
    const problemId = previewMatch[1]
    if (problemId === undefined || !PROBLEM_ID.test(problemId)) {
      json(res, 400, { ok: false, state: 'error', code: 'problem_invalid', error: 'a valid Schema v1 problem id is required' })
      return
    }
    await handlePreviewRequest(ctx, config, res, workspace.value, session, problemId)
    return
  }
  if (isJobRoute) {
    await handleDeliveryJobRequest(ctx, config, res, workspace.value, session, req, url)
    return
  }
  if (isJobCancelRoute) {
    handleJobCancelRequest(ctx, res, session, url)
    return
  }
  const operation = url.pathname.slice(`${PROBHUB_API_PATH}/`.length)
  if (operation !== 'overview' && operation !== 'status' && operation !== 'lint') {
    const problemMatch = /^problems\/([^/]+)\/(status|lint|report)$/.exec(operation)
    const problemId = problemMatch?.[1]
    const problemOperation = problemMatch?.[2]
    if (problemId === undefined || problemOperation === undefined || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(problemId)) {
      json(res, 404, { ok: false, state: 'error', code: 'not_found', error: 'unknown ProbHub route' })
      return
    }
    await runProblemOperation(ctx, config, res, workspace.value, problemOperation as 'status' | 'lint' | 'report', problemId, session.session)
    return
  }
  const [status, lint, report] = await Promise.all([
    operation === 'lint' ? Promise.resolve(undefined) : runCore(ctx, config, workspace.value.cwd, 'status', [], session.session),
    operation === 'status' ? Promise.resolve(undefined) : runCore(ctx, config, workspace.value.cwd, 'lint', [], session.session),
    operation === 'overview' ? runCore(ctx, config, workspace.value.cwd, 'report', [], session.session) : Promise.resolve(undefined),
  ])
  const migration = migrationCode(status?.value) ?? migrationCode(lint?.value) ?? migrationCode(report?.value)
  // Report is an enrichment for the workbench. A slow or unavailable report
  // must not hide the basic status/lint overview; its own adapter/core result
  // remains visible through the bounded report projection when available.
  const adapterOk = (status?.adapterOk ?? true) && (lint?.adapterOk ?? true)
  const coreOk = (status?.coreOk ?? true) && (lint?.coreOk ?? true)
  const body: BridgeResponse = {
    ok: adapterOk && coreOk,
    state: adapterOk ? (migration === undefined ? 'ready' : 'migration_required') : 'error',
    workspace: publicWorkspace(workspace.value),
    ...(status === undefined ? {} : { status: projectCore(status.value) }),
    ...(lint === undefined ? {} : { lint: projectCore(lint.value) }),
    ...(report === undefined ? {} : {
      report: report.adapterOk ? projectReport(report.value) : { ok: false, code: report.error ?? 'core_failed' },
    }),
    ...(operation === 'overview' ? { problems: summarizeProblems(status?.value, lint?.value) } : {}),
    ...(migration === undefined ? {} : { code: migration }),
    ...(adapterOk ? {} : { code: status?.error ?? lint?.error ?? 'core_failed' }),
  }
  json(res, body.state === 'migration_required' ? 409 : adapterOk ? 200 : 502, body)
}

interface SourceWritePayload {
  readonly problemId?: unknown
  readonly target?: unknown
  readonly content?: unknown
  readonly expectedRevision?: unknown
  readonly operation?: unknown
  readonly noCache?: unknown
  readonly rounds?: unknown
  readonly seed?: unknown
}

/** Read and validate one bounded JSON source-edit request. */
async function readSourceWritePayload(req: IncomingMessage, maxBytes: number): Promise<SourceWritePayload> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk as Uint8Array)
      size += bytes.byteLength
      if (size > maxBytes + 8192) throw new Error('source request exceeds the workbench size limit')
      chunks.push(bytes)
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'source request exceeds the workbench size limit') throw error
    throw new Error('source request body could not be read')
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('source request body must be valid JSON') }
  if (!isRecord(value)) throw new Error('source request body must be an object')
  return value
}

/** Execute one source write while serializing edits within this Host process. */
async function withSourceLock<T>(locks: Map<string, Promise<void>>, key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key)
  let release!: () => void
  const slot = new Promise<void>((resolve) => { release = resolve })
  locks.set(key, slot)
  if (previous !== undefined) await previous
  try {
    return await work()
  } finally {
    release()
    if (locks.get(key) === slot) locks.delete(key)
  }
}

/** Read the Core source revision for one problem; the Core remains authoritative. */
async function currentProblemRevision(
  ctx: Context,
  config: Config,
  workspace: ResolvedWorkspace,
  session: SessionRef,
  problemId: string,
  target: SourceTarget = { kind: 'statement' },
): Promise<{ revision?: string; error?: string }> {
  const result = await runCore(ctx, config, workspace.cwd, 'status', [], session.session)
  if (!result.adapterOk) return { error: result.error ?? 'core_unavailable' }
  const identity = problemIdentity(result.value, problemId)
  const revision = target.kind === 'sample-input' || target.kind === 'secret-input'
    ? identity.dataRevision ?? identity.revision
    : identity.sourceRevision ?? identity.revision
  return revision === undefined ? { error: 'problem_not_found' } : { revision }
}

/** Return the allowlisted source target metadata for one problem. */
async function handleSourceTargetsRequest(
  config: Config,
  res: ServerResponse,
  workspace: ResolvedWorkspace,
  url: URL,
): Promise<void> {
  const problemId = readProblemId(url, res)
  if (problemId === undefined) return
  try {
    const targets = await listSourceTargets(workspace.cwd, problemId, config.maxSourceBytes ?? 512 * 1024)
    json(res, 200, { ok: true, state: 'ready', targets })
  } catch (error) {
    json(res, 400, { ok: false, state: 'error', code: 'source_targets_failed', error: error instanceof Error ? error.message : 'source targets could not be listed' })
  }
}

interface DeliveryJobPayload {
  readonly operation?: unknown
  readonly noCache?: unknown
  readonly rounds?: unknown
  readonly seed?: unknown
}

/** Start one allowlisted non-publishing delivery job for the current problem. */
async function handleDeliveryJobRequest(
  ctx: Context,
  config: Config,
  res: ServerResponse,
  workspace: ResolvedWorkspace,
  session: SessionRef,
  req: IncomingMessage,
  url: URL,
): Promise<void> {
  let payload: DeliveryJobPayload = {}
  try {
    if (req.method === 'POST') payload = await readSourceWritePayload(req, 16 * 1024)
  } catch {
    json(res, 400, { ok: false, state: 'error', code: 'job_request_invalid', error: 'delivery job request must be valid JSON' })
    return
  }
  const operation = payload.operation
  if (operation !== 'judge' && operation !== 'stress' && operation !== 'judge-qa' && operation !== 'mutation' && operation !== 'checkpoint' && operation !== 'seal' && operation !== 'assemble') {
    json(res, 400, { ok: false, state: 'error', code: 'job_operation_invalid', error: 'this workbench operation is not available' })
    return
  }
  if (payload.noCache !== undefined && typeof payload.noCache !== 'boolean') {
    json(res, 400, { ok: false, state: 'error', code: 'job_request_invalid', error: 'noCache must be a boolean' })
    return
  }
  if (payload.noCache === true && operation !== 'seal') {
    json(res, 400, { ok: false, state: 'error', code: 'job_request_invalid', error: 'noCache is only supported for seal' })
    return
  }
  if (payload.rounds !== undefined && operation !== 'stress') {
    json(res, 400, { ok: false, state: 'error', code: 'job_request_invalid', error: 'rounds is only supported for stress' })
    return
  }
  if (payload.seed !== undefined && operation !== 'stress') {
    json(res, 400, { ok: false, state: 'error', code: 'job_request_invalid', error: 'seed is only supported for stress' })
    return
  }
  if (payload.rounds !== undefined && (typeof payload.rounds !== 'number' || !Number.isSafeInteger(payload.rounds) || payload.rounds < 1 || payload.rounds > 1_000_000)) {
    json(res, 400, { ok: false, state: 'error', code: 'job_request_invalid', error: 'rounds must be an integer from 1 to 1000000' })
    return
  }
  if (payload.seed !== undefined && (typeof payload.seed !== 'number' || !Number.isSafeInteger(payload.seed) || payload.seed < 0)) {
    json(res, 400, { ok: false, state: 'error', code: 'job_request_invalid', error: 'seed must be a non-negative safe integer' })
    return
  }
  const problemId = url.searchParams.get('problemId')
  if (operation !== 'assemble' && (problemId === null || !PROBLEM_ID.test(problemId))) {
    json(res, 400, { ok: false, state: 'error', code: 'problem_invalid', error: 'a valid Schema v1 problem id is required' })
    return
  }
  if (operation === 'assemble' && problemId !== null) {
    json(res, 400, { ok: false, state: 'error', code: 'problem_invalid', error: 'assemble is workspace-scoped and does not accept a problem id' })
    return
  }
  const agent = ctx.get('agents')?.get(session.id)
  if (agent === undefined || agent.session.id !== session.id) {
    json(res, 409, { ok: false, state: 'error', code: 'live_session_required', error: 'a live Harness Session is required to start a delivery job' })
    return
  }
  const sandboxPolicy = ctx.get('sandboxPolicy')
  if (sandboxPolicy === undefined) {
    json(res, 403, { ok: false, state: 'error', code: 'workspace_write_required', error: 'workspace-write permission is required to start a delivery job' })
    return
  }
  try {
    if (sandboxPolicy.resolve({ session: agent.session }).mode !== 'workspace-write') {
      json(res, 403, { ok: false, state: 'error', code: 'workspace_write_required', error: 'workspace-write permission is required to start a delivery job' })
      return
    }
  } catch {
    json(res, 503, { ok: false, state: 'error', code: 'workspace_write_unavailable', error: 'workspace-write policy is unavailable' })
    return
  }
  const args: string[] = []
  if (operation === 'seal' && payload.noCache === true) args.push('--no-cache')
  if (operation === 'stress' && payload.rounds !== undefined) args.push('--rounds', String(payload.rounds))
  if (operation === 'stress' && payload.seed !== undefined) args.push('--seed', String(payload.seed))
  try {
    const jobId = startCoreJob(ctx, {
      command: config.command ?? 'probhub/bin/probhub.js',
      maxOutputBytes: config.maxOutputBytes ?? 1024 * 1024,
    }, {
      operation,
      session: agent.session,
      workspace: workspace.cwd,
      ...(problemId === null ? {} : { problemId }),
      ...(args.length === 0 ? {} : { args }),
    }, agent, `${operation}${problemId === null ? '' : ` ${problemId}`}`)
    json(res, 200, {
      ok: true,
      state: 'ready',
      job: { id: String(jobId), operation, ...(problemId === null ? {} : { problemId }) },
    })
  } catch {
    json(res, 503, { ok: false, state: 'error', code: 'job_start_failed', error: 'delivery job could not be started' })
  }
}

/** Cancel one caller-owned ProbHub Job through the shared registry. */
function handleJobCancelRequest(
  ctx: Context,
  res: ServerResponse,
  session: SessionRef,
  url: URL,
): void {
  const rawJobId = url.searchParams.get('jobId')
  if (rawJobId === null || !/^probhub-[1-9][0-9]*$/.test(rawJobId)) {
    json(res, 400, { ok: false, state: 'error', code: 'job_invalid', error: 'a valid ProbHub job id is required' })
    return
  }
  const agent = ctx.get('agents')?.get(session.id)
  if (agent === undefined || agent.session.id !== session.id) {
    json(res, 409, { ok: false, state: 'error', code: 'live_session_required', error: 'a live Harness Session is required to cancel a job' })
    return
  }
  const jobs = ctx.get('jobs')
  if (jobs === undefined) {
    json(res, 503, { ok: false, state: 'error', code: 'job_unavailable', error: 'ProbHub Job service is unavailable' })
    return
  }
  try {
    const result = jobs.kill(JobId(rawJobId), agent, 'workbench')
    json(res, 200, { ok: true, state: 'ready', cancelled: result === 'requested' })
  } catch {
    json(res, 404, { ok: false, state: 'error', code: 'job_not_found', error: 'ProbHub job is not visible to this Session' })
  }
}

/** Handle GET/POST for the explicit, revision-guarded source editor. */
async function handleSourceRequest(
  ctx: Context,
  config: Config,
  req: IncomingMessage,
  res: ServerResponse,
  workspace: ResolvedWorkspace,
  session: SessionRef,
  url: URL,
  sourceLocks: Map<string, Promise<void>>,
): Promise<void> {
  const problemId = readProblemId(url, res)
  if (problemId === undefined) return
  let payload: SourceWritePayload | undefined
  if (req.method === 'POST') {
    try { payload = await readSourceWritePayload(req, config.maxSourceBytes ?? 512 * 1024) } catch (error) {
      json(res, 400, { ok: false, state: 'error', code: 'source_request_invalid', error: error instanceof Error ? error.message : 'source request body is invalid' })
      return
    }
    if (payload.problemId !== undefined && payload.problemId !== problemId) {
      json(res, 409, { ok: false, state: 'error', code: 'problem_mismatch', error: 'request problem does not match the selected Session problem' })
      return
    }
  }
  const target = parseSourceTarget(payload?.target ?? url.searchParams.get('target'))
  if (target === undefined) {
    json(res, 400, { ok: false, state: 'error', code: 'source_target_invalid', error: 'a supported source target is required' })
    return
  }
  let sourcePath: string
  try { sourcePath = await resolveSourcePath(workspace.cwd, problemId, target) } catch (error) {
    json(res, 400, { ok: false, state: 'error', code: 'source_target_invalid', error: error instanceof Error ? error.message : 'source target is invalid' })
    return
  }
  const maxBytes = config.maxSourceBytes ?? 512 * 1024
  if (req.method === 'GET' || req.method === 'HEAD') {
    try {
      const file = await readSource(sourcePath, maxBytes)
      const revision = await currentProblemRevision(ctx, config, workspace, session, problemId, target)
      if (revision.error !== undefined) {
        json(res, 503, { ok: false, state: 'error', code: revision.error, error: 'Core source revision is unavailable' })
        return
      }
      json(res, 200, {
        ok: true,
        state: 'ready',
        source: {
          target: sourceTargetId(target), content: file.content, bytes: file.bytes,
          ...(revision.revision === undefined ? {} : { revision: revision.revision }),
        },
        impact: sourceImpact(target),
      })
    } catch (error) {
      json(res, 400, { ok: false, state: 'error', code: 'source_read_failed', error: error instanceof Error ? error.message : 'source target could not be read' })
    }
    return
  }

  const sandboxPolicy = ctx.get('sandboxPolicy')
  if (session.session === undefined || sandboxPolicy === undefined) {
    json(res, 403, { ok: false, state: 'error', code: 'workspace_write_required', error: 'a live workspace-write Session is required to save source' })
    return
  }
  let policy: ReturnType<SandboxPolicyService['resolve']>
  try { policy = sandboxPolicy.resolve({ session: session.session }) } catch {
    json(res, 503, { ok: false, state: 'error', code: 'workspace_write_unavailable', error: 'workspace-write policy is unavailable' })
    return
  }
  if (policy.mode !== 'workspace-write') {
    json(res, 403, { ok: false, state: 'error', code: 'workspace_write_required', error: 'switch the current Session to workspace-write before saving source' })
    return
  }
  const content = payload?.content
  const expectedRevision = payload?.expectedRevision
  if (typeof content !== 'string' || !isSourceRevision(expectedRevision)) {
    json(res, 400, { ok: false, state: 'error', code: 'source_revision_required', error: 'content and expectedRevision are required' })
    return
  }
  const lockKey = `${workspace.cwd}\u0000${problemId}`
  await withSourceLock(sourceLocks, lockKey, async () => {
    const current = await currentProblemRevision(ctx, config, workspace, session, problemId, target)
    if (current.error !== undefined || current.revision === undefined) {
      json(res, 503, { ok: false, state: 'error', code: current.error ?? 'core_unavailable', error: 'Core source revision is unavailable' })
      return
    }
    if (current.revision !== expectedRevision) {
      json(res, 409, {
        ok: false,
        state: 'error',
        code: 'source_conflict',
        error: 'source changed outside this editor; reload before saving',
        expectedRevision,
        currentRevision: current.revision,
      })
      return
    }
    try {
      const before = await readSource(sourcePath, maxBytes)
      if (before.content === content) {
        json(res, 200, { ok: true, state: 'ready', source: { target: sourceTargetId(target), bytes: before.bytes, revision: current.revision }, impact: sourceImpact(target) })
        return
      }
      await writeSource(sourcePath, content, maxBytes)
    } catch (error) {
      json(res, 400, { ok: false, state: 'error', code: 'source_write_failed', error: error instanceof Error ? error.message : 'source target could not be written' })
      return
    }
    const next = await currentProblemRevision(ctx, config, workspace, session, problemId, target)
    if (next.error !== undefined || next.revision === undefined) {
      json(res, 502, { ok: false, state: 'error', code: 'source_saved_revision_unavailable', error: 'source was saved but Core could not compute its new revision' })
      return
    }
    json(res, 200, {
      ok: true,
      state: 'ready',
      source: { target: sourceTargetId(target), bytes: Buffer.byteLength(content, 'utf8'), revision: next.revision },
      impact: sourceImpact(target),
    })
  })
}

/**
 * Bind one validated problem selection to the live Agent's scoped prompt
 * context. The browser sends navigation state only; Core report and status
 * remain authoritative for the model-visible summary.
 */
async function bindProblemSelection(
  ctx: Context,
  config: Config,
  res: ServerResponse,
  workspace: ResolvedWorkspace,
  session: SessionRef,
  selections: Map<string, ProblemSelection>,
  latestSelections: Map<string, number>,
  url: URL,
): Promise<void> {
  const problemId = readProblemId(url, res)
  if (problemId === undefined) return
  const rawSequence = url.searchParams.get('selection')
  const sequence = rawSequence === null ? undefined : Number(rawSequence)
  if (sequence === undefined || !Number.isSafeInteger(sequence) || sequence < 1) {
    json(res, 400, { ok: false, state: 'error', code: 'selection_invalid', error: 'a positive selection sequence is required' })
    return
  }
  const latest = latestSelections.get(session.id)
  if (latest !== undefined && sequence < latest) {
    json(res, 409, { ok: false, state: 'error', code: 'selection_stale', error: 'the selected problem request is older than the current selection' })
    return
  }
  const agents = ctx.get('agents')
  const agent = agents?.get(session.id)
  if (agent === undefined) {
    json(res, 409, { ok: false, state: 'error', code: 'session_not_live', error: 'the selected Session has no live Agent' })
    return
  }
  let prompt: typeof agent.ctx.systemPrompt | undefined
  try { prompt = agent.ctx.systemPrompt } catch { prompt = undefined }
  if (prompt === undefined) {
    json(res, 503, { ok: false, state: 'error', code: 'prompt_context_unavailable', error: 'Agent prompt context is unavailable' })
    return
  }
  latestSelections.set(session.id, sequence)
  const [report, status] = await Promise.all([
    runCore(ctx, config, workspace.cwd, 'report', [], session.session),
    runCore(ctx, config, workspace.cwd, 'status', [], session.session),
  ])
  if (!report.adapterOk || !status.adapterOk) {
    json(res, 502, { ok: false, state: 'error', code: report.error ?? status.error ?? 'core_failed', error: 'ProbHub report/status is unavailable' })
    return
  }
  if (latestSelections.get(session.id) !== sequence) {
    json(res, 409, { ok: false, state: 'error', code: 'selection_stale', error: 'the selected problem request is older than the current selection' })
    return
  }
  const projectedReport = projectReport(report.value)
  const problems = Array.isArray(projectedReport.problems) ? projectedReport.problems : []
  const row = problems.find((item): item is Record<string, unknown> => isRecord(item) && item.id === problemId)
  if (row === undefined) {
    json(res, 404, { ok: false, state: 'error', code: 'problem_not_found', error: 'the problem is not present in the current workspace' })
    return
  }
  const identity = problemIdentity(status.value, problemId)
  const text = renderProblemSelection(workspace, row, identity)
  selections.get(session.id)?.dispose()
  let dispose: () => void
  try {
    dispose = prompt.context({
      name: 'probhub:selected-problem',
      order: 205,
      text,
    })
  } catch {
    json(res, 503, { ok: false, state: 'error', code: 'prompt_context_unavailable', error: 'Agent prompt context is unavailable' })
    return
  }
  selections.set(session.id, { sequence, dispose })
  json(res, 200, {
    ok: true,
    state: 'ready',
    workspace: publicWorkspace(workspace),
    problem: {
      id: problemId,
      ...(identity.revision === undefined ? {} : { revision: identity.revision }),
      ...(identity.generation === undefined ? {} : { generation: identity.generation }),
    },
  })
}

function renderProblemSelection(
  workspace: ResolvedWorkspace,
  problem: Record<string, unknown>,
  identity: { revision?: string; generation?: string },
): string {
  const summary: Record<string, unknown> = {}
  for (const key of ['id', 'name', 'difficulty', 'tags', 'limits', 'tests', 'groups', 'aggregateConstraints', 'calibration', 'judgeQa', 'mutation', 'killMatrix'] as const) {
    if (problem[key] !== undefined) summary[key] = problem[key]
  }
  const reportSummary = JSON.stringify(summary).slice(0, 6_000)
  const lines = [
    'ProbHub 当前题目上下文（由工作台选择，下一次请求可用）：',
    `workspace: ${workspace.workspaceId}`,
    `problem: ${String(problem.id)}`,
    identity.revision === undefined ? 'revision: unavailable' : `revision: ${identity.revision}`,
    identity.generation === undefined ? 'generation: unavailable' : `generation: ${identity.generation}`,
    `report: ${reportSummary}`,
    '这是受限导航摘要；需要最新状态时使用 probhub_report 只读工具确认。',
  ]
  return lines.join('\n')
}

function problemIdentity(
  value: unknown,
  problemId: string,
): { revision?: string; sourceRevision?: string; dataRevision?: string; generation?: string } {
  if (!isRecord(value) || !isRecord(value.problems)) return {}
  const raw = value.problems[problemId]
  if (!isRecord(raw)) return {}
  const manifest = isRecord(raw.manifest) ? raw.manifest : undefined
  const sourceRevision = safeMarker(raw.source_hash) ?? safeMarker(manifest?.source_hash)
  const dataRevision = safeMarker(raw.data_hash) ?? safeMarker(manifest?.data_hash)
  const revision = safeMarker(raw.sealed_revision_id)
    ?? safeMarker(manifest?.sealed_revision_id)
    ?? safeMarker(raw.revision_id)
    ?? safeMarker(manifest?.revision_id)
    ?? sourceRevision
  const generation = safeMarker(raw.generation_id)
    ?? safeMarker(manifest?.generation_id)
    ?? safeMarker(raw.batch_id)
    ?? safeMarker(manifest?.batch_id)
  return {
    ...(revision === undefined ? {} : { revision }),
    ...(sourceRevision === undefined ? {} : { sourceRevision }),
    ...(dataRevision === undefined ? {} : { dataRevision }),
    ...(generation === undefined ? {} : { generation }),
  }
}

async function runProblemOperation(
  ctx: Context,
  config: Config,
  res: ServerResponse,
  workspace: ResolvedWorkspace,
  operation: 'status' | 'lint' | 'report',
  problem: string,
  session?: Session,
): Promise<void> {
  const result = await runCore(ctx, config, workspace.cwd, operation, [problem], session)
  const migration = migrationCode(result.value)
  json(res, migration === undefined ? (result.adapterOk ? 200 : 502) : 409, {
    ok: result.adapterOk && result.coreOk,
    state: result.adapterOk ? (migration === undefined ? 'ready' : 'migration_required') : 'error',
    workspace: publicWorkspace(workspace),
    [operation]: operation === 'report' ? projectReport(result.value) : projectCore(result.value),
    ...(migration === undefined ? {} : { code: migration }),
    ...(result.error === undefined ? {} : { code: result.error }),
  })
}

/** Resolve a formal package path from the canonical workspace without accepting user paths.
 * @param workspace - Canonical Schema v1 workspace directory.
 * @param problemId - Validated problem id whose package is requested.
 * @returns The canonical package path.
 */
export async function resolvePackagePath(workspace: string, problemId: string): Promise<string> {
  if (!PROBLEM_ID.test(problemId)) throw new Error('package_invalid')
  const path = join(workspace, `${problemId}.zip`)
  let info
  try { info = await lstat(path) } catch { throw new Error(`generated package is missing for ${problemId}`) }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`generated package is not a regular file for ${problemId}`)
  try {
    const [canonicalWorkspace, canonicalPath] = await Promise.all([realpath(workspace), realpath(path)])
    if (!sameFilesystemEntry(dirname(canonicalPath), canonicalWorkspace)) throw new Error('package path escapes the canonical workspace')
    if (!(await stat(canonicalPath)).isFile()) throw new Error(`generated package is not a regular file for ${problemId}`)
    return canonicalPath
  } catch (error) {
    if (error instanceof Error && (error.message === 'package path escapes the canonical workspace' || error.message.startsWith('generated package is not a regular file'))) throw error
    throw new Error(`generated package path is not inside the canonical workspace for ${problemId}`)
  }
}

function deliveryProblemRecord(value: unknown, problemId: string): DeliveryGateProblemRecord | undefined {
  if (!isRecord(value) || !isRecord(value.problems)) return undefined
  const item = value.problems[problemId]
  if (!isRecord(item)) return undefined
  return item
}

function deliveryGenerationProblem(value: unknown, problemId: string): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isRecord(value.manifest)) return undefined
  const rawProblems = value.manifest.problems
  if (!Array.isArray(rawProblems)) return undefined
  const problems: unknown[] = rawProblems
  const item = problems.find((entry: unknown) => isRecord(entry) && entry.problem_id === problemId)
  return isRecord(item) ? item : undefined
}

function deliveryMarker(value: unknown): string | undefined {
  return safeMarker(value)
}

function deliveryBlock(
  blockers: Array<{ code: string; problemId?: string; detail?: string }>,
  code: string,
  problemId?: string,
  detail?: string,
): void {
  if (blockers.length >= 256) return
  if (blockers.some(item => item.code === code && item.problemId === problemId)) return
  blockers.push({ code, ...(problemId === undefined ? {} : { problemId }), ...(detail === undefined ? {} : { detail }) })
}

function projectVerification(value: unknown, includeNested = true): Record<string, unknown> {
  if (!isRecord(value)) return { ok: false, state: 'invalid' }
  const result: Record<string, unknown> = { ok: value.ok === true, state: value.ok === true ? 'passed' : 'failed' }
  for (const key of ['code', 'status', 'verification_scope'] as const) {
    const marker = deliveryMarker(value[key])
    if (marker !== undefined) result[key] = marker
  }
  for (const key of ['errorCount', 'warningCount', 'fileCount', 'sampleCount', 'secretCount'] as const) {
    const count = value[key]
    if (typeof count === 'number' && Number.isFinite(count)) result[key] = Math.max(0, Math.min(1_000_000, Math.trunc(count)))
  }
  const verification = isRecord(value.verification) ? value.verification : undefined
  if (verification !== undefined && includeNested) {
    const nested = projectVerification(verification, false)
    result.verification = nested
    if (typeof verification.ok === 'boolean') result.ok = verification.ok
  }
  if (isRecord(value.stats)) {
    const stats: Record<string, number> = {}
    for (const [key, raw] of Object.entries(value.stats).slice(0, 64)) {
      if (!/count|files|entries|cases/i.test(key) || typeof raw !== 'number' || !Number.isFinite(raw)) continue
      stats[key] = Math.max(0, Math.min(1_000_000, Math.trunc(raw)))
    }
    if (Object.keys(stats).length > 0) result.stats = stats
  }
  return result
}

/**
 * Read and validate the prerequisites for formal Core publication.
 * Missing existing ZIPs are reported for the UI but do not block the first
 * build; Core creates and verifies them transactionally during publication.
 * @param ctx - Harness context providing Core subprocess and sandbox services.
 * @param config - Core runner limits and executable configuration.
 * @param workspace - Canonical workspace identity.
 * @param session - Session identity used for policy and ownership.
 * @param problemIds - Distinct problem ids included in the check.
 * @returns The bounded formal-delivery gate result.
 */
export async function checkDeliveryGate(
  ctx: Context,
  config: Config,
  workspace: ResolvedWorkspace,
  session: SessionRef,
  problemIds: readonly string[],
): Promise<DeliveryGate> {
  const requestedIds = [...new Set(problemIds)]
  const blockers: Array<{ code: string; problemId?: string; detail?: string }> = []
  const checks = {
    revision: {} as Record<string, unknown>,
    generation: {} as Record<string, unknown>,
    packages: {} as Record<string, Record<string, unknown>>,
  }
  if (requestedIds.length === 0 || requestedIds.length > 256 || requestedIds.some(id => !PROBLEM_ID.test(id))) {
    return { ok: false, state: 'blocked', problemIds: requestedIds.slice(0, 256), checks, blockers: [{ code: 'problem_invalid' }] }
  }
  const [status, generation, report] = await Promise.all([
    runCore(ctx, config, workspace.cwd, 'status', [], session.session),
    runCore(ctx, config, workspace.cwd, 'generation-status', [], session.session),
    runCore(ctx, config, workspace.cwd, 'report', [], session.session),
  ])
  if (!status.adapterOk) deliveryBlock(blockers, 'status_unavailable', undefined, status.error)
  if (!generation.adapterOk) deliveryBlock(blockers, 'generation_unavailable', undefined, generation.error)
  if (!report.adapterOk) deliveryBlock(blockers, 'report_unavailable', undefined, report.error)

  const generationValue = isRecord(generation.value) ? generation.value : undefined
  const generationManifest = generationValue !== undefined && isRecord(generationValue.manifest) ? generationValue.manifest : undefined
  const generationId = deliveryMarker(generationValue?.generation_id)
  const generationState = deliveryMarker(generationValue?.state) ?? 'none'
  const generationStaleFields = Array.isArray(generationValue?.stale_fields)
    ? generationValue.stale_fields.slice(0, 64).flatMap((item: unknown) => {
      const marker = deliveryMarker(item)
      return marker === undefined ? [] : [marker]
    })
    : []
  const generationStaleFieldsInvalid = generationValue?.stale_fields !== undefined
    && (!Array.isArray(generationValue.stale_fields) || generationStaleFields.length !== generationValue.stale_fields.length)
  const generationMissing = generationManifest !== undefined && Array.isArray(generationManifest.missing)
    ? generationManifest.missing.slice(0, 256).flatMap((item: unknown) => {
      if (!isRecord(item)) return []
      const problemId = deliveryMarker(item.problem_id)
      return problemId === undefined ? [] : [{ problemId, ...(typeof item.reason === 'string' ? { reason: safeText(item.reason) } : {}) }]
    })
    : []
  const generationMissingInvalid = generationManifest?.missing !== undefined
    && (!Array.isArray(generationManifest.missing) || generationMissing.length !== generationManifest.missing.length)
  const generationProblems = generationManifest !== undefined && Array.isArray(generationManifest.problems)
    ? generationManifest.problems.slice(0, 256).flatMap((item: unknown) => {
      if (!isRecord(item) || deliveryMarker(item.problem_id) === undefined) return []
      const row: Record<string, unknown> = { problemId: deliveryMarker(item.problem_id) }
      for (const key of ['state', 'revision_id', 'source_hash', 'data_hash'] as const) {
        const marker = deliveryMarker(item[key])
        if (marker !== undefined) row[key === 'revision_id' ? 'revisionId' : key === 'source_hash' ? 'sourceHash' : key === 'data_hash' ? 'dataHash' : 'state'] = marker
      }
      return [row]
    })
    : []
  checks.generation = {
    ok: generation.adapterOk && generation.coreOk && generationManifest !== undefined && generationId !== undefined,
    ...(generationId === undefined ? {} : { generationId }),
    state: generationState,
    complete: generationManifest?.complete === true,
    allSealed: generationManifest?.all_sealed === true,
    missing: generationMissing,
    problems: generationProblems,
    staleFields: generationStaleFields,
  }
  if (!generation.adapterOk || !generation.coreOk || generationManifest === undefined || generationId === undefined || generationStaleFieldsInvalid || generationMissingInvalid) deliveryBlock(blockers, 'generation_invalid')
  else {
    if (generationState === 'stale' || generationStaleFields.length > 0) deliveryBlock(blockers, 'generation_stale')
    else if (generationState !== 'sealed-preview' && generationState !== 'draft') deliveryBlock(blockers, 'generation_invalid')
    if (generationManifest.complete !== true) deliveryBlock(blockers, 'generation_incomplete')
    if (generationManifest.all_sealed !== true) deliveryBlock(blockers, 'generation_not_sealed')
    for (const missing of generationMissing) deliveryBlock(blockers, 'generation_missing', missing.problemId, missing.reason)
  }

  const statusValue = isRecord(status.value) ? status.value : undefined
  const statusProblems = statusValue !== undefined && isRecord(statusValue.problems) ? statusValue.problems : undefined
  const allIds = statusProblems === undefined
    ? requestedIds
    : Object.keys(statusProblems).filter(id => PROBLEM_ID.test(id)).slice(0, 256)
  for (const id of requestedIds) if (!allIds.includes(id)) deliveryBlock(blockers, 'status_problem_missing', id)
  if (allIds.length === 0) deliveryBlock(blockers, 'status_unavailable')
  const reportValue = report.adapterOk && isRecord(report.value) ? projectReport(report.value) : undefined
  if (reportValue !== undefined && reportValue.ok !== true) deliveryBlock(blockers, 'report_failed')
  const rawReportProblems = reportValue !== undefined && Array.isArray(reportValue.problems)
    ? reportValue.problems.flatMap((item: unknown) => isRecord(item) && typeof item.id === 'string' ? [item.id] : [])
    : report.value !== undefined && isRecord(report.value) && Array.isArray(report.value.problems)
      ? report.value.problems.flatMap((item: unknown) => isRecord(item) && typeof item.id === 'string' ? [item.id] : [])
      : []
  const projectedReportHasProblems = reportValue !== undefined
    && Array.isArray(reportValue.problems)
  const rawReportHasProblems = report.value !== undefined
    && isRecord(report.value)
    && Array.isArray(report.value.problems)
  const reportHasProblemList = projectedReportHasProblems || rawReportHasProblems
  if (reportValue !== undefined || report.value !== undefined) {
    if (!reportHasProblemList) deliveryBlock(blockers, 'report_problem_missing')
    for (const id of requestedIds) if (!rawReportProblems.includes(id)) deliveryBlock(blockers, 'report_problem_missing', id)
  }
  const reportRows = report.value !== undefined && isRecord(report.value) && Array.isArray(report.value.problems)
    ? report.value.problems.filter(isRecord)
    : []
  for (const id of allIds) {
    const current = deliveryProblemRecord(statusValue, id)
    const staged = deliveryGenerationProblem(generationValue, id)
    const revision: Record<string, unknown> = {}
    const sourceHash = deliveryMarker(current?.source_hash)
    const dataHash = deliveryMarker(current?.data_hash)
    const stagedSourceHash = deliveryMarker(staged?.source_hash)
    const stagedDataHash = deliveryMarker(staged?.data_hash)
    const sealedRevision = deliveryMarker(staged?.revision_id)
    if (sourceHash !== undefined) revision.sourceHash = sourceHash
    if (dataHash !== undefined) revision.dataHash = dataHash
    if (sealedRevision !== undefined) revision.sealedRevision = sealedRevision
    revision.status = deliveryMarker(current?.state) ?? 'missing'
    revision.sealed = staged?.state === 'sealed' && sealedRevision !== undefined
    revision.consistent = sourceHash !== undefined && dataHash !== undefined
      && stagedSourceHash === sourceHash && stagedDataHash === dataHash
    checks.revision[id] = revision
    if (current === undefined) deliveryBlock(blockers, 'status_problem_missing', id)
    const staleFields = Array.isArray(current?.stale_fields)
      ? current.stale_fields.slice(0, 64).flatMap((item: unknown) => deliveryMarker(item) ?? [])
      : []
    if (current !== undefined && (revision.status !== 'current' || staleFields.length > 0)) {
      const statusDetail = typeof revision.status === 'string' ? revision.status : undefined
      deliveryBlock(blockers, 'status_stale', id, staleFields.length === 0 ? statusDetail : staleFields.join(','))
    }
    const reportRow = reportRows.find(item => item.id === id)
    if (reportRow !== undefined) {
      const calibration = isRecord(reportRow.calibration) ? reportRow.calibration : undefined
      const calibrationState = deliveryMarker(calibration?.state ?? calibration?.status)
      if (calibrationState === undefined || calibrationState === 'missing') deliveryBlock(blockers, 'calibration_missing', id)
      else if (!['current', 'passed', 'ready'].includes(calibrationState)) deliveryBlock(blockers, 'calibration_not_current', id, calibrationState)
      const judgeQa = isRecord(reportRow.judge_qa) ? reportRow.judge_qa : undefined
      const judgeQaState = deliveryMarker(judgeQa?.state ?? judgeQa?.status)
      if (judgeQaState !== undefined && !['current', 'passed', 'ready', 'not-configured'].includes(judgeQaState)) {
        deliveryBlock(blockers, 'judge_qa_failed', id, judgeQaState)
      }
    }
    if (staged === undefined) deliveryBlock(blockers, 'generation_problem_missing', id)
    if (staged !== undefined && staged.state !== 'sealed') deliveryBlock(blockers, 'sealed_revision_invalid', id)
    if (sealedRevision === undefined) deliveryBlock(blockers, 'sealed_revision_missing', id)
    if (revision.consistent !== true) deliveryBlock(blockers, 'revision_mismatch', id)
    const packageResult: Record<string, unknown> = {}
    if (!requestedIds.includes(id)) continue
    try {
      const packageFile = await resolvePackagePath(workspace.cwd, id)
      const verification = await runCore(ctx, config, workspace.cwd, 'verify-package', [packageFile, '--require-pdf', '--problem', id], session.session)
      if (!verification.adapterOk) {
        packageResult.state = 'unavailable'
        packageResult.ok = false
        deliveryBlock(blockers, 'package_verify_unavailable', id, verification.error)
      } else {
        Object.assign(packageResult, projectVerification(verification.value))
        if (!verification.coreOk || packageResult.ok !== true) deliveryBlock(blockers, 'package_verify_failed', id)
      }
    } catch (error) {
      packageResult.state = error instanceof Error && error.message.startsWith('generated package is missing') ? 'missing' : 'invalid'
      packageResult.ok = false
      if (packageResult.state === 'invalid') deliveryBlock(blockers, 'package_invalid', id)
    }
    checks.packages[id] = packageResult
  }
  return {
    ok: blockers.length === 0,
    state: blockers.some(item => item.code.endsWith('_unavailable') || item.code === 'generation_invalid' || item.code === 'report_failed') ? 'error' : blockers.length === 0 ? 'ready' : 'blocked',
    problemIds: allIds,
    checks,
    blockers,
    ...(reportValue === undefined ? {} : { report: reportValue }),
  }
}

async function handleDeliveryCheckRequest(
  ctx: Context,
  config: Config,
  res: ServerResponse,
  workspace: ResolvedWorkspace,
  session: SessionRef,
  url: URL,
): Promise<void> {
  const raw = url.searchParams.get('problemIds') ?? url.searchParams.get('problemId')
  if (raw === null) {
    json(res, 400, { ok: false, state: 'error', code: 'problem_invalid', error: 'problemId or problemIds is required' })
    return
  }
  const ids = raw.split(',').map(item => item.trim()).filter(item => item.length > 0)
  if (ids.length === 0 || ids.length > 256 || ids.some(id => !PROBLEM_ID.test(id)) || new Set(ids).size !== ids.length) {
    json(res, 400, { ok: false, state: 'error', code: 'problem_invalid', error: 'problem ids must be distinct valid Schema v1 ids' })
    return
  }
  const gate = await checkDeliveryGate(ctx, config, workspace, session, ids)
  json(res, gate.state === 'error' ? 502 : 200, {
    ok: gate.ok,
    state: gate.state === 'error' ? 'error' : 'ready',
    workspace: publicWorkspace(workspace),
    delivery: gate,
  })
}

interface PreviewPdf {
  readonly bytes: Buffer
  readonly generationId: string
}

/**
 * Resolve one problem PDF from the current isolated Core generation.
 * Generation status is authoritative; the filesystem path is reconstructed
 * under the canonical workspace and checked again before bytes are read.
 */
async function readPreviewPdf(
  ctx: Context,
  config: Config,
  workspace: ResolvedWorkspace,
  session: SessionRef,
  problemId: string,
): Promise<PreviewPdf> {
  const result = await runCore(ctx, config, workspace.cwd, 'generation-status', [], session.session)
  if (!result.adapterOk || !result.coreOk || !isRecord(result.value)) throw new Error('preview_generation_unavailable')
  const generationId = safeMarker(result.value.generation_id)
  const manifest = isRecord(result.value.manifest) ? result.value.manifest : undefined
  const problems = manifest !== undefined && Array.isArray(manifest.problems) ? manifest.problems : []
  const entry = problems.find((item): item is Record<string, unknown> => isRecord(item) && item.problem_id === problemId)
  const relativePdf = typeof entry?.pdf === 'string' ? entry.pdf : undefined
  const expectedHash = typeof entry?.pdf_hash === 'string' ? entry.pdf_hash : undefined
  if (generationId === undefined || relativePdf === undefined || relativePdf.length === 0) throw new Error('preview_not_found')
  if (!relativePdf.toLowerCase().endsWith('.pdf') || expectedHash === undefined || !/^[a-f0-9]{64}$/u.test(expectedHash)) throw new Error('preview_invalid')
  if (isAbsolute(relativePdf) || relativePdf.split(/[\\/]/u).includes('..')) throw new Error('preview_path_invalid')
  const generationRoot = join(workspace.cwd, '.probhub', 'generations', generationId)
  const generationInfo = await lstat(generationRoot).catch(() => undefined)
  if (generationInfo === undefined || !generationInfo.isDirectory() || generationInfo.isSymbolicLink()) throw new Error('preview_not_found')
  const canonicalGeneration = await realpath(generationRoot).catch(() => undefined)
  if (canonicalGeneration === undefined) throw new Error('preview_not_found')
  const relativeGeneration = relativePath(workspace.cwd, canonicalGeneration)
  if (relativeGeneration.length === 0 || relativeGeneration.startsWith('..') || isAbsolute(relativeGeneration)) throw new Error('preview_path_invalid')
  const candidate = join(canonicalGeneration, relativePdf)
  const candidateInfo = await lstat(candidate).catch(() => undefined)
  if (candidateInfo === undefined || !candidateInfo.isFile() || candidateInfo.isSymbolicLink()) throw new Error('preview_not_found')
  const canonicalCandidate = await realpath(candidate).catch(() => undefined)
  if (canonicalCandidate === undefined) throw new Error('preview_not_found')
  const relativeCandidate = relativePath(canonicalGeneration, canonicalCandidate)
  if (relativeCandidate.length === 0 || relativeCandidate.startsWith('..') || isAbsolute(relativeCandidate)) throw new Error('preview_path_invalid')
  const maxBytes = config.maxPreviewBytes ?? 16 * 1024 * 1024
  if (candidateInfo.size > maxBytes) throw new Error('preview_too_large')
  const bytes = await readFile(canonicalCandidate)
  if (bytes.byteLength > maxBytes) throw new Error('preview_too_large')
  if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new Error('preview_invalid')
  return { bytes, generationId }
}

/** Serve a PDF from Core's isolated generation without exposing its path. */
async function handlePreviewRequest(
  ctx: Context,
  config: Config,
  res: ServerResponse,
  workspace: ResolvedWorkspace,
  session: SessionRef,
  problemId: string,
): Promise<void> {
  try {
    const preview = await readPreviewPdf(ctx, config, workspace, session, problemId)
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-length': String(preview.bytes.byteLength),
      'content-disposition': 'inline',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-probhub-generation': preview.generationId,
    })
    if (res.req.method === 'HEAD') res.end()
    else res.end(preview.bytes)
  } catch (error) {
    const code = error instanceof Error ? error.message : 'preview_unavailable'
    const status = code === 'preview_too_large' ? 413 : code === 'preview_invalid' || code === 'preview_path_invalid' ? 409 : 404
    json(res, status, { ok: false, state: 'error', code, error: 'isolated preview PDF is unavailable' })
  }
}

function projectReport(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return { ok: false }
  const result: Record<string, unknown> = { ok: value.ok }
  if (typeof value.analysis_state === 'string') result.analysisState = safeMarker(value.analysis_state)
  if (isRecord(value.summary)) result.summary = projectReportSummary(value.summary)
  if (Array.isArray(value.problems)) {
    result.problems = value.problems.slice(0, 256).flatMap((item) => {
      if (!isRecord(item) || typeof item.id !== 'string') return []
      const row: Record<string, unknown> = { id: safeMarker(item.id) ?? 'unknown' }
      if (typeof item.number === 'number' && Number.isSafeInteger(item.number)) row.number = Math.max(0, Math.min(256, item.number))
      if (typeof item.label === 'string') row.label = safeMarker(item.label)
      if (typeof item.name === 'string') row.name = safeText(item.name)
      if (typeof item.difficulty === 'number' && Number.isSafeInteger(item.difficulty)) row.difficulty = Math.max(0, Math.min(10, item.difficulty))
      if (Array.isArray(item.tags)) row.tags = item.tags.slice(0, 32).flatMap(tag => typeof tag === 'string' ? [safeText(tag)] : [])
      if (isRecord(item.limits)) row.limits = projectReportLimits(item.limits)
      if (isRecord(item.tests)) row.tests = projectReportTests(item.tests)
      if (Array.isArray(item.groups)) row.groups = item.groups.slice(0, 128).flatMap(group => projectReportGroup(group))
      if (isRecord(item.recipes)) row.recipes = projectReportRecipes(item.recipes)
      if (isRecord(item.aggregate_constraints)) row.aggregateConstraints = projectReportAggregate(item.aggregate_constraints)
      if (isRecord(item.calibration)) row.calibration = projectReportState(item.calibration)
      if (isRecord(item.judge_qa)) row.judgeQa = projectReportQa(item.judge_qa)
      if (isRecord(item.mutation)) row.mutation = projectReportMutation(item.mutation)
      if (isRecord(item.kill_matrix)) row.killMatrix = projectReportKillMatrix(item.kill_matrix)
      if (Array.isArray(item.diagnostics)) row.diagnostics = projectReportDiagnostics(item.diagnostics)
      return [row]
    })
  }
  if (Array.isArray(value.diagnostics)) result.diagnostics = projectReportDiagnostics(value.diagnostics)
  return result
}

function projectReportDiagnostics(values: unknown[]): readonly Record<string, string>[] {
  return values.slice(0, 64).flatMap((item) => {
    if (!isRecord(item)) return []
    const row: Record<string, string> = {}
    if (typeof item.code === 'string') row.code = safeMarker(item.code) ?? 'diagnostic'
    if (typeof item.severity === 'string') row.severity = safeMarker(item.severity) ?? 'info'
    return Object.keys(row).length === 0 ? [] : [row]
  })
}

function projectReportSummary(value: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!/count|cases|bytes|groups|solutions|warnings|errors|killed|survived|selected|effective|excluded|raw/i.test(key)) continue
    if (typeof item !== 'number' || !Number.isFinite(item)) continue
    result[key] = Math.max(0, Math.min(1_000_000, Math.trunc(item)))
  }
  return result
}

function projectReportLimits(value: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {}
  for (const key of ['time', 'memory', 'output', 'processes'] as const) {
    const item = value[key]
    if (typeof item === 'number' && Number.isFinite(item)) result[key] = Math.max(0, Math.min(1_000_000, item))
  }
  return result
}

function projectReportTests(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const suite of ['sample', 'secret', 'total'] as const) {
    if (isRecord(value[suite])) result[suite] = projectReportSummary(value[suite])
  }
  return result
}

function projectReportGroup(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value) || typeof value.name !== 'string') return []
  const result: Record<string, unknown> = { name: safeMarker(value.name) ?? 'unknown' }
  if (typeof value.role === 'string') result.role = safeMarker(value.role)
  for (const key of ['sample_cases', 'secret_cases', 'total_cases'] as const) {
    const item = value[key]
    if (typeof item === 'number' && Number.isFinite(item)) result[key] = Math.max(0, Math.min(1_000_000, Math.trunc(item)))
  }
  if (typeof value.secret_ratio === 'number' && Number.isFinite(value.secret_ratio)) result.secretRatio = Math.max(0, Math.min(1, value.secret_ratio))
  return [result]
}

function projectReportRecipes(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of ['analysis_state', 'total', 'manual', 'generated', 'covered_secret_cases', 'uncovered_secret_cases', 'random', 'targeted', 'near_boundary'] as const) {
    const item = value[key]
    if (typeof item === 'number' && Number.isFinite(item)) result[key] = Math.max(0, Math.min(1_000_000, Math.trunc(item)))
    else if (typeof item === 'string') result[key] = safeMarker(item)
  }
  if (typeof value.coverage_ratio === 'number' && Number.isFinite(value.coverage_ratio)) result.coverageRatio = Math.max(0, Math.min(1, value.coverage_ratio))
  return result
}

function projectReportAggregate(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (typeof value.state === 'string') result.state = safeMarker(value.state)
  if (typeof value.multi_case_detected === 'boolean') result.multiCaseDetected = value.multi_case_detected
  if (isRecord(value.summary)) result.summary = projectReportSummary(value.summary)
  return result
}

function projectReportState(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of ['state', 'status'] as const) {
    if (typeof value[key] === 'string') result[key] = safeMarker(value[key])
  }
  for (const key of ['target_guarantee', 'configured', 'applicable'] as const) {
    if (typeof value[key] === 'boolean') result[key] = value[key]
  }
  return result
}

function projectReportQa(value: Record<string, unknown>): Record<string, unknown> {
  const result = projectReportState(value)
  for (const key of ['declared_cases', 'evidence_cases', 'matched_cases', 'declared_probes', 'evidence_probes', 'manual_review_probes'] as const) {
    const item = value[key]
    if (typeof item === 'number' && Number.isFinite(item)) result[key] = Math.max(0, Math.min(1_000_000, Math.trunc(item)))
  }
  return result
}

function projectReportMutation(value: Record<string, unknown>): Record<string, unknown> {
  const result = projectReportState(value)
  if (isRecord(value.summary)) result.summary = projectReportSummary(value.summary)
  if (isRecord(value.planning)) result.planning = projectReportSummary(value.planning)
  return result
}

function projectReportKillMatrix(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (typeof value.evidence_state === 'string') result.evidenceState = safeMarker(value.evidence_state)
  if (Array.isArray(value.columns)) result.columns = value.columns.slice(0, 128).flatMap(item => typeof item === 'string' ? [safeMarker(item)] : [])
  if (Array.isArray(value.rows)) result.rows = value.rows.slice(0, 128).flatMap((item) => {
    if (!isRecord(item)) return []
    const row: Record<string, unknown> = {}
    if (typeof item.program === 'string') row.program = safeMarker(item.program) ?? safeText(item.program)
    if (typeof item.overall === 'string') row.overall = safeMarker(item.overall)
    return Object.keys(row).length > 0 ? [row] : []
  })
  return result
}

async function resolveSession(ctx: Context, rawId: string): Promise<SessionRef | undefined> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(rawId)) return undefined
  const id = makeSessionId(rawId)
  const sessions = ctx.get('sessions')
  if (sessions === undefined) return undefined
  const attached = sessions.get(id)
  if (attached !== undefined) return { id, header: attached.header, session: attached }
  const persistence: SessionPersistence | undefined = ctx.get('sessionPersistence')
  let header: SessionHeader | undefined
  try {
    header = persistence === undefined ? undefined : (await persistence.list()).find(item => item.id === id)
  } catch {
    return undefined
  }
  return header === undefined ? undefined : { id, header }
}

async function resolveWorkspace(cwd: string | undefined): Promise<{ kind: 'ok'; value: ResolvedWorkspace } | { kind: 'missing' } | { kind: 'invalid'; code: string; error: string }> {
  if (cwd === undefined) return { kind: 'invalid', code: 'session_cwd_required', error: 'session has no canonical cwd' }
  let canonical: string
  try {
    canonical = await realpath(cwd)
    if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory')
  } catch {
    return { kind: 'invalid', code: 'session_cwd_unavailable', error: 'session cwd is not an accessible directory' }
  }
  const workspaceFile = join(canonical, '.probhub', 'workspace.yaml')
  try {
    if (!(await stat(workspaceFile)).isFile()) return { kind: 'missing' }
  } catch {
    return { kind: 'missing' }
  }
  return { kind: 'ok', value: { cwd: canonical, workspaceId: createHash('sha256').update(canonical).digest('hex'), schemaVersion: 1 } }
}

/**
 * Resolve and validate the canonical workspace belonging to one live Session.
 * @param session - live Harness session whose immutable cwd identifies the workspace.
 * @returns the canonical Schema v1 workspace identity and path.
 * @throws when the session has no accessible Schema v1 workspace.
 */
export async function resolveWorkspaceForSession(session: Session): Promise<ResolvedWorkspace> {
  const result = await resolveWorkspace(session.header.cwd)
  if (result.kind === 'ok') return result.value
  if (result.kind === 'missing') throw new Error('Workspace Schema v1 is required; migrate this old workspace first')
  throw new Error(result.error)
}

function migrationCode(value: unknown): string | undefined {
  return isRecord(value) && value.code === 'migration_required' ? 'migration_required' : undefined
}

function projectCore(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return { ok: false }
  const result: Record<string, unknown> = { ok: value.ok }
  if (isRecord(value.problems)) {
    const problems: Record<string, unknown> = {}
    for (const [id, item] of Object.entries(value.problems).slice(0, 256)) {
      if (!isRecord(item)) continue
      const row: Record<string, unknown> = { id }
      if (typeof item.state === 'string') row.state = item.state
      if (typeof item.ok === 'boolean') row.lintOk = item.ok
      const final = isRecord(item.final) ? item.final : undefined
      const finalCode = safeMarker(final?.code) ?? safeMarker(final?.status)
      if (finalCode !== undefined) row.detail = finalCode
      if (Array.isArray(item.diagnostics)) row.diagnostics = projectDiagnostics(item.diagnostics)
      problems[id] = row
    }
    result.problems = problems
  }
  // Error text can contain source paths or secret identifiers. The browser
  // only needs bounded counts; detailed diagnostics remain in Core's local
  // structured result and are never copied across the bridge.
  if (Array.isArray(value.errors)) result.errorCount = Math.min(value.errors.length, 256)
  if (Array.isArray(value.warnings)) result.warningCount = Math.min(value.warnings.length, 256)
  return result
}

function projectDiagnostics(values: unknown[]): readonly Record<string, string>[] {
  return values.slice(0, 64).flatMap((item) => {
    if (!isRecord(item)) return []
    const row: Record<string, string> = {}
    if (typeof item.code === 'string') row.code = safeText(item.code)
    if (typeof item.severity === 'string') row.severity = safeText(item.severity)
    if (typeof item.message === 'string') row.message = safeText(item.message).slice(0, 512)
    return Object.keys(row).length === 0 ? [] : [row]
  })
}

function safeText(value: unknown): string {
  return String(value).replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s"']+)/g, '[path]').slice(0, 512)
}

/** Result of one bounded Core subprocess invocation. */
export interface CoreResult {
  readonly adapterOk: boolean
  readonly coreOk: boolean
  readonly value: unknown
  readonly error?: string
}

/**
 * Run a read-only Core operation with the shared subprocess and sandbox services.
 * @param ctx - Harness context providing subprocess, sandbox, and policy services.
 * @param config - executable path, output cap, and optional timeout.
 * @param cwd - canonical Schema v1 workspace path.
 * @param operation - Core CLI operation to run.
 * @param problems - operation arguments derived from validated workspace inputs.
 * @param session - optional Session used to resolve the read-only policy.
 * @param signal - optional caller cancellation signal forwarded to Core.
 * @returns bounded transport and Core result details.
 */
export async function runCore(
  ctx: Context,
  config: Config,
  cwd: string,
  operation: string,
  problems: readonly string[] = [],
  session?: Session,
  signal?: AbortSignal,
): Promise<CoreResult> {
  const command = config.command ?? 'probhub/bin/probhub.js'
  const maxOutputBytes = config.maxOutputBytes ?? 1024 * 1024
  const timeoutMs = config.timeoutMs ?? 15_000
  const subprocess: SubprocessRuntime | undefined = ctx.get('subprocess')
  if (subprocess === undefined) return { adapterOk: false, coreOk: false, value: null, error: 'core_unavailable' }
  const sandbox: SandboxProvider | undefined = ctx.get('sandbox')
  const sandboxPolicy: SandboxPolicyService | undefined = ctx.get('sandboxPolicy')
  if (sandbox === undefined || sandboxPolicy === undefined) return { adapterOk: false, coreOk: false, value: null, error: 'sandbox_unavailable' }
  let coreScript: string
  try {
    coreScript = resolveCoreScript(command)
  } catch {
    return { adapterOk: false, coreOk: false, value: null, error: 'core_unavailable' }
  }
  const commandArgv = [
    process.execPath,
    coreScript,
    '--workspace', cwd, '--json', operation,
    ...problems,
  ]
  let confinedArgv: string[]
  try {
    const policy = session === undefined
      ? sandboxPolicy.resolve({ mode: 'read-only' })
      : sandboxPolicy.resolve({ mode: 'read-only', session })
    confinedArgv = sandbox.confine(commandArgv, {
      ...policy,
      mode: 'read-only',
      workspaceRoot: cwd,
    }).argv
  } catch {
    return { adapterOk: false, coreOk: false, value: null, error: 'sandbox_unavailable' }
  }
  const controller = new AbortController()
  let abortReason: 'caller' | 'timeout' | undefined
  if (signal?.aborted === true) return { adapterOk: false, coreOk: false, value: null, error: 'core_cancelled' }
  const abortFromCaller = (): void => { abortReason = 'caller'; controller.abort() }
  signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timer = setTimeout(() => { abortReason = 'timeout'; controller.abort() }, timeoutMs)
  try {
    const handle = subprocess.spawn({
      argv: confinedArgv,
      cwd,
      graceMs: Math.min(timeoutMs, 5_000), signal: controller.signal,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: maxOutputBytes },
        stderr: { maxBytes: maxOutputBytes },
      },
    })
    const outcome = await handle.done
    try {
      if (!(await handle.waitForExit())) return { adapterOk: false, coreOk: false, value: null, error: 'cleanup_failed' }
    } catch {
      return { adapterOk: false, coreOk: false, value: null, error: 'cleanup_failed' }
    }
    if (abortReason !== undefined) return { adapterOk: false, coreOk: false, value: null, error: abortReason === 'caller' ? 'core_cancelled' : 'core_timeout' }
    if (outcome.signal !== null || outcome.exitCode === null) {
      return { adapterOk: false, coreOk: false, value: null, error: 'core_failed' }
    }
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    const out = stdout?.text ?? ''
    if (stdout?.lossy === true || stderr?.lossy === true) return { adapterOk: false, coreOk: false, value: null, error: 'core_failed' }
    if (out.length === 0) return { adapterOk: false, coreOk: false, value: null, error: 'core_failed' }
    let value: unknown
    try { value = JSON.parse(out) } catch { return { adapterOk: false, coreOk: false, value: null, error: 'core_failed' } }
    if (!isRecord(value) || typeof value.ok !== 'boolean') return { adapterOk: false, coreOk: false, value: null, error: 'core_failed' }
    // ProbHub uses non-zero exit codes for valid structured business results
    // such as stale status. Once complete JSON is present, the transport
    // succeeded and `value.ok` alone carries the Core result.
    return { adapterOk: true, coreOk: value.ok, value }
  } catch {
    return { adapterOk: false, coreOk: false, value: null, error: abortReason === 'caller' ? 'core_cancelled' : abortReason === 'timeout' ? 'core_timeout' : 'core_unavailable' }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

function publicWorkspace(workspace: ResolvedWorkspace): WorkspaceView {
  return { workspaceId: workspace.workspaceId, schemaVersion: workspace.schemaVersion }
}

function resolveCoreScript(command: string): string {
  if (isAbsolute(command)) return command
  if (command.startsWith('probhub/')) {
    return createRequire(import.meta.url).resolve(command)
  }
  throw new Error('probhub: command must be an absolute script path or a probhub package path')
}

function coreOutcomeDetail(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.code === 'string') return value.code
  if (typeof value.status === 'string') return value.status
  return undefined
}

function coreCancelled(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.code === 'cancelled' || value.status === 'cancelled' || value.reason === 'cancelled') return true
  for (const key of ['final', 'execution'] as const) {
    const nested = value[key]
    if (isRecord(nested) && (nested.code === 'cancelled' || nested.status === 'cancelled' || nested.reason === 'cancelled')) return true
  }
  if (isRecord(value.problems)) {
    return Object.values(value.problems).some(item => coreCancelled(item))
  }
  return false
}

function coreCleanupFailed(value: unknown): boolean {
  if (!isRecord(value)) return false
  const hasMarker = (record: Record<string, unknown>): boolean => {
    const code = typeof record.code === 'string' ? record.code : undefined
    const status = typeof record.status === 'string' ? record.status : undefined
    return code?.includes('cleanup_failed') === true || status?.includes('cleanup_failed') === true
  }
  if (hasMarker(value)) return true
  for (const key of ['final', 'execution', 'cleanup'] as const) {
    const nested = value[key]
    if (isRecord(nested) && hasMarker(nested)) return true
  }
  if (isRecord(value.problems)) {
    return Object.values(value.problems).some(item => coreCleanupFailed(item))
  }
  return false
}

function coreFailureDetail(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const detailOf = (record: Record<string, unknown>): string | undefined => {
    if (typeof record.code === 'string') return record.code
    if (typeof record.status === 'string' && !['passed', 'completed'].includes(record.status)) return record.status
    if (typeof record.reason === 'string') return record.reason
    return undefined
  }
  const direct = detailOf(value)
  if (direct !== undefined) return direct
  for (const key of ['final', 'execution', 'cleanup'] as const) {
    const nested = value[key]
    if (isRecord(nested)) {
      const detail = detailOf(nested)
      if (detail !== undefined) return detail
    }
  }
  if (isRecord(value.problems)) {
    for (const item of Object.values(value.problems)) {
      const detail = coreFailureDetail(item)
      if (detail !== undefined) return detail
    }
  }
  return undefined
}

/** Keep only short machine status markers in model-visible job output. */
function safeMarker(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) return undefined
  return value
}

/** Project a Core result before exposing it through a Harness job. */
function projectJobOutput(value: unknown, operation: CoreOperation): string {
  if (!isRecord(value)) return JSON.stringify({ ok: false })
  const projected: Record<string, unknown> = { ok: value.ok === true, operation }
  for (const key of ['code', 'status', 'reason', 'stop_code'] as const) {
    const marker = safeMarker(value[key])
    if (marker !== undefined) projected[key] = marker
  }
  const result = projectCore(value)
  for (const key of ['problems', 'errorCount', 'warningCount'] as const) {
    if (result[key] !== undefined) projected[key] = result[key]
  }
  if (operation === 'checkpoint' || operation === 'seal') {
    const checkpoint = projectCheckpoint(value.checkpoint)
    if (checkpoint !== undefined) projected.checkpoint = checkpoint
  }
  if (operation === 'seal' || operation === 'assemble') {
    const generation = projectGeneration(value.generation ?? (operation === 'assemble' ? value : undefined))
    if (generation !== undefined) projected.generation = generation
  }
  if (operation === 'build') {
    const batchId = safeMarker(value.batch_id)
    if (batchId !== undefined) projected.batch_id = batchId
    const packages = projectProblemMap(value.packages, true)
    const judge = projectProblemMap(value.judge, false)
    if (packages !== undefined) projected.packages = packages
    if (judge !== undefined) projected.judge = judge
  }
  return JSON.stringify(projected)
}

function projectCheckpoint(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const result: Record<string, unknown> = {}
  for (const key of ['problem_id', 'revision_id', 'state', 'source_hash', 'data_hash'] as const) {
    const marker = safeMarker(value[key])
    if (marker !== undefined) result[key] = marker
  }
  return Object.keys(result).length === 0 ? undefined : result
}

function projectGeneration(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const result: Record<string, unknown> = {}
  for (const key of ['generation_id', 'state'] as const) {
    const marker = safeMarker(value[key])
    if (marker !== undefined) result[key] = marker
  }
  for (const key of ['complete', 'all_sealed'] as const) {
    if (typeof value[key] === 'boolean') result[key] = value[key]
  }
  if (Array.isArray(value.missing)) {
    result.missing = value.missing.slice(0, 256).flatMap((item: unknown) => {
      if (!isRecord(item)) return []
      const row: Record<string, string> = {}
      const problemId = safeMarker(item.problem_id)
      const reason = safeText(item.reason)
      if (problemId !== undefined) row.problem_id = problemId
      row.reason = reason
      return Object.keys(row).length === 0 ? [] : [row]
    })
  }
  return Object.keys(result).length === 0 ? undefined : result
}

function projectProblemMap(value: unknown, includeVerification: boolean): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const result: Record<string, unknown> = {}
  for (const [id, raw] of Object.entries(value).slice(0, 256)) {
    if (!PROBLEM_ID_MARKER.test(id) || !isRecord(raw)) continue
    const row: Record<string, unknown> = {}
    if (typeof raw.ok === 'boolean') row.ok = raw.ok
    if (typeof raw.status === 'string') row.status = safeMarker(raw.status)
    if (includeVerification && isRecord(raw.verification)) {
      const verification: Record<string, unknown> = {}
      if (typeof raw.verification.ok === 'boolean') verification.ok = raw.verification.ok
      if (typeof raw.verification.errorCount === 'number') verification.errorCount = Math.min(Math.max(0, raw.verification.errorCount), 256)
      if (typeof raw.verification.warningCount === 'number') verification.warningCount = Math.min(Math.max(0, raw.verification.warningCount), 256)
      if (Object.keys(verification).length > 0) row.verification = verification
    }
    const final = isRecord(raw.final) ? raw.final : undefined
    const finalCode = safeMarker(final?.code) ?? safeMarker(final?.status)
    if (finalCode !== undefined) row.detail = finalCode
    if (Object.keys(row).length > 0) result[id] = row
  }
  return Object.keys(result).length === 0 ? undefined : result
}

const PROBLEM_ID_MARKER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/**
 * Compare paths by filesystem identity before falling back to a normalized
 * spelling. Windows can expose one directory through both an 8.3 short name
 * and its long name; strict string comparison would reject that valid alias.
 */
function sameFilesystemEntry(left: string, right: string): boolean {
  try {
    const leftInfo = statSync(left)
    const rightInfo = statSync(right)
    if (
      leftInfo.dev !== 0 && rightInfo.dev !== 0 && leftInfo.ino !== 0
      && leftInfo.dev === rightInfo.dev && leftInfo.ino === rightInfo.ino
    ) return true
  } catch {
    // Fall through to normalized spelling when filesystem metadata is absent.
  }
  return normalize(left).toLowerCase() === normalize(right).toLowerCase()
}

interface EventFrame {
  readonly protocol_schema_version: 1
  readonly type: 'started' | 'progress' | 'final' | 'cancelled'
  readonly operation?: string
  readonly problem_id?: string
  readonly completed?: number
  readonly total?: number
  readonly unit?: string
  readonly detail?: Record<string, unknown>
  readonly result?: unknown
  readonly ok?: boolean
  readonly status?: string
  readonly reason?: string
}

function parseEventStreamLine(line: string): EventFrame | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined
  try {
    const obj = JSON.parse(trimmed) as unknown
    if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
      const record = obj as Record<string, unknown>
      if (record.protocol_schema_version === 1 && typeof record.type === 'string') {
        return record as unknown as EventFrame
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

function formatProgressNotice(event: EventFrame): string {
  const op = event.operation ?? 'job'
  const id = event.problem_id ? ` ${event.problem_id}` : ''
  const completed = event.completed !== undefined ? String(event.completed) : '?'
  const total = event.total !== undefined ? `/${event.total}` : ''
  const unit = event.unit ? ` ${event.unit}` : ''
  return `[${op}${id}] progress: ${completed}${total}${unit}`
}

/**
 * Start one detached, workspace-write Core operation as a generic job producer.
 * The producer owns only the child process and its cancellation marker; Core
 * remains responsible for locks, snapshots, evidence and transactional writes.
 * @param ctx - Harness context providing subprocess, sandbox, and policy services.
 * @param config - executable path and bounded output settings.
 * @param request - validated operation, canonical workspace, and session identity.
 * @returns non-rejecting job hooks for the shared job registry.
 * @throws when required services, workspace identity, permission, or process startup is unavailable.
 */
export function createCoreJobHooks(
  ctx: Context,
  config: CoreRunnerConfig,
  request: CoreJobRequest,
): JobHooks {
  const subprocess = ctx.get('subprocess')
  const sandbox = ctx.get('sandbox')
  const sandboxPolicy = ctx.get('sandboxPolicy')
  if (subprocess === undefined) throw new Error('Core subprocess capability is unavailable')
  if (sandbox === undefined || sandboxPolicy === undefined) throw new Error('workspace-write sandbox capability is unavailable')

  const workspace = request.workspace
  const sessionCwd = request.session.header.cwd
  if (sessionCwd === undefined) throw new Error('session has no canonical cwd')
  let canonicalSession: string
  let canonicalWorkspace: string
  try {
    canonicalSession = realpathSync(sessionCwd)
    if (!statSync(join(canonicalSession, '.probhub', 'workspace.yaml')).isFile()) throw new Error('workspace schema missing')
    canonicalWorkspace = realpathSync(workspace)
    if (!statSync(join(canonicalWorkspace, '.probhub', 'workspace.yaml')).isFile()) throw new Error('workspace schema missing')
  } catch {
    throw new Error('Workspace Schema v1 is required; migrate this old workspace first')
  }
  if (!sameFilesystemEntry(canonicalSession, canonicalWorkspace)) throw new Error('workspace identity changed; retry the validation job')
  const temp = mkdtempSync(join(tmpdir(), 'dsh-probhub-job-'))
  const cancelFile = join(temp, 'cancel')
  const controller = new AbortController()
  let handle: SubprocessHandle
  let safeOutput = ''
  let outputRead = false
  let cancelRequested = false
  let cancelError: string | undefined
  let stdoutOffset = 0
  let latestProgress: string | undefined
  let stdoutCarry = ''
  const wasCancelled = (): boolean => cancelRequested
  try {
    const coreScript = resolveCoreScript(config.command)
    const supportsEventStream = request.operation === 'stress' || request.operation === 'mutation' || request.operation === 'judge'
    const commandArgv = [
      process.execPath,
      coreScript,
      '--workspace', workspace,
      ...(supportsEventStream ? ['--event-stream'] : []),
      '--json', request.operation,
      ...(request.problemIds ?? (request.problemId === undefined ? [] : [request.problemId])),
      ...(request.args ?? []),
    ]
    // Validation jobs deliberately require the caller's already-authorized
    // workspace-write mode. This adapter never upgrades a read-only session
    // or bypasses the shared approval/permission flow.
    const policy = sandboxPolicy.resolve({ session: request.session })
    if (policy.mode !== 'workspace-write') {
      throw new Error('ProbHub background validation requires workspace-write permission')
    }
    const confined = sandbox.confine(commandArgv, {
      ...policy,
      mode: 'workspace-write',
      workspaceRoot: workspace,
    })
    handle = subprocess.spawn({
      argv: confined.argv,
      cwd: workspace,
      env: { PROBHUB_CANCEL_FILE: cancelFile, PYTHONIOENCODING: 'utf-8' },
      graceMs: 5_000,
      signal: controller.signal,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: config.maxOutputBytes },
        stderr: { maxBytes: config.maxOutputBytes },
      },
    })
  } catch (error) {
    try { rmSync(temp, { recursive: true, force: false }) } catch { /* preserve the launch error */ }
    throw error
  }

  const done = (async (): Promise<JobOutcome> => {
    let outcome: JobOutcome
    try {
      const processOutcome = await handle.done
      let treeExited = false
      let cleanupFailed = false
      try {
        treeExited = await handle.waitForExit()
      } catch {
        // A rejected tree-liveness probe is an infrastructure cleanup failure;
        // it must not be reclassified as cancellation merely because a stop
        // request raced with the probe.
        cleanupFailed = true
      }
      if (cleanupFailed) {
        // Keep cleanup failure as the highest-priority outcome.
        outcome = { status: 'failed', detail: 'cleanup_failed' }
      } else if (!treeExited) {
        outcome = { status: 'failed', detail: 'cleanup_failed' }
      } else {
        const stdout = handle.collected.stdout?.readFrom(0)
        const stderr = handle.collected.stderr?.readFrom(0)
        void stderr
        const text = stdout?.text ?? ''
        if (processOutcome.signal === null && processOutcome.exitCode !== null && stdout?.lossy !== true && text.length > 0) {
          try {
            let value: unknown
            let finalFrame: EventFrame | undefined
            let cancelledFrame: EventFrame | undefined
            const lines = text.split('\n')
            for (const line of lines) {
              const frame = parseEventStreamLine(line)
              if (frame?.type === 'final' && frame.result !== undefined) {
                finalFrame = frame
              } else if (frame?.type === 'cancelled') {
                cancelledFrame = frame
              }
            }
            if (finalFrame !== undefined) {
              value = finalFrame.result
            } else if (cancelledFrame !== undefined) {
              value = {
                ok: false,
                code: 'cancelled',
                status: 'cancelled',
                reason: cancelledFrame.reason ?? 'cancellation_requested',
                operation: cancelledFrame.operation,
                problem_id: cancelledFrame.problem_id,
              }
            } else {
              value = JSON.parse(text) as unknown
            }
            safeOutput = projectJobOutput(value, request.operation)
            const detail = coreOutcomeDetail(value)
            outcome = coreCleanupFailed(value)
              ? { status: 'failed', detail: 'cleanup_failed', output: safeOutput }
              : coreCancelled(value)
                ? { status: 'killed', detail: 'cancelled', output: safeOutput }
                : isRecord(value) && value.ok === true
                  ? { status: 'completed', output: safeOutput, ...(detail === undefined ? {} : { detail }) }
                  : { status: 'failed', detail: coreFailureDetail(value) ?? 'core_failed', output: safeOutput }
          } catch {
            outcome = { status: 'failed', detail: 'core_failed' }
          }
        } else if (cancelError !== undefined) {
          outcome = { status: 'failed', detail: 'cancel_request_failed' }
        } else if (wasCancelled()) {
          outcome = { status: 'killed', detail: 'cancelled' }
        } else if (processOutcome.signal !== null || processOutcome.exitCode === null) {
          outcome = { status: 'failed', detail: 'core_process_terminated' }
        } else {
          outcome = { status: 'failed', detail: stdout?.lossy === true ? 'core_output_limit' : 'core_failed' }
        }
      }
    } catch {
      outcome = { status: 'failed', detail: cancelError === undefined ? 'core_failed' : 'cancel_request_failed' }
    }
    try {
      rmSync(temp, { recursive: true, force: false })
    } catch (error: unknown) {
      if ((error as { code?: unknown }).code !== 'ENOENT') return { status: 'failed', detail: 'cleanup_failed' }
    }
    return outcome
  })()

  return {
    cancel: () => {
      if (cancelRequested) return
      cancelRequested = true
      try { writeFileSync(cancelFile, '1') } catch (error: unknown) { cancelError = String(error) }
      try { handle.terminate() } catch (error: unknown) { cancelError = String(error) }
      controller.abort()
    },
    done,
    readOutput: () => {
      if (handle.collected.stdout !== undefined) {
        const read = handle.collected.stdout.readFrom(stdoutOffset)
        stdoutOffset = read.nextOffset
        if (read.text.length > 0) {
          const chunk = stdoutCarry + read.text
          const lastNewline = chunk.lastIndexOf('\n')
          if (lastNewline !== -1) {
            const completeChunk = chunk.slice(0, lastNewline)
            stdoutCarry = chunk.slice(lastNewline + 1)
            const lines = completeChunk.split('\n')
            for (const line of lines) {
              const frame = parseEventStreamLine(line)
              if (frame?.type === 'progress') {
                latestProgress = formatProgressNotice(frame)
              }
            }
          } else {
            stdoutCarry = chunk
          }
        }
      }
      if (safeOutput.length > 0) {
        if (outputRead) return ''
        outputRead = true
        return safeOutput
      }
      if (latestProgress !== undefined) {
        const p = latestProgress
        latestProgress = undefined
        return p
      }
      return ''
    },
  }
}

/**
 * Register one validated Core operation in the shared Harness Job registry.
 * The registry owns lifecycle and visibility; this helper only supplies the
 * same Core producer used by model-facing tools and browser actions.
 * @param ctx - Harness context providing the job registry.
 * @param config - executable path and bounded output settings.
 * @param request - validated operation and canonical workspace identity.
 * @param owner - live Agent that owns and may observe the job.
 * @param label - short user-visible job label.
 * @returns the registry-issued job id.
 */
export function startCoreJob(
  ctx: Context,
  config: CoreRunnerConfig,
  request: CoreJobRequest,
  owner: Agent,
  label: string,
): JobId {
  return ctx.jobs.start({
    kind: 'probhub',
    label,
    owner,
    outputLimitBytes: config.maxOutputBytes,
    run: () => createCoreJobHooks(ctx, config, request),
  })
}

function summarizeProblems(status: unknown, lint: unknown): ProblemSummary[] {
  const rows = new Map<string, ProblemSummary>()
  const statusProblems = isRecord(status) && isRecord(status.problems) ? status.problems : undefined
  if (statusProblems !== undefined) for (const [id, item] of Object.entries(statusProblems).slice(0, 256)) {
    const state = isRecord(item) && typeof item.state === 'string' ? item.state : undefined
    const identity = problemIdentity(status, id)
    rows.set(id, {
      id,
      ...(state === undefined ? {} : { status: state }),
      ...(identity.revision === undefined ? {} : { revision: identity.revision }),
      ...(identity.generation === undefined ? {} : { generation: identity.generation }),
    })
  }
  const lintProblems = Array.isArray(lint) ? lint : isRecord(lint) && Array.isArray(lint.problems) ? lint.problems : []
  for (const item of lintProblems.slice(0, 256)) {
    if (!isRecord(item) || typeof item.id !== 'string') continue
    rows.set(item.id, { ...(rows.get(item.id) ?? { id: item.id }), lintOk: item.ok === true })
  }
  return [...rows.values()]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function json(res: ServerResponse, status: number, body: BridgeResponse): void {
  const encoded = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  if (res.req.method === 'HEAD') res.end()
  else res.end(encoded)
}
