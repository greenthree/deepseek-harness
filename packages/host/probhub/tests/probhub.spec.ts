import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as probhub from '../src/index.ts'
import { type Config, PROBHUB_API_PATH, PROBHUB_PATH } from '../src/index.ts'

const { apply } = probhub

interface FakeRequest { method: string; url: string; body?: string; [Symbol.asyncIterator]?: () => AsyncIterator<Buffer> }
interface FakeResponse {
  req: FakeRequest
  status: number
  headers: Record<string, string>
  writeHead: (status: number, headers: Record<string, string>) => void
  end: (value?: string) => void
}
interface CapturedRoute { handler: (req: FakeRequest, res: FakeResponse) => Promise<void> | void }
interface SpawnSpec { argv: readonly string[] }
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function response(method = 'GET'): { response: FakeResponse; body: () => string } {
  let output = ''
  const response = {
    req: { method, url: '' },
    writeHead: (status: number, headers: Record<string, string>) => { response.status = status; response.headers = headers },
    end: (value?: string) => { output = value ?? '' },
    status: 0,
    headers: {} as Record<string, string>,
  }
  return { response, body: () => output }
}

function request(method: string, url: string, body?: string): FakeRequest {
  const value: FakeRequest = { method, url, ...(body === undefined ? {} : { body }) }
  if (body !== undefined) {
    value[Symbol.asyncIterator] = async function* () { yield Buffer.from(body, 'utf8') }
  }
  return value
}

async function mount(config?: Partial<Config>): Promise<{ ctx: Context; route: CapturedRoute }> {
  const ctx = new Context()
  contexts.push(ctx)
  let captured!: CapturedRoute
  ctx.provide('webServer', { register: (value: CapturedRoute) => { captured = value; return () => {} } } as never)
  await ctx.plugin({ inject: ['webServer'], apply: (inner: Context) => { apply(inner, config) } })
  return { ctx, route: captured }
}

