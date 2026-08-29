/** Model-facing background validation tools over the shared ProbHub Core runner. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ParameterSchemaSpec, PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { dirname, join } from 'node:path'
import { lstat, realpath, stat } from 'node:fs/promises'
import {
  createCoreJobHooks,
  DEFAULT_CORE_RUNNER_CONFIG,
  runCore,
  resolveWorkspaceForSession,
  type CoreJobRequest,
  type CoreOperation,
} from './index.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { probhub: 'probhub' }
}

export const name = 'tool-probhub'
export const inject = ['tools', 'jobs', 'systemPrompt']

/** Configures the installed ProbHub CLI and bounded job output. */
export interface Config {
  command?: string
  maxOutputBytes?: number
}

export const Config: z<Config> = z.object({
  command: z.string().default(DEFAULT_CORE_RUNNER_CONFIG.command),
  maxOutputBytes: z.natural().min(1024).default(DEFAULT_CORE_RUNNER_CONFIG.maxOutputBytes),
})

type ProblemArgs = { problem_id: string }
type StressArgs = ProblemArgs & { rounds?: number; seed?: number }
type ParsedOperation = { problemId?: string; problemIds?: readonly string[]; extra: readonly string[] }

const PROBLEM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const MAX_STRESS_ROUNDS = 1_000_000

function validateProblemId(value: string): string {
  if (!PROBLEM_ID.test(value)) throw new Error('invalid problem_id: expected a Schema v1 problem id')
  return value
}

function validateProblemIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) {
    throw new Error('invalid problem_ids: expected an array containing 1 to 256 problem ids')
  }
  const ids: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('invalid problem_ids: every item must be a problem id string')
    const id = validateProblemId(item)
    if (seen.has(id)) throw new Error(`invalid problem_ids: duplicate problem id ${id}`)
    seen.add(id)
    ids.push(id)
  }
  return ids
}

function validateStress(args: StressArgs): string[] {
  const values: string[] = []
  if (args.rounds !== undefined) {
    if (!Number.isSafeInteger(args.rounds) || args.rounds <= 0 || args.rounds > MAX_STRESS_ROUNDS) {
      throw new Error(`invalid rounds: expected an integer from 1 to ${MAX_STRESS_ROUNDS}`)
    }
    values.push('--rounds', String(args.rounds))
  }
  if (args.seed !== undefined) {
    if (!Number.isSafeInteger(args.seed) || args.seed < 0) throw new Error('invalid seed: expected a non-negative safe integer')
    values.push('--seed', String(args.seed))
  }
  return values
}

function present(title: string): GenericCallView {
  return { card: 'generic', title, kind: 'execute' }
}

function presentTitle(operation: string, args: unknown): GenericCallView {
  const value = args !== null && typeof args === 'object' && 'problem_id' in args
    ? (args as { problem_id?: unknown }).problem_id
    : undefined
  return present(`${operation} ${typeof value === 'string' ? value : ''}`)
}

function jsonResult(_args: unknown, value: unknown): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

const SAFE_MARKER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/

function safeMarker(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_MARKER.test(value) ? value : undefined
}

function safeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s"']+)/g, '[path]').slice(0, 256)
}

