// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { probHubController } from '@deepseek-ai/dsh-client-ui-layout/src/client/probhub-controller.ts'
import { ProbHubSection } from '../src/client/ProbHubSection.tsx'

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response
}

function requestUrl(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof URL) return value.href
  if (typeof Request !== 'undefined' && value instanceof Request) return value.url
  return ''
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  void probHubController.refresh(undefined)
})

describe('ProbHub sidebar section', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      state: 'ready',
      workspaceId: 'workspace-a',
      problems: [{ id: 'A01', title: 'Alpha', status: 'current' }],
    })))
  })

  it('renders the shared controller list and updates the central selection on click', async () => {
    await act(async () => { await probHubController.refresh('session-a') })
    render(<ProbHubSection wide probHub={probHubController.getSnapshot()} />)
    const item = screen.getByRole('button', { name: /A01.*Alpha/u })
    fireEvent.click(item)
    expect(probHubController.getSnapshot().selectedId).toBe('A01')
  })

  it('publishes the selected problem context through the Host route', async () => {
    await act(async () => { await probHubController.refresh('session-a') })
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockClear()
    probHubController.select('A01')
    await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)) })
    const contextCall = fetchMock.mock.calls.find(([url, init]) => (
      requestUrl(url).includes('/probhub/api/context?') && init?.method === 'POST'
    ))
    expect(requestUrl(contextCall?.[0])).toContain('sessionId=session-a')
    expect(requestUrl(contextCall?.[0])).toContain('problemId=A01')
  })

  it('drops an older Session response when a newer Session wins', async () => {
    let resolveA!: (value: Response) => void
    let resolveB!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn((url: string) => new Promise<Response>((resolve) => {
      if (url.includes('session-a')) resolveA = resolve
      else resolveB = resolve
    })))
    const first = probHubController.refresh('session-a')
    const second = probHubController.refresh('session-b')
    await act(async () => {
      resolveB(response({ state: 'ready', workspaceId: 'workspace-b', problems: [{ id: 'B02', title: 'Beta' }] }))
      await second
      resolveA(response({ state: 'ready', workspaceId: 'workspace-a', problems: [{ id: 'A01', title: 'Alpha' }] }))
      await first
    })
    expect(probHubController.getSnapshot().sessionId).toBe('session-b')
    expect(probHubController.getSnapshot().snapshot.workspaceId).toBe('workspace-b')
    expect(probHubController.getSnapshot().selectedId).toBe('B02')
  })

  it('treats an absent Host route as unavailable instead of replacing the DSH shell', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({}, false, 404)))
    await act(async () => { await probHubController.refresh('session-missing-host') })
    expect(probHubController.getSnapshot().snapshot.state).toBe('unavailable')
  })
})
