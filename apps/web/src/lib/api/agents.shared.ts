/**
 * Agents — client-safe contract values.
 *
 * Pure guardrail types + the action-type tuple carry NO server
 * dependency, so they live apart from `agents.ts` (which is
 * `server-only`). `'use client'` components (e.g. `AgentGuardrailsCard`)
 * import them from here; `agents.ts` re-exports them so server-side
 * callers keep a single import site. Importing the
 * `AGENT_GUARDRAIL_ACTION_TYPES` value (not just a type) from `agents.ts`
 * in a client component pulls its `server-only` guard into the client
 * bundle and fails `next build` — this split avoids that while keeping
 * one canonical definition.
 */

import type { GateStatus, TaskAcceptanceCheck, TaskCheckResult } from '@ever-works/contracts';

// ── Agent Dispatch Guardrails ──
// Mirrors `AgentGuardrails` (packages/agent/src/agents/guardrails.ts)
// and the proposal action types
// (packages/agent/src/entities/agent-action-proposal.entity.ts).

export type AgentGuardrailActionType =
    | 'spawn_agent'
    | 'schedule_task'
    | 'send_message'
    | 'budget_override'
    | 'other';

export const AGENT_GUARDRAIL_ACTION_TYPES: readonly AgentGuardrailActionType[] = [
    'spawn_agent',
    'schedule_task',
    'send_message',
    'budget_override',
    'other',
] as const;

export type AgentGuardrailsMode = 'require_approval' | 'autonomous';

export interface AgentGuardrails {
    mode: AgentGuardrailsMode;
    /** Autonomous-mode narrowing; omitted = every unflagged type may auto-approve. */
    autoApproveActionTypes?: AgentGuardrailActionType[];
    /** Action types the Agent may never take (auto-rejected with an audit row). */
    blockedActionTypes?: AgentGuardrailActionType[];
}

// ── Sessions view (Wave 4 M4) ──
// Client-safe mirror of the `GET /api/agents/runs` row shape
// (AgentsController.listRunSessions). Lives here so the `'use client'`
// Sessions tab can type its rows without pulling the `server-only`
// `agents.ts` module into the bundle.

export type AgentRunSessionStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type AgentRunTriggerKind = 'heartbeat' | 'manual' | 'task' | 'chat' | 'event';

export interface AgentRunSession {
    id: string;
    agentId: string;
    status: AgentRunSessionStatus;
    triggerKind: AgentRunTriggerKind;
    taskId: string | null;
    workId: string | null;
    awaitingInput: boolean;
    queuedReason: string | null;
    runnerKind: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    summary: string | null;
    errorMessage: string | null;
    /** Plain text BY CONTRACT — never render as markup. */
    currentActivity: string | null;
    totalTokens: number | null;
    changedFilesCount: number | null;
    costCents: number | null;
    gateStatus: GateStatus | null;
    gateAttempts: number;
    resolvedChecks: TaskAcceptanceCheck[] | null;
    checkResults: TaskCheckResult[] | null;
    persistent: boolean;
    terminalState: string | null;
    terminalEndedReason: string | null;
    terminalProviderId: string | null;
    createdAt: string;
}

export interface ListRunSessionsQuery {
    status?: AgentRunSessionStatus;
    workId?: string;
    agentId?: string;
    taskId?: string;
    kind?: AgentRunTriggerKind;
    limit?: number;
    offset?: number;
}