function projectReadValue(operation: 'generation-status' | 'report' | 'verify-package', value: Record<string, JsonValue>): { ok: boolean } & Record<string, JsonValue> {
  const result: { ok: boolean } & Record<string, JsonValue> = { ok: value.ok === true }
  for (const key of ['code', 'status', 'state', 'reason'] as const) {
    const marker = safeMarker(value[key])
    if (marker !== undefined) result[key] = marker
  }
  if (operation === 'generation-status') {
    const generation = value.manifest ?? value.generation ?? value
    const generationValue: unknown = generation
    if (generationValue !== null && typeof generationValue === 'object' && !Array.isArray(generationValue)) {
      const generationRecord = generationValue as Record<string, unknown>
      const projected: Record<string, JsonValue> = {}
      for (const key of ['generation_id', 'state'] as const) {
        const marker = safeMarker(generationRecord[key])
        if (marker !== undefined) projected[key] = marker
      }
      for (const key of ['complete', 'all_sealed'] as const) {
        const flag = generationRecord[key]
        if (typeof flag === 'boolean') projected[key] = flag
      }
      const missing = generationRecord.missing
      if (Array.isArray(missing)) {
        projected.missing = missing.slice(0, 256).flatMap((item: unknown) => {
          if (item === null || typeof item !== 'object' || Array.isArray(item)) return []
          const itemRecord = item as Record<string, unknown>
          const row: Record<string, JsonValue> = {}
          const id = safeMarker(itemRecord.problem_id)
          const reason = safeText(itemRecord.reason)
          if (id !== undefined) row.problem_id = id
          if (reason !== undefined) row.reason = reason
          return Object.keys(row).length > 0 ? [row] : []
        })
      }
      if (Object.keys(projected).length > 0) result.generation = projected
    }
    const stale = value.stale_fields
    if (Array.isArray(stale)) result.stale_fields = stale.slice(0, 256).flatMap(item => safeMarker(item) ?? [])
  } else if (operation === 'report') {
    const problems = value.problems
    if (Array.isArray(problems) || (problems !== null && typeof problems === 'object')) {
      const projected: Record<string, JsonValue> = {}
      const entries = Array.isArray(problems)
        ? problems.slice(0, 256).flatMap((item: unknown) => {
          if (item === null || typeof item !== 'object' || Array.isArray(item)) return []
          const id = safeMarker((item as Record<string, unknown>).id)
          return id === undefined ? [] : [[id, item] as const]
        })
        : Object.entries(problems).slice(0, 256)
      for (const [id, item] of entries) {
        if (!SAFE_MARKER.test(id) || item === null || typeof item !== 'object' || Array.isArray(item)) continue
        const itemRecord = item as Record<string, unknown>
        const row: Record<string, JsonValue> = {}
        for (const key of ['state', 'status', 'detail'] as const) {
          const marker = safeMarker(itemRecord[key])
          if (marker !== undefined) row[key] = marker
        }
        const ok = itemRecord.ok
        if (typeof ok === 'boolean') row.ok = ok
        if (Object.keys(row).length > 0) projected[id] = row
      }
      if (Object.keys(projected).length > 0) result.problems = projected
    }
    const summary = value.summary
    if (summary !== null && typeof summary === 'object' && !Array.isArray(summary)) {
      const projected: Record<string, JsonValue> = {}
      for (const [key, item] of Object.entries(summary as Record<string, unknown>)) {
        if (/count|total|matched|warning|error/i.test(key) && typeof item === 'number' && Number.isFinite(item)) projected[key] = Math.max(0, Math.min(1000000, Math.trunc(item)))
      }
      if (Object.keys(projected).length > 0) result.summary = projected
    }
  } else {
    const scope = safeMarker(value.verification_scope)
    if (scope !== undefined) result.verification_scope = scope
    const verification = value.verification
    if (verification !== null && typeof verification === 'object' && !Array.isArray(verification)) {
      const projected: Record<string, JsonValue> = {}
      const ok = Reflect.get(verification, 'ok')
      if (typeof ok === 'boolean') projected.ok = ok
      for (const key of ['status', 'code'] as const) {
        const marker = safeMarker(Reflect.get(verification, key))
        if (marker !== undefined) projected[key] = marker
      }
      for (const key of ['errorCount', 'warningCount', 'fileCount', 'sampleCount', 'secretCount'] as const) {
        const count = Reflect.get(verification, key)
        if (typeof count === 'number' && Number.isFinite(count)) projected[key] = Math.max(0, Math.min(1000000, Math.trunc(count)))
      }
      if (Object.keys(projected).length > 0) result.verification = projected
    }
    for (const key of ['errorCount', 'warningCount', 'fileCount', 'sampleCount', 'secretCount'] as const) {
      const count = value[key]
      if (typeof count === 'number' && Number.isFinite(count)) result[key] = Math.max(0, Math.min(1000000, Math.trunc(count)))
    }
    const stats = value.stats
    if (stats !== null && typeof stats === 'object' && !Array.isArray(stats)) {
      const projected: Record<string, JsonValue> = {}
      for (const [key, raw] of Object.entries(stats as Record<string, unknown>)) {
        if (!/count|files|entries|cases/i.test(key) || typeof raw !== 'number' || !Number.isFinite(raw)) continue
        projected[key] = Math.max(0, Math.min(1000000, Math.trunc(raw)))
      }
      if (Object.keys(projected).length > 0) result.stats = projected
    }
  }
  return result
}

