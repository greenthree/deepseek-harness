/**
 * P0 ProbHub workbench contract tests.
 *
 * The Host bridge is developed in a sibling worktree, so this file carries a
 * deliberately small HTTP fixture that implements the agreed wire contract.
 * The same assertions can target a live DSH server by setting
 * `DSH_PROBHUB_BASE_URL` (for example, `http://127.0.0.1:33933`). Keeping the
 * fixture here makes the boundary executable before the assembled Web profile
 * mounts the new plugin and prevents tests from inventing a second business
 * implementation in production code.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BASE_PATH = '/probhub'
const API_PATH = `${BASE_PATH}/api`

interface Problem {
  id: string
  index: number
  title: string
  judge: string
  difficulty: string
  status: 'current' | 'stale' | 'warn' | 'blocked'
  revision: string
  generation?: string
}

interface SessionFixture {
  id: string
  cwd: string
  schema: boolean
  problems: Problem[]
}

interface JsonResponse {
  ok: boolean
  state?: string
  code?: string
  error?: string
  workspace?: { workspaceId: string; schemaVersion: number }
  problems?: Problem[]
  problem?: Problem
  plugin?: string
  routes?: string[]
}

/** A tiny in-memory server mirroring the Host bridge's read-only P0 routes. */
class ProbHubFixture {
  readonly sessions = new Map<string, SessionFixture>()
  readonly requests: string[] = []
  /** Test-only request context; production Host derives this from the request scope. */
  private boundSessionId: string | undefined

  /** Resolve an optional opaque selector, falling back to this request context. */
  private sessionFor(url: URL): SessionFixture | undefined {
    const selected = url.searchParams.get('sessionId')
    const id = selected === null ? this.boundSessionId : selected
    return id === undefined ? undefined : this.sessions.get(id)
  }
  private server: Server | undefined
  private disposed = false

