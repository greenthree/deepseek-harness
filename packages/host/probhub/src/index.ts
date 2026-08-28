/** Read-only HTTP bridge from a Harness session to ProbHub Core. */

import { realpath, stat } from 'node:fs/promises'
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
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

/** Core command configuration for the bridge. */
export interface Config {
  /** Node script path for the installed ProbHub Core CLI. */
  command?: string
  /** Maximum Core stdout/stderr bytes retained per request. */
  maxOutputBytes?: number
  /** Maximum time spent waiting for a read-only Core operation. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  command: z.string().default('probhub/bin/probhub.js'),
  maxOutputBytes: z.natural().min(1024).default(1024 * 1024),
  timeoutMs: z.natural().min(1).default(15_000),
})

/** Operations exposed by the background ProbHub validation producer. */
export type CoreOperation = 'judge' | 'stress' | 'judge-qa' | 'mutation'

/** A validated Core operation request. Paths are always derived from Session cwd. */
export interface CoreJobRequest {
  readonly operation: CoreOperation
  readonly problemId: string
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
}
interface WorkspaceView {
  readonly workspaceId: string
  readonly schemaVersion: 1
}
interface ResolvedWorkspace extends WorkspaceView { readonly cwd: string }
interface BridgeResponse {
  readonly ok: boolean
  readonly state: State
  readonly workspace?: WorkspaceView
  readonly problems?: readonly ProblemSummary[]
  readonly status?: unknown
  readonly lint?: unknown
  readonly code?: string
  readonly error?: string
}

interface SessionRef {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly session?: Session
}

/** Registers the `/probhub` read-only route family. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved: Config = {
    command: config?.command ?? 'probhub/bin/probhub.js',
    maxOutputBytes: config?.maxOutputBytes ?? 1024 * 1024,
    timeoutMs: config?.timeoutMs ?? 15_000,
  }
  const route: WebRoute = {
    kind: 'prefix',
    path: PROBHUB_PATH,
    handler: async (req, res) => handleRequest(ctx, resolved, req, res),
  }
  ctx.effect(() => ctx.webServer.register(route), 'probhub: read-only routes')
}

/** Stable plugin name for profile composition. */
export const name = 'host-probhub'
/** This plugin only needs the HTTP carrier; optional services are checked per request. */
export const inject = ['webServer']

async function handleRequest(ctx: Context, config: Config, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, 405, { ok: false, state: 'error', code: 'method_not_allowed', error: 'GET is required' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
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
  const operation = url.pathname.slice(`${PROBHUB_API_PATH}/`.length)
  if (operation !== 'overview' && operation !== 'status' && operation !== 'lint') {
    const problemMatch = /^problems\/([^/]+)\/(status|lint)$/.exec(operation)
    const problemId = problemMatch?.[1]
    const problemOperation = problemMatch?.[2]
    if (problemId === undefined || problemOperation === undefined || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(problemId)) {
      json(res, 404, { ok: false, state: 'error', code: 'not_found', error: 'unknown ProbHub route' })
      return
    }
    await runProblemOperation(ctx, config, res, workspace.value, problemOperation, problemId, session.session)
    return
  }
  const status = operation === 'lint' ? undefined : await runCore(ctx, config, workspace.value.cwd, 'status', [], session.session)
  const lint = operation === 'status' ? undefined : await runCore(ctx, config, workspace.value.cwd, 'lint', [], session.session)
  const migration = migrationCode(status?.value) ?? migrationCode(lint?.value)
  const adapterOk = (status?.adapterOk ?? true) && (lint?.adapterOk ?? true)
  const coreOk = (status?.coreOk ?? true) && (lint?.coreOk ?? true)
  const body: BridgeResponse = {
    ok: adapterOk && coreOk,
    state: adapterOk ? (migration === undefined ? 'ready' : 'migration_required') : 'error',
    workspace: publicWorkspace(workspace.value),
    ...(status === undefined ? {} : { status: projectCore(status.value) }),
    ...(lint === undefined ? {} : { lint: projectCore(lint.value) }),
    ...(operation === 'overview' ? { problems: summarizeProblems(status?.value, lint?.value) } : {}),
    ...(migration === undefined ? {} : { code: migration }),
    ...(adapterOk ? {} : { code: status?.error ?? lint?.error ?? 'core_failed' }),
  }
  json(res, body.state === 'migration_required' ? 409 : adapterOk ? 200 : 502, body)
}

async function runProblemOperation(
  ctx: Context,
  config: Config,
  res: ServerResponse,
  workspace: ResolvedWorkspace,
  operation: string,
  problem: string,
  session?: Session,
): Promise<void> {
  const result = await runCore(ctx, config, workspace.cwd, operation, [problem], session)
  const migration = migrationCode(result.value)
  json(res, migration === undefined ? (result.adapterOk ? 200 : 502) : 409, {
    ok: result.adapterOk && result.coreOk,
    state: result.adapterOk ? (migration === undefined ? 'ready' : 'migration_required') : 'error',
    workspace: publicWorkspace(workspace),
    [operation]: projectCore(result.value),
    ...(migration === undefined ? {} : { code: migration }),
    ...(result.error === undefined ? {} : { code: result.error }),
  })
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

interface CoreResult { readonly adapterOk: boolean; readonly coreOk: boolean; readonly value: unknown; readonly error?: string }

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

async function runCore(
  ctx: Context,
  config: Config,
  cwd: string,
  operation: string,
  problems: readonly string[] = [],
  session?: Session,
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
  const timer = setTimeout(() => { controller.abort() }, config.timeoutMs)
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
    if (controller.signal.aborted) return { adapterOk: false, coreOk: false, value: null, error: 'core_timeout' }
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
    return { adapterOk: false, coreOk: false, value: null, error: controller.signal.aborted ? 'core_timeout' : 'core_unavailable' }
  } finally {
    clearTimeout(timer)
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
  return isRecord(value) && (value.code === 'cancelled' || value.status === 'cancelled')
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
  try {
    canonicalSession = realpathSync(sessionCwd)
    if (!statSync(join(canonicalSession, '.probhub', 'workspace.yaml')).isFile()) throw new Error('workspace schema missing')
  } catch {
    throw new Error('Workspace Schema v1 is required; migrate this old workspace first')
  }
  if (canonicalSession !== workspace) throw new Error('workspace identity changed; retry the validation job')
  const temp = mkdtempSync(join(tmpdir(), 'dsh-probhub-job-'))
  const cancelFile = join(temp, 'cancel')
  const controller = new AbortController()
  let handle: SubprocessHandle
  let outputOffset = 0
  let cancelRequested = false
  let cancelError: string | undefined
  try {
    const coreScript = resolveCoreScript(config.command)
    const commandArgv = [
      process.execPath,
      coreScript,
      '--workspace', workspace,
      '--json', request.operation,
      request.problemId,
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
      if (!(await handle.waitForExit())) {
        outcome = { status: 'failed', detail: 'cleanup_failed' }
      } else {
        const stdout = handle.collected.stdout?.readFrom(0)
        const stderr = handle.collected.stderr?.readFrom(0)
        void stderr
        const text = stdout?.text ?? ''
        if (processOutcome.signal === null && processOutcome.exitCode !== null && stdout?.lossy !== true && text.length > 0) {
          try {
            const value = JSON.parse(text) as unknown
            const detail = coreOutcomeDetail(value)
            outcome = coreCancelled(value)
              ? { status: 'killed', detail: 'cancelled', output: text }
              : { status: 'completed', output: text, ...(detail === undefined ? {} : { detail }) }
          } catch {
            outcome = { status: 'failed', detail: 'core_failed' }
          }
        } else if (cancelRequested) {
          outcome = { status: 'killed', detail: 'cancelled' }
        } else if (cancelError !== undefined) {
          outcome = { status: 'failed', detail: 'cancel_request_failed' }
        } else if (processOutcome.signal !== null || processOutcome.exitCode === null) {
          outcome = { status: 'failed', detail: 'core_process_terminated' }
        } else {
          outcome = { status: 'failed', detail: stdout?.lossy === true ? 'core_output_limit' : 'core_failed' }
        }
      }
    } catch {
      outcome = { status: cancelRequested ? 'killed' : 'failed', detail: cancelRequested ? 'cancelled' : 'core_failed' }
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
      const reader = handle.collected.stdout
      if (reader === undefined) return ''
      const read = reader.readFrom(outputOffset)
      outputOffset = read.nextOffset
      return read.lossy ? `${read.text}\n[output truncated]` : read.text
    },
  }
}

function summarizeProblems(status: unknown, lint: unknown): ProblemSummary[] {
  const rows = new Map<string, ProblemSummary>()
  const statusProblems = isRecord(status) && isRecord(status.problems) ? status.problems : undefined
  if (statusProblems !== undefined) for (const [id, item] of Object.entries(statusProblems).slice(0, 256)) {
    const state = isRecord(item) && typeof item.state === 'string' ? item.state : undefined
    rows.set(id, state === undefined ? { id } : { id, status: state })
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