describe('host ProbHub bridge', () => {
  it('preserves its namespace plugin contract through the real Loader unwrap path', () => {
    expect('default' in probhub).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(probhub) as Record<string, unknown>
    expect(unwrapped).toBe(probhub)
    expect(unwrapped.name).toBe('host-probhub')
    expect(unwrapped.inject).toEqual(['webServer'])
    expect(typeof unwrapped.Config).toBe('function')
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('registers the independent namespace and answers its root without Core', async () => {
    const { route } = await mount()
    expect(route).toBeDefined()
    const { response: res, body } = response()
    await route.handler({ method: 'GET', url: PROBHUB_PATH }, res)
    expect(res.status).toBe(200)
    expect(JSON.parse(body())).toEqual({ ok: true, state: 'ready' })
  })

  it('starts only allowlisted non-publishing delivery jobs for the live Session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-probhub-delivery-job-'))
    mkdirSync(join(root, '.probhub'))
    mkdirSync(join(root, 'A01'), { recursive: true })
    writeFileSync(join(root, '.probhub', 'workspace.yaml'), 'schema_version: 1\nproblems: [A01]\n')
    try {
      const { ctx, route } = await mount()
      const sessionId = 'delivery-session'
      const attached = { id: sessionId, header: { cwd: root } }
      const agent = { id: sessionId, session: attached }
      let started: { kind: string; label: string; run: () => unknown } | undefined
      let killed = ''
      ctx.provide('sessions', { get: (id: string) => id === sessionId ? attached : undefined } as never)
      ctx.provide('agents', { get: (id: string) => id === sessionId ? agent : undefined } as never)
      ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) } as never)
      ctx.provide('jobs', {
        start: (spec: { kind: string; label: string; run: () => unknown }) => { started = spec; return 'probhub-1' },
        kill: (id: { toString: () => string }) => { killed = id.toString(); return 'requested' },
      } as never)

      const seal = response('POST')
      await route.handler(request('POST', `${PROBHUB_API_PATH}/jobs?sessionId=${sessionId}&problemId=A01`, JSON.stringify({ operation: 'seal', noCache: true })), seal.response)
      expect(seal.response.status).toBe(200)
      expect(JSON.parse(seal.body())).toMatchObject({ ok: true, job: { id: 'probhub-1', operation: 'seal', problemId: 'A01' } })
      expect(started).toMatchObject({ kind: 'probhub', label: 'seal A01' })

      const invalid = response('POST')
      await route.handler(request('POST', `${PROBHUB_API_PATH}/jobs?sessionId=${sessionId}&problemId=A01`, JSON.stringify({ operation: 'build' })), invalid.response)
      expect(invalid.response.status).toBe(400)
      expect(JSON.parse(invalid.body())).toMatchObject({ ok: false, code: 'job_operation_invalid' })

      const cancelled = response('POST')
      await route.handler(request('POST', `${PROBHUB_API_PATH}/jobs/cancel?sessionId=${sessionId}&jobId=probhub-1`), cancelled.response)
      expect(cancelled.response.status).toBe(200)
      expect(JSON.parse(cancelled.body())).toMatchObject({ ok: true, cancelled: true })
      expect(killed).toBe('probhub-1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports missing shared subprocess capability on health', async () => {
    const { route } = await mount()
    const { response: res, body } = response()
    await route.handler({ method: 'GET', url: `${PROBHUB_PATH}/api/health` }, res)
    expect(res.status).toBe(200)
    expect(JSON.parse(body())).toMatchObject({ ok: false, state: 'error', code: 'core_bridge_unavailable' })
  })

  it('never emits a body for HEAD', async () => {
    const { route } = await mount()
    const { response: res, body } = response('HEAD')
    await route.handler({ method: 'HEAD', url: PROBHUB_PATH }, res)
    expect(res.status).toBe(200)
    expect(body()).toBe('')
  })

  it('validates a Session cwd, confines Core, and returns a bounded redacted projection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-probhub-host-'))
    mkdirSync(join(root, '.probhub'))
    writeFileSync(join(root, '.probhub', 'workspace.yaml'), 'schema_version: 1\nproblems: []\n')
    try {
      const { ctx, route } = await mount()
      const sessionId = 'session-one'
      ctx.provide('sessions', { get: (id: string) => id === sessionId ? { header: { cwd: root } } : undefined } as never)
      const spawns: SpawnSpec[] = []
      ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: root }) } as never)
      ctx.provide('sandbox', { confine: (argv: string[]) => ({ argv, enforcement: 'full' }) } as never)
      ctx.provide('subprocess', {
        spawn: (spec: SpawnSpec) => {
          spawns.push(spec)
          const operation = spec.argv[spec.argv.indexOf('--json') + 1]
          const value = operation === 'status'
            ? { ok: false, problems: { A01: { state: 'stale', evidence: { transcript: 'secret' } } } }
            : { ok: false, problems: [{ id: 'A01', ok: false, diagnostics: [{ code: 'lint_warning', severity: 'warning', message: `${root} internal detail` }] }], errors: [`${root} hidden`] }
          const reader = { readFrom: () => ({ text: JSON.stringify(value), lossy: false }) }
          return {
            done: Promise.resolve({ exitCode: 1, signal: null }),
            waitForExit: async () => true,
            collected: { stdout: reader, stderr: reader },
          }
        },
      } as never)
      const { response: res, body } = response()
      await route.handler({ method: 'GET', url: `${PROBHUB_PATH}/api/overview?sessionId=${sessionId}&cwd=C:/escape` }, res)
      expect(res.status).toBe(200)
      const payload = JSON.parse(body()) as {
        ok: boolean
        state: string
        workspace: Record<string, unknown>
      }
      expect(payload.ok).toBe(false)
      expect(payload.state).toBe('ready')
      expect(typeof payload.workspace.workspaceId).toBe('string')
      expect(payload.workspace.schemaVersion).toBe(1)
      expect(payload.workspace).not.toHaveProperty('cwd')
      expect(payload.workspace).not.toHaveProperty('workspaceFile')
      expect(JSON.stringify(payload)).not.toContain(root)
      expect(JSON.stringify(payload)).not.toMatch(/secret|transcript|evidence/iu)
      expect(spawns).toHaveLength(3)
      expect(spawns.every(spec => spec.argv[0] === process.execPath)).toBe(true)
      expect(spawns.every(spec => spec.argv.includes('--workspace') && !spec.argv.includes('--'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects unknown Session selectors and does not guess a workspace path', async () => {
    const { ctx, route } = await mount()
    ctx.provide('sessions', { get: () => undefined } as never)
    const { response: res, body } = response()
    await route.handler({ method: 'GET', url: `${PROBHUB_PATH}/api/overview?sessionId=missing&cwd=C:/escape` }, res)
    expect(res.status).toBe(400)
    expect(JSON.parse(body())).toMatchObject({ ok: false, code: 'session_missing' })
  })

  it('projects a problem report for the workbench without source paths or raw evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-probhub-report-'))
    mkdirSync(join(root, '.probhub'))
    writeFileSync(join(root, '.probhub', 'workspace.yaml'), 'schema_version: 1\nproblems: []\n')
    try {
      const { ctx, route } = await mount()
      ctx.provide('sessions', { get: (id: string) => id === 'report-session' ? { header: { cwd: root } } : undefined } as never)
      ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: root }) } as never)
      ctx.provide('sandbox', { confine: (argv: string[]) => ({ argv, enforcement: 'full' }) } as never)
      ctx.provide('subprocess', {
        spawn: (spec: SpawnSpec) => {
          expect(spec.argv).toContain('report')
          const value = {
            ok: true,
            analysis_state: 'declared_inputs_and_local_evidence',
            problems: [{
              id: 'A01', number: 1, label: 'A', name: 'Example', difficulty: 2,
              tags: ['dp'], limits: { time: 1, memory: 256, output: 64, processes: 8 },
              tests: { sample: { cases: 1 }, secret: { cases: 3 } },
              groups: [{ name: 'edge', role: 'wrong-solution-killer', secret_cases: 1, secret_ratio: 1 }],
              judge_qa: { state: 'passed', declared_cases: 2, evidence_cases: 2 },
              diagnostics: [{ code: 'hidden', severity: 'warning', message: `${root} private detail` }],
            }],
            path: `${root}\\A01\\problem.md`,
          }
          const reader = { readFrom: () => ({ text: JSON.stringify(value), lossy: false }) }
          return {
            done: Promise.resolve({ exitCode: 0, signal: null }),
            waitForExit: async () => true,
            collected: { stdout: reader, stderr: reader },
          }
        },
      } as never)
      const { response: res, body } = response()
      await route.handler({ method: 'GET', url: `${PROBHUB_PATH}/api/problems/A01/report?sessionId=report-session` }, res)
      expect(res.status).toBe(200)
      const payload = JSON.parse(body()) as { report: { problems: Array<Record<string, unknown>> } }
      expect(payload.report.problems[0]).toMatchObject({
        id: 'A01', name: 'Example', judgeQa: { state: 'passed', declared_cases: 2 },
      })
      expect(JSON.stringify(payload)).not.toContain(root)
      expect(JSON.stringify(payload)).not.toContain('private detail')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('binds a validated problem selection to the live Agent prompt context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-probhub-context-'))
    mkdirSync(join(root, '.probhub'))
    writeFileSync(join(root, '.probhub', 'workspace.yaml'), 'schema_version: 1\nproblems: []\n')
    try {
      const { ctx, route } = await mount()
      const sessionId = 'context-session'
      const attached = { id: sessionId, header: { cwd: root } }
      ctx.provide('sessions', { get: (id: string) => id === sessionId ? attached : undefined } as never)
      let captured = ''
      const agent = {
        id: sessionId,
        ctx: { systemPrompt: { context: (value: { text: string }) => { captured = value.text; return () => {} } } },
      }
      ctx.provide('agents', { get: (id: string) => id === sessionId ? agent : undefined } as never)
      ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: root }) } as never)
      ctx.provide('sandbox', { confine: (argv: string[]) => ({ argv, enforcement: 'full' }) } as never)
      ctx.provide('subprocess', {
        spawn: (spec: SpawnSpec) => {
          const operation = spec.argv[spec.argv.indexOf('--json') + 1]
          const value = operation === 'status'
            ? { ok: true, problems: { A01: { revision_id: 'rev-1', generation_id: 'gen-1' } } }
            : {
              ok: true,
              problems: [{ id: 'A01', name: 'Example', difficulty: 3, tests: { total: { cases: 4 } }, judge_qa: { state: 'passed' } }],
            }
          const reader = { readFrom: () => ({ text: JSON.stringify(value), lossy: false }) }
          return {
            done: Promise.resolve({ exitCode: 0, signal: null }),
            waitForExit: async () => true,
            collected: { stdout: reader, stderr: reader },
          }
        },
      } as never)
      const { response: res, body } = response()
      await route.handler({ method: 'POST', url: `${PROBHUB_API_PATH}/context?sessionId=${sessionId}&problemId=A01&selection=2` }, res)
      expect(res.status).toBe(200)
      expect(JSON.parse(body())).toMatchObject({ ok: true, problem: { id: 'A01', revision: 'rev-1', generation: 'gen-1' } })
      expect(captured).toContain('problem: A01')
      expect(captured).toContain('revision: rev-1')
      expect(captured).toContain('generation: gen-1')
      expect(captured).toContain('judgeQa')
      const stale = response()
      await route.handler({ method: 'POST', url: `${PROBHUB_API_PATH}/context?sessionId=${sessionId}&problemId=A01&selection=1` }, stale.response)
      expect(stale.response.status).toBe(409)
      expect(JSON.parse(stale.body())).toMatchObject({ ok: false, code: 'selection_stale' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads and atomically saves an allowed source target with a Core revision fence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-probhub-source-'))
    mkdirSync(join(root, '.probhub'))
    mkdirSync(join(root, 'A01', 'code'), { recursive: true })
    mkdirSync(join(root, 'A01', 'data', 'sample'), { recursive: true })
    mkdirSync(join(root, 'A01', 'data', 'secret'), { recursive: true })
    mkdirSync(join(root, 'A01', 'code', 'nested'))
    writeFileSync(join(root, '.probhub', 'workspace.yaml'), 'schema_version: 1\nproblems: [A01]\n')
    writeFileSync(join(root, 'A01', 'probhub.yaml'), 'id: A01\n')
    writeFileSync(join(root, 'A01', 'problem.md'), '# Before\n')
    writeFileSync(join(root, 'A01', 'code', 'std.cpp'), 'int main() {}\n')
    writeFileSync(join(root, 'A01', 'data', 'sample', '01.in'), '1\n')
    writeFileSync(join(root, 'A01', 'data', 'secret', '01.in'), '2\n')
    writeFileSync(join(root, 'A01', 'data', 'secret', '01.ans'), 'answer\n')
    try {
      const { ctx, route } = await mount({ command: join(root, 'fake-probhub.js') })
      const sessionId = 'source-session'
      const attached = { id: sessionId, header: { cwd: root } }
      ctx.provide('sessions', { get: (id: string) => id === sessionId ? attached : undefined } as never)
      ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) } as never)
      ctx.provide('sandbox', { confine: (argv: string[]) => ({ argv, enforcement: 'full' }) } as never)
      let statusCalls = 0
      const initialRevision = 'a'.repeat(64)
      const nextRevision = 'b'.repeat(64)
      ctx.provide('subprocess', {
        spawn: (_spec: SpawnSpec) => {
          statusCalls += 1
          const revision = statusCalls < 3 ? initialRevision : nextRevision
          const reader = {
            readFrom: () => ({
              text: JSON.stringify({ ok: true, problems: { A01: { source_hash: revision } } }),
              lossy: false,
            }),
          }
          return {
            done: Promise.resolve({ exitCode: 0, signal: null }),
            waitForExit: async () => true,
            collected: { stdout: reader, stderr: reader },
          }
        },
      } as never)

      const targets = response()
      await route.handler(request('GET', `${PROBHUB_API_PATH}/source-targets?sessionId=${sessionId}&problemId=A01`), targets.response)
      expect(targets.response.status).toBe(200)
      expect(JSON.parse(targets.body())).toMatchObject({
        ok: true,
        targets: [
          { target: 'statement', kind: 'statement' },
          { target: 'config', kind: 'config' },
          { target: 'code:std.cpp', kind: 'code' },
          { target: 'sample-input:01.in', kind: 'sample-input' },
          { target: 'secret-input:01.in', kind: 'secret-input' },
        ],
      })
      expect(JSON.stringify(JSON.parse(targets.body()))).not.toContain('nested')

      const read = response()
      await route.handler(request('GET', `${PROBHUB_API_PATH}/source?sessionId=${sessionId}&problemId=A01&target=statement`), read.response)
      expect(read.response.status).toBe(200)
      expect(JSON.parse(read.body())).toMatchObject({
        ok: true,
        source: { target: 'statement', content: '# Before\n', revision: initialRevision },
        impact: { source: true, data: false, formalArtifacts: true },
      })

      const save = response('POST')
      await route.handler(request('POST', `${PROBHUB_API_PATH}/source?sessionId=${sessionId}&problemId=A01`, JSON.stringify({
        target: 'statement', content: '# After\n', expectedRevision: initialRevision,
      })), save.response)
      expect(save.response.status).toBe(200)
      expect(JSON.parse(save.body())).toMatchObject({ ok: true, source: { target: 'statement', revision: nextRevision } })
      expect(readFileSync(join(root, 'A01', 'problem.md'), 'utf8')).toBe('# After\n')

      const stale = response('POST')
      await route.handler(request('POST', `${PROBHUB_API_PATH}/source?sessionId=${sessionId}&problemId=A01`, JSON.stringify({
        target: 'statement', content: '# Lost update\n', expectedRevision: initialRevision,
      })), stale.response)
      expect(stale.response.status).toBe(409)
      expect(JSON.parse(stale.body())).toMatchObject({ ok: false, code: 'source_conflict', expectedRevision: initialRevision })
      expect(readFileSync(join(root, 'A01', 'problem.md'), 'utf8')).toBe('# After\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects source writes without a live workspace-write Session or with traversal targets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-probhub-source-deny-'))
    mkdirSync(join(root, '.probhub'))
    mkdirSync(join(root, 'A01'), { recursive: true })
    writeFileSync(join(root, '.probhub', 'workspace.yaml'), 'schema_version: 1\nproblems: [A01]\n')
    writeFileSync(join(root, 'A01', 'problem.md'), '# Before\n')
    try {
      const { ctx, route } = await mount({ command: join(root, 'fake-probhub.js') })
      const sessionId = 'source-deny-session'
      ctx.provide('sessions', { get: (id: string) => id === sessionId ? { header: { cwd: root } } : undefined } as never)
      const denied = response('POST')
      await route.handler(request('POST', `${PROBHUB_API_PATH}/source?sessionId=${sessionId}&problemId=A01`, JSON.stringify({
        target: 'statement', content: '# After\n', expectedRevision: 'a'.repeat(64),
      })), denied.response)
      expect(denied.response.status).toBe(403)
      expect(JSON.parse(denied.body())).toMatchObject({ ok: false, code: 'workspace_write_required' })

      const traversal = response('GET')
      await route.handler(request('GET', `${PROBHUB_API_PATH}/source?sessionId=${sessionId}&problemId=A01&target=code%3A..%2Fescape`), traversal.response)
      expect(traversal.response.status).toBe(400)
      expect(JSON.parse(traversal.body())).toMatchObject({ ok: false, code: 'source_target_invalid' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses the data hash as the revision fence for sample and secret inputs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-probhub-data-source-'))
    mkdirSync(join(root, '.probhub'))
    mkdirSync(join(root, 'A01', 'data', 'secret'), { recursive: true })
    writeFileSync(join(root, '.probhub', 'workspace.yaml'), 'schema_version: 1\nproblems: [A01]\n')
    writeFileSync(join(root, 'A01', 'probhub.yaml'), 'id: A01\n')
    writeFileSync(join(root, 'A01', 'problem.md'), '# Problem\n')
    writeFileSync(join(root, 'A01', 'data', 'secret', '01.in'), 'before\n')
    try {
      const { ctx, route } = await mount({ command: join(root, 'fake-probhub.js') })
      const sessionId = 'data-session'
      const attached = { id: sessionId, header: { cwd: root } }
      ctx.provide('sessions', { get: (id: string) => id === sessionId ? attached : undefined } as never)
      ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) } as never)
      ctx.provide('sandbox', { confine: (argv: string[]) => ({ argv, enforcement: 'full' }) } as never)
      let statusCalls = 0
      const sourceRevision = 'a'.repeat(64)
      const initialDataRevision = 'c'.repeat(64)
      const nextDataRevision = 'd'.repeat(64)
      ctx.provide('subprocess', {
        spawn: (_spec: SpawnSpec) => {
          statusCalls += 1
          const reader = {
            readFrom: () => ({
              text: JSON.stringify({
                ok: true,
                problems: { A01: { source_hash: sourceRevision, data_hash: statusCalls < 3 ? initialDataRevision : nextDataRevision } },
              }),
              lossy: false,
            }),
          }
          return {
            done: Promise.resolve({ exitCode: 0, signal: null }),
            waitForExit: async () => true,
            collected: { stdout: reader, stderr: reader },
          }
        },
      } as never)

      const read = response()
      await route.handler(request('GET', `${PROBHUB_API_PATH}/source?sessionId=${sessionId}&problemId=A01&target=secret-input%3A01.in`), read.response)
      expect(read.response.status).toBe(200)
      expect(JSON.parse(read.body())).toMatchObject({ source: { revision: initialDataRevision } })

      const save = response('POST')
      await route.handler(request('POST', `${PROBHUB_API_PATH}/source?sessionId=${sessionId}&problemId=A01`, JSON.stringify({
        target: 'secret-input:01.in', content: 'after\n', expectedRevision: initialDataRevision,
      })), save.response)
      expect(save.response.status).toBe(200)
      expect(JSON.parse(save.body())).toMatchObject({ source: { revision: nextDataRevision } })
      expect(readFileSync(join(root, 'A01', 'data', 'secret', '01.in'), 'utf8')).toBe('after\n')

      const stale = response('POST')
      await route.handler(request('POST', `${PROBHUB_API_PATH}/source?sessionId=${sessionId}&problemId=A01`, JSON.stringify({
        target: 'secret-input:01.in', content: 'lost\n', expectedRevision: initialDataRevision,
      })), stale.response)
      expect(stale.response.status).toBe(409)
      expect(JSON.parse(stale.body())).toMatchObject({ ok: false, code: 'source_conflict', currentRevision: nextDataRevision })
      expect(readFileSync(join(root, 'A01', 'data', 'secret', '01.in'), 'utf8')).toBe('after\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