  async listen(): Promise<string> {
    this.server = createServer((request, response) => { void this.handle(request, response) })
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(0, '127.0.0.1', () => { resolve() })
    })
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture did not bind a TCP address')
    return `http://127.0.0.1:${address.port}`
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const server = this.server
    if (server === undefined) return
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    this.server = undefined
  }

  /** Bind a page/server instance to one canonical Harness Session context. */
  bindSession(id: string | undefined): void {
    this.boundSessionId = id
  }

  private write(response: ServerResponse, status: number, payload: object, headers: Record<string, string> = {}): void {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'",
      'x-content-type-options': 'nosniff',
      ...headers,
    })
    response.end(JSON.stringify(payload))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', 'http://fixture.invalid')
    this.requests.push(`${url.pathname}${url.search}`)
    if (this.disposed) return
    if (url.pathname === BASE_PATH && method === 'GET') {
      this.write(response, 200, { ok: true, state: 'ready' })
      return
    }
    if (url.pathname === `${BASE_PATH}/app.js` && method === 'GET') {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'",
      })
      response.end(`document.querySelector('[data-ai-toggle]').addEventListener('click', () => {
        const button = document.querySelector('[data-ai-toggle]');
        const panel = document.querySelector('[data-ai-panel]');
        const expanded = button.getAttribute('aria-expanded') === 'true';
        button.setAttribute('aria-expanded', String(!expanded));
        panel.setAttribute('data-open', String(!expanded));
      });`)
      return
    }
    if (url.pathname === `${BASE_PATH}/style.css` && method === 'GET') {
      response.writeHead(200, {
        'content-type': 'text/css; charset=utf-8',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'",
      })
      response.end(`:root { color-scheme: light; font: 16px system-ui; }
        [data-layout] { display:grid; grid-template-columns:minmax(0, 3fr) minmax(280px, 2fr); min-height:100vh; }
        [data-workbench], [data-ai-panel] { padding:1rem; }
        [data-ai-panel] { border-left:1px solid #ccc; }
        [data-ai-toggle] { display:none; }
        @media (max-width: 800px) {
          [data-layout] { display:block; }
          [data-ai-panel] { display:none; position:fixed; inset:0 0 0 20%; background:white; border-left:1px solid #ccc; }
          [data-ai-panel][data-open="true"] { display:block; }
          [data-ai-toggle] { display:inline-block; }
        }`)
      return
    }
    if (url.pathname === `${BASE_PATH}/shell` && method === 'GET') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'",
      })
      response.end(`<!doctype html><html><head><link rel="stylesheet" href="/probhub/style.css"></head><body>
        <main data-layout="workbench"><section data-workbench aria-label="ProbHub workbench">Problem</section>
          <button data-ai-toggle aria-controls="ai-panel" aria-expanded="false">AI copilot</button>
          <aside id="ai-panel" data-ai-panel aria-label="AI copilot">Assistant</aside>
        </main><script src="/probhub/app.js"></script></body></html>`)
      return
    }
    if (method !== 'GET' && (url.pathname === BASE_PATH || url.pathname.startsWith(`${API_PATH}/`))) {
      this.write(response, 405, { ok: false, code: 'method-not-allowed' }, { allow: 'GET' })
      return
    }
    if (url.pathname === `${API_PATH}/overview`) {
      const selected = url.searchParams.get('sessionId')
      const session = this.sessionFor(url)
      if (session === undefined) {
        this.write(response, selected === null ? 400 : 404, {
          ok: false,
          code: selected === null ? 'session-context-required' : 'session-not-found',
          error: selected === null ? 'current Harness Session is required' : 'unknown session selector',
        })
        return
      }
      // Deliberately ignore URL cwd/path hints. The Host resolves canonical cwd
      // from the Session header; accepting this query would be a path escape.
      if (!session.schema) {
        this.write(response, 409, { ok: false, state: 'migration_required', code: 'migration_required' })
        return
      }
      this.write(response, 200, {
        ok: true,
        state: 'ready',
        workspace: { workspaceId: `workspace-${session.id}`, schemaVersion: 1 },
        problems: session.problems,
      })
      return
    }
    const problemMatch = url.pathname.match(new RegExp(`^${API_PATH}/problems/([^/]+)/(status|lint)$`))
    if (problemMatch !== null) {
      const encodedId = problemMatch[1]!
      let id: string
      try { id = decodeURIComponent(encodedId) } catch {
        this.write(response, 400, { ok: false, code: 'invalid-problem-id' })
        return
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
        this.write(response, 400, { ok: false, code: 'invalid-problem-id' })
        return
      }
      const selected = url.searchParams.get('sessionId')
      const session = this.sessionFor(url)
      const problem = session?.problems.find(candidate => candidate.id === id)
      if (session === undefined) {
        this.write(response, selected === null ? 400 : 404, {
          ok: false,
          code: selected === null ? 'session-context-required' : 'session-not-found',
        })
      } else if (!session.schema) {
        this.write(response, 409, { ok: false, state: 'migration_required', code: 'migration_required' })
      } else if (problem === undefined) {
        this.write(response, 404, { ok: false, code: 'problem-not-found' })
      } else {
        this.write(response, 200, { ok: true, state: 'ready', problem, workspace: { workspaceId: `workspace-${session.id}`, schemaVersion: 1 } })
      }
      return
    }
    this.write(response, 404, { ok: false, code: 'not-found' })
  }
}

async function json(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: JsonResponse; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, init)
  return { status: response.status, body: await response.json() as JsonResponse, headers: response.headers }
}

const problemA: Problem = {
  id: 'A01', index: 1, title: 'Alpha', judge: 'standard', difficulty: 'easy',
  status: 'current', revision: 'rev-a', generation: 'gen-a',
}
const problemB: Problem = {
  id: 'B02', index: 2, title: 'Beta', judge: 'output-only', difficulty: 'medium',
  status: 'warn', revision: 'rev-b',
}

