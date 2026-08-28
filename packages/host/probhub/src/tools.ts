/** Model-facing background validation tools over the shared ProbHub Core runner. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  createCoreJobHooks,
  DEFAULT_CORE_RUNNER_CONFIG,
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

const PROBLEM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

function validateProblemId(value: string): string {
  if (!PROBLEM_ID.test(value)) throw new Error('invalid problem_id: expected a Schema v1 problem id')
  return value
}

function validateStress(args: StressArgs): readonly string[] {
  const values: string[] = []
  if (args.rounds !== undefined) {
    if (!Number.isSafeInteger(args.rounds) || args.rounds <= 0) throw new Error('invalid rounds: expected a positive integer')
    values.push('--rounds', String(args.rounds))
  }
  if (args.seed !== undefined) {
    if (!Number.isSafeInteger(args.seed)) throw new Error('invalid seed: expected a safe integer')
    values.push('--seed', String(args.seed))
  }
  return values
}

function present(title: string): GenericCallView {
  return { card: 'generic', title, kind: 'execute' }
}

function registerOperation(
  ctx: Context,
  operation: CoreOperation,
  toolName: string,
  description: string,
  parameters: ParameterSchemaSpec,
  parse: (args: unknown) => { problemId: string; extra: readonly string[] },
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
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent: Agent | undefined = exec.agent
      if (agent === undefined) throw new Error(`${toolName} requires a calling agent`)
      const workspace = await resolveWorkspaceForSession(agent.session)
      const parsed = parse(args)
      const request: CoreJobRequest = {
        operation,
        problemId: parsed.problemId,
        session: agent.session,
        workspace: workspace.cwd,
        args: parsed.extra,
      }
      const id = ctx.jobs.start({
        kind: 'probhub',
        label: `${operation} ${parsed.problemId}`,
        owner: agent,
        outputLimitBytes: maxOutputBytes,
        run: () => createCoreJobHooks(ctx, { command, maxOutputBytes }, request),
      })
      return { kind: 'background' as const, jobId: id }
    },
    presentCall: args => present(`${operation} ${typeof args === 'object' && args !== null && 'problem_id' in args ? String((args as { problem_id: unknown }).problem_id) : ''}`),
  }))
}

/** Registers the initial judge/stress vertical slice over the generic job registry. */
export function apply(ctx: Context, config: Config = {}): void {
  const command = config.command ?? DEFAULT_CORE_RUNNER_CONFIG.command
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_CORE_RUNNER_CONFIG.maxOutputBytes
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024) throw new Error('tool-probhub: maxOutputBytes must be a positive safe integer >= 1024')
  ctx.systemPrompt.section({
    name: 'tool:probhub',
    order: 107,
    text: 'Use probhub_judge or probhub_stress for explicit background validation. Keep the returned job id, continue independent work, collect with job_output, and stop jobs that no longer matter. These operations may write Core caches, evidence, or stress diagnostics under the current workspace.',
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
        if (!Number.isFinite(value.timeout) || value.timeout <= 0 || value.timeout > 3600) throw new Error('invalid timeout: expected a number from 0 to 3600 seconds')
        extra.push('--timeout', String(value.timeout))
      }
      return { problemId: validateProblemId(value.problem_id), extra }
    },
    command,
    maxOutputBytes,
  )
}