async function packagePath(workspace: string, problemId: string): Promise<string> {
  const path = join(workspace, `${problemId}.zip`)
  let info
  try {
    info = await lstat(path)
  } catch {
    throw new Error(`generated package is missing for ${problemId}`)
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`generated package is not a regular file for ${problemId}`)
  }
  try {
    const [canonicalWorkspace, canonicalPath] = await Promise.all([realpath(workspace), realpath(path)])
    const canonicalParent = dirname(canonicalPath)
    if (canonicalParent !== canonicalWorkspace) throw new Error('package path escapes the canonical workspace')
    if (!(await stat(canonicalPath)).isFile()) throw new Error(`generated package is not a regular file for ${problemId}`)
    return canonicalPath
  } catch (error) {
    if (error instanceof Error && error.message === 'package path escapes the canonical workspace') throw error
    if (error instanceof Error && error.message.startsWith('generated package is not a regular file')) throw error
    throw new Error(`generated package path is not inside the canonical workspace for ${problemId}`)
  }
}

function registerOperation(
  ctx: Context,
  operation: CoreOperation,
  toolName: string,
  description: string,
  parameters: ParameterSchemaSpec,
  parse: (args: unknown) => ParsedOperation,
  command: string,
  maxOutputBytes: number,
): void {
  ctx.tools.register(defineTool({
    name: toolName,
    description,
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'background' },
          jobId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `started background ProbHub ${operation} job ${value.jobId}` }],
    },
    // Core writes caches, evidence, checkpoints, generations, or formal
    // artifacts. Keep them exclusive so sibling calls cannot race the Core
    // lock/state machine; read-only projections opt in separately below.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent: Agent | undefined = exec.agent
      if (agent === undefined) throw new Error(`${toolName} requires a calling agent`)
      const workspace = await resolveWorkspaceForSession(agent.session)
      const parsed = parse(args)
      const request: CoreJobRequest = {
        operation,
        session: agent.session,
        workspace: workspace.cwd,
        ...(parsed.problemId === undefined ? {} : { problemId: parsed.problemId }),
        ...(parsed.problemIds === undefined ? {} : { problemIds: parsed.problemIds }),
        ...(parsed.extra.length === 0 ? {} : { args: parsed.extra }),
      }
      const id = ctx.jobs.start({
        kind: 'probhub',
        label: `${operation}${parsed.problemIds !== undefined ? ` ${parsed.problemIds.join(',')}` : parsed.problemId === undefined ? '' : ` ${parsed.problemId}`}`,
        owner: agent,
        outputLimitBytes: maxOutputBytes,
        run: () => createCoreJobHooks(ctx, { command, maxOutputBytes }, request),
      })
      return { kind: 'background' as const, jobId: id }
    },
    presentCall: args => presentTitle(operation, args),
  }))
}