describe('ProbHub P0 Host route contract (fixture)', () => {
  let fixture: ProbHubFixture
  let baseUrl: string

  beforeAll(async () => {
    fixture = new ProbHubFixture()
    baseUrl = await fixture.listen()
    fixture.sessions.set('session-a', { id: 'session-a', cwd: '/work/a', schema: true, problems: [problemA] })
    fixture.sessions.set('session-b', { id: 'session-b', cwd: '/work/b', schema: true, problems: [problemB] })
    fixture.sessions.set('legacy', { id: 'legacy', cwd: '/work/legacy', schema: false, problems: [] })
  })

  afterAll(async () => { await fixture.dispose() })

  it('publishes metadata and the canonical /probhub route namespace', async () => {
    const result = await json(baseUrl, BASE_PATH)
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, state: 'ready' })
    expect(result.headers.get('content-security-policy')).toContain("default-src 'self'")
  })

  it('returns an empty ready workspace without inventing generated artifacts', async () => {
    fixture.sessions.set('empty', { id: 'empty', cwd: '/work/empty', schema: true, problems: [] })
    fixture.bindSession('empty')
    const result = await json(baseUrl, `${API_PATH}/overview`)
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, state: 'ready', workspace: { workspaceId: 'workspace-empty', schemaVersion: 1 }, problems: [] })
    expect(JSON.stringify(result.body)).not.toMatch(/(?:[A-Za-z]:[\\/]|\/work\/)/u)
  })

  it('fails closed with migration_required when Schema v1 is absent', async () => {
    fixture.bindSession('legacy')
    const result = await json(baseUrl, `${API_PATH}/overview`)
    expect(result.status).toBe(409)
    expect(result.body).toMatchObject({ ok: false, state: 'migration_required', code: 'migration_required' })
  })

  it('resolves each overview from its Session canonical cwd without cross-reading', async () => {
    fixture.bindSession(undefined)
    const a = await json(baseUrl, `${API_PATH}/overview?cwd=/escape&sessionId=session-a`)
    const b = await json(baseUrl, `${API_PATH}/overview?workspace=/work/a&sessionId=session-b`)
    expect(a.body.workspace?.workspaceId).toBe('workspace-session-a')
    expect(a.body.problems?.map(problem => problem.id)).toEqual(['A01'])
    expect(b.body.workspace?.workspaceId).toBe('workspace-session-b')
    expect(b.body.problems?.map(problem => problem.id)).toEqual(['B02'])
  })

  it('returns selected problem context and re-checks revision on each switch', async () => {
    fixture.bindSession(undefined)
    const first = await json(baseUrl, `${API_PATH}/problems/A01/status?sessionId=session-a`)
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ ok: true, problem: problemA })
    const second = await json(baseUrl, `${API_PATH}/problems/B02/status?sessionId=session-b`)
    expect(second.status).toBe(200)
    expect(second.body).toMatchObject({ ok: true, problem: problemB })
    expect(second.body).not.toMatchObject({ problem: problemA })
  })

  it('rejects traversal, malformed IDs, unknown sessions, and unknown problems', async () => {
    fixture.bindSession('session-a')
    const traversal = await json(baseUrl, `${API_PATH}/problems/..%2Fsecret/status?sessionId=session-a`)
    expect(traversal.status).toBe(400)
    expect(traversal.body.code).toBe('invalid-problem-id')
    const malformed = await json(baseUrl, `${API_PATH}/problems/%00/status?sessionId=session-a`)
    expect(malformed.status).toBe(400)
    fixture.bindSession(undefined)
    const missingSession = await json(baseUrl, `${API_PATH}/problems/A01/status?sessionId=missing`)
    expect(missingSession.status).toBe(404)
    expect(missingSession.body.code).toBe('session-not-found')
    const missingProblem = await json(baseUrl, `${API_PATH}/problems/A01/status?sessionId=session-b`)
    expect(missingProblem.status).toBe(404)
    expect(missingProblem.body.code).toBe('problem-not-found')
  })

  it('requires a current Harness Session context and exposes GET-only routes', async () => {
    fixture.bindSession(undefined)
    const missing = await json(baseUrl, `${API_PATH}/overview`)
    expect(missing.status).toBe(400)
    expect(missing.body.code).toBe('session-context-required')
    fixture.bindSession('session-a')
    const ordinary = await json(baseUrl, `${API_PATH}/overview?sessionId=session-a`)
    expect(ordinary.status).toBe(200)
    expect(ordinary.body).not.toHaveProperty('sessionId')
    expect(fixture.requests.at(-1)).toContain('sessionId=session-a')
    expect(JSON.stringify(ordinary.body)).not.toContain('/work/')
    expect(JSON.stringify(ordinary.body)).not.toMatch(/[A-Za-z]:\\/u)
    const post = await json(baseUrl, BASE_PATH, { method: 'POST' })
    expect(post.status).toBe(405)
    expect(post.body.code).toBe('method-not-allowed')
  })

  it('releases every route when the plugin is disposed', async () => {
    const disposable = new ProbHubFixture()
    const disposableUrl = await disposable.listen()
    expect((await json(disposableUrl, BASE_PATH)).status).toBe(200)
    await disposable.dispose()
    // A closed node server must not keep a route or listener alive. The
    // request is expected to fail at the transport, not return stale JSON.
    await expect(fetch(`${disposableUrl}${BASE_PATH}`)).rejects.toThrow()
  })
})

