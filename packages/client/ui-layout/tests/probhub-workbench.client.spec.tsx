// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { probHubController } from '../src/client/probhub-controller.ts'
import { ProbHubWorkbench } from '../src/client/ProbHubWorkbench.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  void probHubController.refresh(undefined)
})

describe('ProbHub workbench report projection', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        state: 'ready',
        workspaceId: 'workspace-a',
        problems: [{ id: 'A01', title: 'Alpha', judge: 'standard', difficulty: 'easy', status: 'current', revision: 'rev-a' }],
        report: {
          ok: true,
          problems: [{
            id: 'A01',
            tests: { total: { cases: 4 } },
            groups: [{ name: 'negative', role: 'wrong-solution-killer' }],
            aggregateConstraints: { state: 'matched', multiCaseDetected: true },
            judgeQa: { state: 'passed', declared_cases: 2, matched_cases: 2 },
            calibration: { state: 'current' },
          }],
        },
      }),
    } as Response)))
  })

  it('renders Core report summaries in the problem and health tabs', async () => {
    await act(async () => { await probHubController.refresh('session-a') })
    render(<ProbHubWorkbench sessionId="session-a" />)

    expect(screen.getAllByText('Alpha')).not.toHaveLength(0)
    expect(screen.getByText('测试点')).toBeTruthy()
    expect(screen.getByText('4')).toBeTruthy()
    expect(screen.getByRole('complementary', { name: 'AI 副驾驶' }).textContent).toContain('题目验证上下文')

    await act(async () => { screen.getByRole('button', { name: '健康与评测' }).click() })
    expect(screen.getByText('健康摘要')).toBeTruthy()
    expect(screen.getByText('Judge QA')).toBeTruthy()
    expect(screen.getByText('matched')).toBeTruthy()
    expect(screen.getByText('passed')).toBeTruthy()
    expect(screen.getByText('1 个错解覆盖组')).toBeTruthy()
  })
})