/** Registers ProbHub validation, delivery, and read-only projection tools. */
export function apply(ctx: Context, config: Config = {}): void {
  const command = config.command ?? DEFAULT_CORE_RUNNER_CONFIG.command
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_CORE_RUNNER_CONFIG.maxOutputBytes
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024) throw new Error('tool-probhub: maxOutputBytes must be a positive safe integer >= 1024')
  ctx.systemPrompt.section({
    name: 'tool:probhub',
    order: 107,
    text: 'Use ProbHub validation and delivery tools for explicit background work. Keep each returned job id, continue independent work, collect with job_output, and stop jobs that no longer matter. Write operations use the current workspace and the caller\'s already-authorized workspace-write policy.',
  })
  // A model-visible confirmation is necessary but not sufficient for formal
  // publication. When an approval service is mounted, this asks the human
  // through the normal DSH approval seam; without one, the shared tools
  // policy fails closed instead of silently publishing artifacts.
  ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
    if (exec.name === 'probhub_build') {
      return Promise.resolve({
        kind: 'ask',
        reason: 'Approval required: ProbHub formal build will publish PDF, ZIP, metadata, and Manifest artifacts for the current workspace.',
      })
    }
    return next()
  })
  registerOperation(
    ctx,
    'judge',
    'probhub_judge',
    'Run ProbHub local Judge for one Schema v1 problem in the background. The job uses workspace-write because Core may update caches and calibration evidence.',
    { problem_id: { type: 'string', required: true, description: 'Schema v1 problem id from the current workspace.' } },
    args => ({ problemId: validateProblemId((args as ProblemArgs).problem_id), extra: [] }),
    command,
    maxOutputBytes,
  )
  registerOperation(
    ctx,
    'stress',
    'probhub_stress',
    'Run ProbHub accepted-vs-brute stress testing for one Schema v1 problem in the background. Against/fixate and arbitrary paths are intentionally unavailable.',
    {
      problem_id: { type: 'string', required: true, description: 'Schema v1 problem id from the current workspace.' },
      rounds: { type: 'number', description: 'Optional positive stress round count.' },
      seed: { type: 'number', description: 'Optional deterministic stress master seed.' },
    },
    (args) => {
      const stress = args as StressArgs
      return { problemId: validateProblemId(stress.problem_id), extra: validateStress(stress) }
    },
    command,
    maxOutputBytes,
  )
  registerOperation(
    ctx,
    'judge-qa',
    'probhub_judge_qa',
    'Run ProbHub Judge QA fixtures for one Schema v1 problem in the background. The job uses workspace-write because Core may update QA evidence.',
    { problem_id: { type: 'string', required: true, description: 'Schema v1 problem id from the current workspace.' } },
    args => ({ problemId: validateProblemId((args as ProblemArgs).problem_id), extra: [] }),
    command,
    maxOutputBytes,
  )
  registerOperation(
    ctx,
    'mutation',
    'probhub_mutation',
    'Run bounded ProbHub mutation testing for one Schema v1 problem in the background. Only safe numeric budgets are accepted; arbitrary paths and operator expressions are unavailable.',
    {
      problem_id: { type: 'string', required: true, description: 'Schema v1 problem id from the current workspace.' },
      max_mutants: { type: 'number', description: 'Optional maximum mutation candidates (1-256).' },
      jobs: { type: 'number', description: 'Optional worker count (1 or 2).' },
      timeout: { type: 'number', description: 'Optional total timeout in seconds (1-3600).' },
    },
    (args) => {
      const value = args as ProblemArgs & { max_mutants?: number; jobs?: number; timeout?: number }
      const extra: string[] = []
      if (value.max_mutants !== undefined) {
        if (!Number.isSafeInteger(value.max_mutants) || value.max_mutants < 1 || value.max_mutants > 256) throw new Error('invalid max_mutants: expected an integer from 1 to 256')
        extra.push('--max-mutants', String(value.max_mutants))
      }
      if (value.jobs !== undefined) {
        if (value.jobs !== 1 && value.jobs !== 2) throw new Error('invalid jobs: expected 1 or 2')
        extra.push('--jobs', String(value.jobs))
      }
      if (value.timeout !== undefined) {
        if (!Number.isFinite(value.timeout) || value.timeout <= 0 || value.timeout > 3600) throw new Error('invalid timeout: expected a number from 1 to 3600 seconds')
        extra.push('--timeout', String(value.timeout))
      }
      return { problemId: validateProblemId(value.problem_id), extra }
    },
    command,
    maxOutputBytes,
  )
  registerOperation(
    ctx,
    'checkpoint',
    'probhub_checkpoint',
    'Create a ProbHub draft checkpoint for one Schema v1 problem in the background. The job writes only Core-managed checkpoint data under the current workspace.',
    { problem_id: { type: 'string', required: true, description: 'Schema v1 problem id from the current workspace.' } },
    args => ({ problemId: validateProblemId((args as ProblemArgs).problem_id), extra: [] }),
    command,
    maxOutputBytes,
  )
  registerOperation(
    ctx,
    'seal',
    'probhub_seal',
    'Validate and seal one Schema v1 problem in the background, then assemble its current preview generation. The job uses workspace-write and never publishes formal PDF or ZIP artifacts.',
    {
      problem_id: { type: 'string', required: true, description: 'Schema v1 problem id from the current workspace.' },
      rounds: { type: 'number', description: 'Optional positive stress round count.' },
      seed: { type: 'number', description: 'Optional deterministic stress master seed.' },
      no_cache: { type: 'boolean', description: 'Ignore existing Core caches for this seal.' },
    },
    (args) => {
      const value = args as ProblemArgs & { rounds?: number; seed?: number; no_cache?: boolean }
      const extra = validateStress(value)
      if (value.no_cache === true) extra.push('--no-cache')
      return { problemId: validateProblemId(value.problem_id), extra }
    },
    command,
    maxOutputBytes,
  )
  registerOperation(
    ctx,
    'assemble',
    'probhub_assemble',
    'Assemble the current ProbHub checkpoint generation in the background. It reads immutable checkpoints and writes only Core-managed preview generation data.',
    {},
    () => ({ extra: [] }),
    command,
    maxOutputBytes,
  )
  registerOperation(
    ctx,
    'build',
    'probhub_build',
    'Build one or more Schema v1 problem packages as one collection batch after Core verifies sealed revisions. Formal build and publication remain owned by ProbHub Core.',
    {
      problem_ids: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'One to 256 distinct Schema v1 problem ids from the current workspace; Core builds them as one collection batch.',
      },
      confirm: { type: 'boolean', required: true, const: true, description: 'Required explicit confirmation that formal PDF/ZIP/metadata publication is intended.' },
      no_cache: { type: 'boolean', description: 'Ignore existing Judge caches for this build.' },
    },
    (args) => {
      const value = args as { problem_ids?: unknown; confirm?: boolean; no_cache?: boolean }
      if (value.confirm !== true) throw new Error('probhub_build requires confirm: true for formal artifact publication')
      return {
        problemIds: validateProblemIds(value.problem_ids),
        extra: value.no_cache === true ? ['--no-cache'] : [],
      }
    },
    command,
    maxOutputBytes,
  )

  registerReadOperation(
    ctx,
    'generation-status',
    'probhub_generation_status',
    'Read the current ProbHub preview generation status for the current Session workspace. This operation is read-only and does not create or publish artifacts.',
    {},
    () => [],
    command,
    maxOutputBytes,
  )
  registerReadOperation(
    ctx,
    'report',
    'probhub_report',
    'Read a bounded ProbHub workspace report, optionally scoped to one Schema v1 problem. This operation is read-only.',
    { problem_id: { type: 'string', description: 'Optional Schema v1 problem id from the current workspace.' } },
    (args) => {
      const value = args as Partial<ProblemArgs>
      return value.problem_id === undefined ? [] : [validateProblemId(value.problem_id)]
    },
    command,
    maxOutputBytes,
  )
  registerReadOperation(
    ctx,
    'verify-package',
    'probhub_verify_package',
    'Verify the generated ZIP for one Schema v1 problem using the canonical workspace path. The tool derives the ZIP path and never accepts an arbitrary path.',
    { problem_id: { type: 'string', required: true, description: 'Schema v1 problem id whose generated ZIP should be verified.' } },
    args => [validateProblemId((args as ProblemArgs).problem_id)],
    command,
    maxOutputBytes,
  )
}

