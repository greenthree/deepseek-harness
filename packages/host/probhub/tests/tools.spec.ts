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
import type { ProbHubTab, ProbHubTabRequestReason } from '@deepseek-ai/dsh-api-remotes/types'
import * as tools from '../src/tools.ts'
import { emitProbHubTabRequest } from '../src/index.ts'

interface Spawned {
  argv: readonly string[]
  env?: NodeJS.ProcessEnv
  terminate: () => void
  done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
  waitForExit: () => Promise<boolean>
  collected: { stdout: { readFrom: (offset: number) => { text: string; nextOffset: number; lossy: boolean } } }
  finish?: (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
}

type TestCoreOutput = string | ((argv: readonly string[]) => string)

// Compile-time contract: event arguments stay branded/stable at the Host
// emission seam instead of degrading to an anonymous `unknown[]` tuple.
function probHubNavigationEventTypes(ctx: Context): void {
  ctx.on('probhub/tab-requested', (sessionId, problemId, tab, reason, source) => {
    const tabs: ProbHubTab[] = ['statement', 'health', 'pdf']
    const reasons: ProbHubTabRequestReason[] = ['ai-suggestion', 'tool-result']
    void sessionId; void problemId; void source; void tabs; void reasons
    // @ts-expect-error -- unknown tab keys must not enter the typed event.
    const invalid: ProbHubTab = 'other'
    void invalid
    // @ts-expect-error -- arbitrary event reasons are not accepted.
    const invalidReason: ProbHubTabRequestReason = 'other'
    void invalidReason
    void tab; void reason
  })
}
void probHubNavigationEventTypes

const contexts: Context[] = []
const workspaces: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true })
})

async function setup(
  output: TestCoreOutput = JSON.stringify({ ok: true, code: 'all_expectations_met' }),
  mode: 'workspace-write' | 'read-only' = 'workspace-write',
  finishOnSpawn = false,
  waitForExitReject = false,
  terminateReject = false,
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
        terminate: () => {
          if (terminateReject) throw new Error('terminate failed')
          finish({ exitCode: null, signal: 'SIGTERM' })
        },
        waitForExit: async () => {
          if (waitForExitReject) throw new Error('tree probe failed')
          return true
        },
        collected: { stdout: { readFrom: () => {
          const text = typeof output === 'function' ? output(spec.argv) : output
          return { text, nextOffset: Buffer.byteLength(text), lossy: false }
        } } },
        finish,
      } as unknown as Spawned
      spawned.push(handle)
      if (finishOnSpawn) queueMicrotask(() => { finish({ exitCode: 0, signal: null }) })
      return handle
    },
  } as never)
  await ctx.plugin(tools, { command: '/usr/bin/probhub', maxOutputBytes: 4096 })
  return { ctx, session, agent, spawned, workspace }
}