describe('ProbHub P0 browser layout and security contract (fixture)', () => {
  let fixture: ProbHubFixture
  let baseUrl: string
  let browser: Browser
  let page: Page
  const browserErrors: string[] = []

  beforeAll(async () => {
    fixture = new ProbHubFixture()
    baseUrl = await fixture.listen()
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page.on('pageerror', error => browserErrors.push(String(error)))
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text())
    })
  })

  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await fixture.dispose()
  })

  it('keeps desktop workbench and AI copilot in one two-column surface', async () => {
    await page.goto(`${baseUrl}${BASE_PATH}/shell`, { waitUntil: 'networkidle' })
    expect(await page.locator('[data-layout="workbench"]').evaluate(element => getComputedStyle(element).display)).toBe('grid')
    expect(await page.locator('[data-ai-panel]').isVisible()).toBe(true)
    expect(await page.locator('[data-ai-toggle]').isVisible()).toBe(false)
    // The workbench must not inject a second conversation shell or hard-coded
    // chat transcript into DSH's existing conversation surface.
    expect(await page.locator('body').textContent()).not.toContain('Start a conversation')
    expect(await page.locator('body').textContent()).not.toContain('Describe what you want to build')
    expect(browserErrors).toEqual([])
    expect(await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]'))).toBeNull()
    const policy = (await fetch(`${baseUrl}${BASE_PATH}/shell`)).headers
    expect(policy.get('content-security-policy')).toContain("script-src 'self'")
  })

  it('collapses AI to a narrow-screen drawer while preserving the workbench', async () => {
    await page.setViewportSize({ width: 640, height: 800 })
    expect(await page.locator('[data-layout="workbench"]').evaluate(element => getComputedStyle(element).display)).toBe('block')
    expect(await page.locator('[data-ai-panel]').isVisible()).toBe(false)
    const toggle = page.locator('[data-ai-toggle]')
    expect(await toggle.isVisible()).toBe(true)
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
    expect(await page.locator('[data-ai-panel]').isVisible()).toBe(true)
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
    expect(await page.locator('[data-ai-panel]').isVisible()).toBe(false)
    expect(browserErrors).toEqual([])
  })

})

describe('ProbHub P0 live endpoint opt-in', () => {
  const baseUrl = process.env.DSH_PROBHUB_BASE_URL

  it.skipIf(baseUrl === undefined || baseUrl === '')('serves the canonical metadata route from a real DSH Host', async () => {
    const result = await json(baseUrl!, BASE_PATH)
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true })
    expect(result.body.routes).toEqual([`${API_PATH}/overview`, `${API_PATH}/problems/:id/status|lint`])
  })
})
