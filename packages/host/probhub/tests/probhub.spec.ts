import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as probhub from '../src/index.ts'
import { type Config, PROBHUB_PATH } from '../src/index.ts'

const { apply } = probhub

interface FakeRequest { method: string; url: string }
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
      expect(spawns).toHaveLength(2)
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
})