describe('ProbHub background tools', () => {
  it('registers all four operations and starts a workspace-write job with restricted argv', async () => {
    const { ctx, agent, spawned } = await setup()
    const navigation: unknown[][] = []
    ctx.on('probhub/tab-requested', (...args) => { navigation.push(args) })
    for (const name of ['probhub_judge', 'probhub_stress', 'probhub_judge_qa', 'probhub_mutation']) expect(ctx.tools.get(name)).toBeDefined()
    const result = await ctx.tools.execute({
      signal: new AbortController().signal, callId: CallId('probhub-start'), name: 'probhub_stress',
      arguments: { problem_id: 'A01', rounds: 4, seed: 7 }, agent,
    })
    if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join(' '))
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ kind: 'background', jobId: 'probhub-1' })
    expect(navigation).toEqual([['probhub-owner', 'A01', 'health', 'tool-result', 'probhub_stress']])
    expect(spawned[0]?.argv).toEqual(expect.arrayContaining(['--json', 'stress', 'A01', '--rounds', '4', '--seed', '7']))
    expect(spawned[0]?.argv).not.toEqual(expect.arrayContaining(['--against']))
    spawned[0]!.finish!({ exitCode: 0, signal: null })
    await ctx.jobs.wait('probhub-1' as never, 1000, agent)
    expect(ctx.jobs.read('probhub-1' as never, agent).text).toContain('all_expectations_met')
  })

  it('does not publish navigation for an absent agent, stale agent, or invalid problem id', async () => {
    const { ctx, agent } = await setup()
    const navigation: unknown[][] = []
    ctx.on('probhub/tab-requested', (...args) => { navigation.push(args) })
    expect(emitProbHubTabRequest(ctx, agent, 'A01', 'statement', 'ai-suggestion')).toBe(true)
    expect(navigation).toEqual([['probhub-owner', 'A01', 'statement', 'ai-suggestion']])
    navigation.length = 0
    expect(emitProbHubTabRequest(ctx, undefined, 'A01', 'health', 'ai-suggestion')).toBe(false)
    expect(emitProbHubTabRequest(ctx, agent, '../escape', 'health', 'ai-suggestion')).toBe(false)
    expect(emitProbHubTabRequest(ctx, agent, 'A01', 'unknown' as never, 'ai-suggestion')).toBe(false)
    expect(emitProbHubTabRequest(ctx, agent, 'A01', 'health', 'unknown' as never)).toBe(false)
    const stale = { id: 'other-session', session: (agent as { session: unknown }).session } as never
    expect(emitProbHubTabRequest(ctx, stale, 'A01', 'health', 'ai-suggestion')).toBe(false)
    expect(emitProbHubTabRequest(ctx, agent, 'A01', 'health', 'ai-suggestion', 'bad source/')).toBe(false)
    expect(navigation).toEqual([])
    const fakeTool = await ctx.tools.execute({
      signal: new AbortController().signal, callId: CallId('fake-probhub-tool'), name: 'probhub_fake',
      arguments: { problem_id: 'A01' }, agent,
    })
    expect(fakeTool.isError).toBe(true)
    expect(navigation).toEqual([])
  })

  it('keeps a successful tool result when a navigation listener throws', async () => {
    const { ctx, agent, spawned } = await setup()
    ctx.on('probhub/tab-requested', () => { throw new Error('UI listener failed') })
    const result = await ctx.tools.execute({
      signal: new AbortController().signal, callId: CallId('listener-failed'), name: 'probhub_judge',
      arguments: { problem_id: 'A01' }, agent,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ kind: 'background', jobId: 'probhub-1' })
    spawned[0]!.finish!({ exitCode: 0, signal: null })
    await expect(ctx.jobs.wait('probhub-1' as never, 1000, agent)).resolves.toMatchObject({ status: 'completed' })
  })

  it('does not navigate on a structured Core business failure returned by a read-only tool', async () => {
    const { ctx, agent } = await setup(JSON.stringify({ ok: false, status: 'stale' }), 'read-only', true)
    const navigation: unknown[][] = []
    ctx.on('probhub/tab-requested', (...args) => { navigation.push(args) })
    const result = await ctx.tools.execute({
      signal: new AbortController().signal, callId: CallId('report-stale'), name: 'probhub_report',
      arguments: { problem_id: 'A01' }, agent,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ ok: false })
    expect(navigation).toEqual([])
  })

  it('does not treat an unrelated probhub-prefixed tool as a navigation source', async () => {
    const { ctx, agent } = await setup()
    const navigation: unknown[][] = []
    ctx.on('probhub/tab-requested', (...args) => { navigation.push(args) })
    ctx.tools.register({
      name: 'probhub_fake',
      description: 'test-only unrelated tool',
      parameters: { problem_id: { type: 'string' } },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, render: () => [] },
      async execute() { return { ok: true } },
    } as never)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal, callId: CallId('fake-navigation'), name: 'probhub_fake',
      arguments: { problem_id: 'A01' }, agent,
    })
    expect(result.isError).toBe(false)
    expect(navigation).toEqual([])
  })

  it('registers delivery jobs and read-only delivery queries', async () => {
    const { ctx, agent, spawned, workspace } = await setup(undefined, 'read-only', true)
    for (const name of [
      'probhub_checkpoint',
      'probhub_seal',
      'probhub_assemble',
      'probhub_build',
      'probhub_generation_status',
      'probhub_report',
      'probhub_verify_package',
      'probhub_delivery_check',
    ]) expect(ctx.tools.get(name)).toBeDefined()

    const status = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('generation-status'),
      name: 'probhub_generation_status',
      arguments: {},
      agent,
    })
    expect(status.isError).toBe(false)
    expect(spawned[0]?.argv).toEqual(expect.arrayContaining(['--json', 'generation-status']))

    writeFileSync(join(workspace, 'A01.zip'), 'not a real archive')
    const verify = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('verify-package'),
      name: 'probhub_verify_package',
      arguments: { problem_id: 'A01' },
      agent,
    })
    expect(verify.isError).toBe(false)
    expect(spawned[1]?.argv).toEqual(expect.arrayContaining([
      '--json', 'verify-package', join(workspace, 'A01.zip'), '--require-pdf', '--problem', 'A01',
    ]))
    expect(ctx.tools.get('probhub_build')?.isConcurrencySafe?.({ problem_ids: ['A01'], confirm: true })).toBe(false)
    expect(ctx.tools.get('probhub_generation_status')?.isConcurrencySafe?.({})).toBe(true)
  })

  it('bounds stress inputs and requires explicit build confirmation plus approval', async () => {
    const { ctx, agent, spawned } = await setup(undefined, 'workspace-write')
    await expect(ctx.tools.execute({
      signal: new AbortController().signal, callId: CallId('negative-seed'), name: 'probhub_stress',
      arguments: { problem_id: 'A01', seed: -1 }, agent,
    })).resolves.toMatchObject({ isError: true })
    await expect(ctx.tools.execute({
      signal: new AbortController().signal, callId: CallId('too-many-rounds'), name: 'probhub_stress',
      arguments: { problem_id: 'A01', rounds: 1_000_001 }, agent,
    })).resolves.toMatchObject({ isError: true })
    await expect(ctx.tools.execute({
      signal: new AbortController().signal, callId: CallId('build-no-confirm'), name: 'probhub_build',
      arguments: {}, agent,
    })).resolves.toMatchObject({ isError: true })
    const buildResult = await ctx.tools.execute({
      signal: new AbortController().signal, callId: CallId('build-confirmed'), name: 'probhub_build',
      arguments: { problem_ids: ['A01'], confirm: true }, agent,
    })
    expect(buildResult.isError).toBe(true)
    const buildText = buildResult.content[0]?.type === 'text' ? buildResult.content[0].text : ''
    expect(buildText).toContain('Approval')
    expect(spawned).toHaveLength(0)
  })

  it('starts a confirmed build only after the normal approval seam allows it', async () => {
    const gateOutput: TestCoreOutput = (argv) => {
      if (argv.includes('generation-status')) return JSON.stringify({
        ok: true,
        generation_id: 'gen-1',
        state: 'sealed-preview',
        manifest: {
          complete: true,
          all_sealed: true,
          missing: [],
          problems: [
            { problem_id: 'A01', state: 'sealed', revision_id: 'sealed-a', source_hash: 'source-a', data_hash: 'data-a' },
            { problem_id: 'B02', state: 'sealed', revision_id: 'sealed-b', source_hash: 'source-b', data_hash: 'data-b' },
          ],
        },
      })
      if (argv.includes('status')) return JSON.stringify({
        ok: true,
        problems: {
          A01: { state: 'current', source_hash: 'source-a', data_hash: 'data-a' },
          B02: { state: 'current', source_hash: 'source-b', data_hash: 'data-b' },
        },
      })
      if (argv.includes('report')) return JSON.stringify({
        ok: true,
        problems: [{ id: 'A01', calibration: { state: 'current' } }, { id: 'B02', calibration: { state: 'current' } }],
      })
      return JSON.stringify({ ok: true, verification: { ok: true } })
    }
    const { ctx, agent, spawned } = await setup(gateOutput, 'workspace-write', true)
    ctx.provide('approval', { request: async () => 'allowed-once' } as never)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('build-approved'),
      name: 'probhub_build',
      arguments: { problem_ids: ['A01', 'B02'], confirm: true },
      agent,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ kind: 'background', jobId: 'probhub-1' })
    expect(spawned.at(-1)?.argv).toEqual(expect.arrayContaining(['--json', 'build', 'A01', 'B02']))
    spawned.at(-1)!.finish!({ exitCode: 0, signal: null })
    await expect(ctx.jobs.wait('probhub-1' as never, 1000, agent)).resolves.toMatchObject({ status: 'completed' })
  })

  it('keeps delivery state in bounded job output without exposing paths', async () => {
    const output = JSON.stringify({
      ok: true,
      checkpoint: { problem_id: 'A01', revision_id: 'rev-1', state: 'sealed', source_hash: 'a'.repeat(64), data_hash: 'b'.repeat(64), path: 'C:/private' },
      generation: { generation_id: 'gen-1', state: 'sealed-preview', complete: false, all_sealed: false, missing: [{ problem_id: 'B02', reason: 'no checkpoint' }], path: 'C:/private' },
      batch_id: 'batch-1',
    })
    const { ctx, agent, spawned } = await setup(output, 'workspace-write', true)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal, callId: CallId('checkpoint-output'), name: 'probhub_checkpoint',
      arguments: { problem_id: 'A01' }, agent,
    })
    if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join(' '))
    spawned[0]!.finish!({ exitCode: 0, signal: null })
    await ctx.jobs.wait('probhub-1' as never, 1000, agent)
    const text = ctx.jobs.read('probhub-1' as never, agent).text
    expect(text).toContain('revision_id')
    expect(text).toContain('sealed')
    expect(text).not.toContain('C:/private')
  })

  it('projects read-only generation and package results without raw paths', async () => {
    const output = JSON.stringify({
      ok: true,
      generation_id: 'gen-1',
      state: 'draft',
      manifest: { complete: false, all_sealed: false, missing: [{ problem_id: 'B02', reason: 'no checkpoint' }], path: 'C:/private' },
      verification_scope: 'deep',
      stats: { sample_cases: 3, secret_cases: 7, files: 12 },
      path: 'C:/private',
    })
    const { ctx, agent, spawned, workspace } = await setup(output, 'read-only', true)
    const status = await ctx.tools.execute({
      signal: new AbortController().signal, callId: CallId('project-generation'),
      name: 'probhub_generation_status', arguments: {}, agent,
    })
    expect(status.isError).toBe(false)
    const statusValue = status.value as { generation?: { complete?: boolean; missing?: unknown[] } }
    expect(statusValue.generation).toMatchObject({ complete: false, missing: [{ problem_id: 'B02', reason: 'no checkpoint' }] })
    expect(JSON.stringify(statusValue)).not.toContain('C:/private')

    writeFileSync(join(workspace, 'A01.zip'), 'not a real archive')
    const verify = await ctx.tools.execute({
      signal: new AbortController().signal, callId: CallId('project-package'),
      name: 'probhub_verify_package', arguments: { problem_id: 'A01' }, agent,
    })
    expect(verify.isError).toBe(false)
    expect(verify.value).toMatchObject({ verification_scope: 'deep', stats: { sample_cases: 3, secret_cases: 7, files: 12 } })
    expect(JSON.stringify(verify.value)).not.toContain('C:/private')
    expect(spawned).toHaveLength(2)
  })

  it('exposes the formal delivery gate as a bounded read-only tool', async () => {
    const output: TestCoreOutput = (argv) => {
      if (argv.includes('generation-status')) return JSON.stringify({
        ok: true,
        generation_id: 'gen-1',
        state: 'sealed-preview',
        manifest: {
          complete: true,
          all_sealed: true,
          missing: [],
          problems: [{ problem_id: 'A01', state: 'sealed', revision_id: 'sealed-a', source_hash: 'source-a', data_hash: 'data-a' }],
        },
      })
      if (argv.includes('status')) return JSON.stringify({ ok: true, problems: { A01: { state: 'current', source_hash: 'source-a', data_hash: 'data-a' } } })
      if (argv.includes('report')) return JSON.stringify({ ok: true, problems: [{ id: 'A01', calibration: { state: 'current' } }] })
      return JSON.stringify({ ok: true, verification: { ok: true } })
    }
    const { ctx, agent } = await setup(output, 'workspace-write', true)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('delivery-check'),
      name: 'probhub_delivery_check',
      arguments: { problem_ids: ['A01'] },
      agent,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ ok: true, state: 'ready', problemIds: ['A01'] })
    expect(JSON.stringify(result.value)).not.toContain('C:/')
  })

  it('blocks a package whose nested verification result is false', async () => {
    const output: TestCoreOutput = (argv) => {
      if (argv.includes('generation-status')) return JSON.stringify({
        ok: true,
        generation_id: 'gen-1',
        state: 'sealed-preview',
        manifest: {
          complete: true,
          all_sealed: true,
          missing: [],
          problems: [{ problem_id: 'A01', state: 'sealed', revision_id: 'sealed-a', source_hash: 'source-a', data_hash: 'data-a' }],
        },
      })
      if (argv.includes('status')) return JSON.stringify({ ok: true, problems: { A01: { state: 'current', source_hash: 'source-a', data_hash: 'data-a' } } })
      if (argv.includes('report')) return JSON.stringify({ ok: true, problems: [{ id: 'A01', calibration: { state: 'current' } }] })
      return JSON.stringify({ ok: true, verification: { ok: false, code: 'zip_invalid' } })
    }
    const { ctx, agent, spawned, workspace } = await setup(output, 'workspace-write', true)
    ctx.provide('approval', { request: async () => 'allowed-once' } as never)
    writeFileSync(join(workspace, 'A01.zip'), 'invalid')
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('nested-verification-failed'),
      name: 'probhub_build',
      arguments: { problem_ids: ['A01'], confirm: true },
      agent,
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toContain('package_verify_failed')
    expect(spawned).toHaveLength(4)
  })

  it('rejects a missing generated package before starting Core', async () => {
    const { ctx, agent, spawned } = await setup(undefined, 'read-only', true)
    await expect(ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('missing-package'),
      name: 'probhub_verify_package',
      arguments: { problem_id: 'A01' },
      agent,
    })).resolves.toMatchObject({ isError: true })
    expect(spawned).toHaveLength(0)
  })

  it('rejects a generated package directory before starting Core', async () => {
    const { ctx, agent, spawned, workspace } = await setup(undefined, 'read-only', true)
    mkdirSync(join(workspace, 'A01.zip'))
    await expect(ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('directory-package'),
      name: 'probhub_verify_package',
      arguments: { problem_id: 'A01' },
      agent,
    })).resolves.toMatchObject({ isError: true })
    expect(spawned).toHaveLength(0)
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

  it('parses a structured Core business failure even when the CLI exits nonzero', async () => {
    const { ctx, agent, spawned } = await setup(
      JSON.stringify({ ok: false, status: 'counterexample', code: 'stress_failed' }),
      'workspace-write',
      true,
    )
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('core-business-failed'),
      name: 'probhub_stress',
      arguments: { problem_id: 'A01' },
      agent,
    })
    if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join(' '))
    const id = (result.value as { jobId: string }).jobId as never
    spawned[0]!.finish!({ exitCode: 1, signal: null })
    await expect(ctx.jobs.wait(id, 1000, agent)).resolves.toMatchObject({ status: 'failed', detail: 'stress_failed' })
    expect(ctx.jobs.read(id, agent).text).toContain('stress_failed')
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

  it('maps a rejected tree cleanup probe to cleanup_failed', async () => {
    const { ctx, agent } = await setup(undefined, 'workspace-write', true, true)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('tree-cleanup-rejected'),
      name: 'probhub_judge',
      arguments: { problem_id: 'A01' },
      agent,
    })
    if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join(' '))
    const id = (result.value as { jobId: string }).jobId as never
    await expect(ctx.jobs.wait(id, 1000, agent)).resolves.toMatchObject({ status: 'failed', detail: 'cleanup_failed' })
  })

  it('does not turn a failed cancellation request into a killed outcome', async () => {
    const { ctx, agent, spawned } = await setup(undefined, 'workspace-write', false, false, true)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('cancel-request-failed'),
      name: 'probhub_judge',
      arguments: { problem_id: 'A01' },
      agent,
    })
    if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join(' '))
    const id = (result.value as { jobId: string }).jobId as never
    expect(ctx.jobs.kill(id, agent, 'user')).toBe('requested')
    spawned[0]!.finish!({ exitCode: null, signal: 'SIGTERM' })
    await expect(ctx.jobs.wait(id, 1000, agent)).resolves.toMatchObject({ status: 'failed', detail: 'cancel_request_failed' })
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