function registerReadOperation(
  ctx: Context,
  operation: 'generation-status' | 'report' | 'verify-package',
  toolName: string,
  description: string,
  parameters: ParameterSchemaSpec,
  parse: (args: unknown) => readonly string[],
  command: string,
  maxOutputBytes: number,
): void {
  ctx.tools.register(defineTool({
    name: toolName,
    description,
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean', required: true } },
      },
      render: jsonResult,
    },
    // These commands only project bounded Core state; they do not publish
    // artifacts and may safely overlap with one another.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent: Agent | undefined = exec.agent
      if (agent === undefined) throw new Error(`${toolName} requires a calling agent`)
      const workspace = await resolveWorkspaceForSession(agent.session)
      const parsed = parse(args)
      let extra: readonly string[] = parsed
      if (operation === 'verify-package') {
        const problemId = parsed[0]
        if (problemId === undefined) throw new Error(`${toolName} requires a problem id`)
        extra = [await packagePath(workspace.cwd, problemId), '--require-pdf', '--problem', problemId]
      }
      const result = await runCore(
        ctx,
        { command, maxOutputBytes },
        workspace.cwd,
        operation,
        extra,
        agent.session,
        exec.signal,
      )
      if (!result.adapterOk) throw new Error(result.error ?? 'ProbHub Core is unavailable')
      return isCoreObject(result.value) ? projectReadValue(operation, result.value) : { ok: false, code: 'core_invalid_result' }
    },
    presentCall: args => presentTitle(operation, args),
  }))
}

function isCoreObject(value: unknown): value is { ok: boolean } & Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof Reflect.get(value, 'ok') === 'boolean'
}
