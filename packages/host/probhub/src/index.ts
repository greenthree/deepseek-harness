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
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'

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
interface ResolvedWorkspace extends WorkspaceView { readonly cwd: string }
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
}

interface SessionRef {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly session?: Session
}

interface ProblemSelection {
  readonly sequence: number
  readonly dispose: () => void
}

const PROBLEM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** Registers the `/probhub` read-only route family. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved: Config = {
    command: config.command ?? 'probhub/bin/probhub.js',
    maxOutputBytes: config.maxOutputBytes ?? 1024 * 1024,
    timeoutMs: config.timeoutMs ?? 15_000,
  }
  const selections = new Map<string, ProblemSelection>()
  const latestSelections = new Map<string, number>()
  const route: WebRoute = {
    kind: 'prefix',
    path: PROBHUB_PATH,
    handler: async (req, res) => handleRequest(ctx, resolved, req, res, selections, latestSelections),
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
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const isContextRoute = url.pathname === `${PROBHUB_API_PATH}/context`
  const allowed = isContextRoute ? req.method === 'POST' : req.method === 'GET' || req.method === 'HEAD'
  if (!allowed) {
    json(res, 405, { ok: false, state: 'error', code: 'method_not_allowed', error: isContextRoute ? 'POST is required' : 'GET is required' })
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
  const problemId = url.searchParams.get('problemId')
  if (problemId === null || !PROBLEM_ID.test(problemId)) {
    json(res, 400, { ok: false, state: 'error', code: 'problem_invalid', error: 'a valid Schema v1 problem id is required' })
    return
  }
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
  const dispose = prompt.context({
    name: 'probhub:selected-problem',
    order: 205,
    text,
  })
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

function problemIdentity(value: unknown, problemId: string): { revision?: string; generation?: string } {
  if (!isRecord(value) || !isRecord(value.problems)) return {}
  const raw = value.problems[problemId]
  if (!isRecord(raw)) return {}
  const manifest = isRecord(raw.manifest) ? raw.manifest : undefined
  const revision = safeMarker(raw.sealed_revision_id)
    ?? safeMarker(manifest?.sealed_revision_id)
    ?? safeMarker(raw.revision_id)
    ?? safeMarker(manifest?.revision_id)
    ?? safeMarker(raw.source_hash)
    ?? safeMarker(manifest?.source_hash)
  const generation = safeMarker(raw.generation_id)
    ?? safeMarker(manifest?.generation_id)
    ?? safeMarker(raw.batch_id)
    ?? safeMarker(manifest?.batch_id)
  return { ...(revision === undefined ? {} : { revision }), ...(generation === undefined ? {} : { generation }) }
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
  let safeOutput = ''
  let outputRead = false
  let cancelRequested = false
  let cancelError: string | undefined
  const wasCancelled = (): boolean => cancelRequested
  try {
    const coreScript = resolveCoreScript(config.command)
    const commandArgv = [
      process.execPath,
      coreScript,
      '--workspace', workspace,
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
            const value = JSON.parse(text) as unknown
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
      if (outputRead || safeOutput.length === 0) return ''
      outputRead = true
      return safeOutput
    },
  }
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
