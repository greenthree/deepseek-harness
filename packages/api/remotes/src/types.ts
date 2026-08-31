/**
 * Type face of the forwarded-Host-event allowlist: the consumer key projection
 * and the selection seat it fills. The allowlist VALUE lives in
 * `./remote-events.ts`, keeping this module type-only per the package
 * convention; both compiler faces list both files, so the Host forwarding loop
 * and the consumer `ctx.remote.$on` key face read one declaration instead of
 * two copies that could drift.
 *
 * @module @deepseek-ai/dsh-api-remotes/types
 */

import type { API_REMOTE_FORWARDED_EVENTS } from './remote-events.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Type projection of the allowlist; the consumer and the Host read this one. */
export type ApiRemoteForwardedEvent = typeof API_REMOTE_FORWARDED_EVENTS[number]

/** Stable browser workbench tabs that a Host suggestion may target. */
export type ProbHubTab = 'statement' | 'health' | 'pdf'

/** Why a Host-side recommendation asked the read-only workbench to move. */
export type ProbHubTabRequestReason = 'ai-suggestion' | 'tool-result'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteEventSelection extends Record<ApiRemoteForwardedEvent, true> {}
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Ask the current Client workbench to locate one already-known problem tab.
     * The event is a one-way UI hint: it never selects a workspace, mutates
     * source files, or invokes a Core operation. Host producers must derive
     * `sessionId` from the calling Agent and validate `problemId` before emit.
     * @param sessionId - the calling Agent's shared Session identity.
     * @param problemId - a validated Schema v1 problem id.
     * @param tab - stable tab key (`statement`, `health`, or `pdf`).
     * @param reason - whether the hint came from an AI suggestion or tool result.
     * @param source - optional bounded producer/tool name for diagnostics.
     * @mode emit
     */
    'probhub/tab-requested'(sessionId: SessionId, problemId: string, tab: ProbHubTab, reason: ProbHubTabRequestReason, source?: string): void
  }
}
