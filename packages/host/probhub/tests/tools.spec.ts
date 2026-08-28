import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CallId } from '@deepseek-ai/dsh-llm'
import * as tools from '../src/tools.ts'

interface Spawned {
  argv: readonly string[]
  env?: NodeJS.ProcessEnv
  terminate: () => void
  done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
  waitForExit: () => Promise<boolean>
  collected: { stdout: { readFrom: (offset: number) => { text: string; nextOffset: number; lossy: boolean } } }
  finish?: (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
}

const contexts: Context[] = []
const workspaces: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true })
})

async function setup(
  output = JSON.stringify({ ok: true, code: 'all_expectations_met' }),
  mode: 'workspace-write' | 'read-only' = 'workspace-write',
  finishOnSpawn = false,
) {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-probhub-tools-'))
  workspaces.push(workspace)
  mkdirSync(join(workspace, '.probhub'))
  writeFileSync(join(workspace, '.probhub', 'workspace.yaml'), 'schema_version: 1\nproblems: []\n')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('probhub-test')
  const session = Session.create(SessionId('probhub-owner'), [], { version: 0, id: SessionId('probhub-owner'), createdAt: 0, cwd: workspace })
  const agent = { id: session.id, session, status: 'idle', ctx } as never
  ctx.agents.register(agent)
  const spawned: Spawned[] = []
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode, workspaceRoot: workspace }) } as never)
  ctx.provide('sandbox', { confine: (argv: readonly string[]) => ({ argv, enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }) } as never)
  ctx.provide('subprocess', {
    spawn: (spec: Spawned) => {
      let finish!: (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
      const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => { finish = resolve })
      const handle = {
        argv: spec.argv,
        env: spec.env,
        done,
        terminate: () => finish({ exitCode: null, signal: 'SIGTERM' }),
        waitForExit: async () => true,
        collected: { stdout: { readFrom: () => ({ text: output, nextOffset: Buffer.byteLength(output), lossy: false }) } },
        finish,
      } as unknown as Spawned
      spawned.push(handle)
      if (finishOnSpawn) queueMicrotask(() => finish({ exitCode: 0, signal: null }))
      return handle
    },
  } as never)
  await ctx.plugin(tools, { command: '/usr/bin/probhub', maxOutputBytes: 4096 })
  return { ctx, session, agent, spawned }
}

describe('ProbHub background tools', () => {
  it('registers all four operations and starts a workspace-write job with restricted argv', async () => {
    const { ctx, agent, spawned } = await setup()
    for (const name of ['probhub_judge', 'probhub_stress', 'probhub_judge_qa', 'probhub_mutation']) expect(ctx.tools.get(name)).toBeDefined()
    const result = await ctx.tools.execute({
      signal: new AbortController().signal, callId: CallId('probhub-start'), name: 'probhub_stress',
      arguments: { problem_id: 'A01', rounds: 4, seed: 7 }, agent,
    })
    if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join(' '))
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ kind: 'background', jobId: 'probhub-1' })
    expect(spawned[0]?.argv).toEqual(expect.arrayContaining(['--json', 'stress', 'A01', '--rounds', '4', '--seed', '7']))
    expect(spawned[0]?.argv).not.toEqual(expect.arrayContaining(['--against']))
    spawned[0]!.finish!({ exitCode: 0, signal: null })
    await ctx.jobs.wait('probhub-1' as never, 1000, agent)
    expect(ctx.jobs.read('probhub-1' as never, agent).text).toContain('all_expectations_met')
  })

  it('maps non-success Core JSON to a failed job and preserves the bounded diagnostic', async () => {
    const { ctx, agent } = await setup(
      JSON.stringify({
        ok: false,
        problems: { A01: { ok: false, final: { status: 'failed', code: 'judge_timeout' } } },
      }),
      'workspace-write',
      true,
    )
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('core-failed'),
      name: 'probhub_judge',
      arguments: { problem_id: 'A01' },
      agent,
    })
    if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join(' '))
    const id = (result.value as { jobId: string }).jobId as never
    const snapshot = await ctx.jobs.wait(id, 1000, agent)
    expect(snapshot).toMatchObject({ status: 'failed', detail: 'judge_timeout' })
    expect(ctx.jobs.read(id, agent).text).toContain('judge_timeout')
  })

  it('gives cleanup failure precedence over a Core cancellation result', async () => {
    const { ctx, agent } = await setup(
      JSON.stringify({ ok: false, status: 'cancelled', code: 'process_cleanup_failed' }),
      'workspace-write',
      true,
    )
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('core-cleanup-failed'),
      name: 'probhub_judge',
      arguments: { problem_id: 'A01' },
      agent,
    })
    if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join(' '))
    const id = (result.value as { jobId: string }).jobId as never
    await expect(ctx.jobs.wait(id, 1000, agent)).resolves.toMatchObject({ status: 'failed', detail: 'cleanup_failed' })
  })

  it('rejects invalid IDs and refuses a read-only session without starting a process', async () => {
    const { ctx, agent, spawned } = await setup(undefined, 'read-only')
    await expect(ctx.tools.execute({ signal: new AbortController().signal, callId: CallId('read-only'), name: 'probhub_judge', arguments: { problem_id: 'A01' }, agent })).resolves.toMatchObject({ isError: true })
    await expect(ctx.tools.execute({ signal: new AbortController().signal, callId: CallId('bad-id'), name: 'probhub_judge', arguments: { problem_id: '../x' }, agent })).resolves.toMatchObject({ isError: true })
    expect(spawned).toHaveLength(0)
  })

  it('maps cancellation to killed and keeps cancellation idempotent', async () => {
    const { ctx, agent, spawned } = await setup(undefined, 'workspace-write', false)
    const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: CallId('cancel'), name: 'probhub_judge', arguments: { problem_id: 'A01' }, agent })
    if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join(' '))
    const id = (result.value as { jobId: string }).jobId as never
    expect(ctx.jobs.kill(id, agent, 'user')).toBe('requested')
    expect(ctx.jobs.kill(id, agent, 'user')).toBe('requested')
    expect(spawned[0]).toBeDefined()
    const snapshot = await ctx.jobs.wait(id, 1000, agent)
    expect(snapshot.status).toBe('killed')
  })
})
