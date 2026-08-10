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
    /**
     * State-aware sweeper (Wave 4 M6) - short machine token saying why
     * the PLATFORM flagged this run (`queued-too-long`, `stale-parked`).
     * `null` = nothing wrong. Optional-safe: an older API omits it, and
     * the row simply renders no attention chip.
     */
    attentionReason?: string | null;
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
    /**
     * Attach-session action (Wave 4 M8) — server-computed "can a viewer join
     * this run's terminal RIGHT NOW?". True only when the terminal is
     * `starting`/`attached` AND the run is still open. The UI gates its
     * terminal-icon deep link on THIS, never on `terminalState` alone: a run
     * that died can keep reading `attached` for minutes until the terminal
     * sweeper corrects it, and offering Attach there is a dead end.
     */
    sessionAttachable: boolean;
    createdAt: string;
}

/**
 * Run steering (Wave 4 M5) — the shape returned by the steer endpoint.
 * `new-run` is a normal answer, not an error: the run finished while the
 * user was typing, so the caller starts a fresh one.
 */
export interface RunSteerResponse {
    dispatched: 'injected' | 'new-run';
    runId: string;
    queuedCount?: number;
}

export interface RunInterruptResponse {
    interrupted: boolean;
    runId: string;
}

export interface RunResumeResponse {
    dispatched: 'new-run';
    /** The NEW run. The source run stays terminal — runs are immutable. */
    runId: string;
    resumedFromRunId: string;
    carriedCliSession: boolean;
    queued: boolean;
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

// ── Agent picker (Task assignment) ──
// The Task detail rail assigns a Task's Agent from a `'use client'`
// dropdown, so the status union and the option row it renders have to be
// reachable without importing the `server-only` `agents.ts`. Both are
// re-exported from there, so server-side callers keep one import site.

export type AgentStatus = 'draft' | 'active' | 'paused' | 'running' | 'error' | 'archived';

/**
 * One row of the Agent dropdown — the narrow projection of `Agent` the
 * picker actually renders. Deliberately not the full DTO: the option list
 * crosses a Server-Action boundary on every mount and nothing else on the
 * Agent is needed to label or colour a row.
 */
export interface AgentPickerOption {
    id: string;
    name: string;
    slug: string;
    status: AgentStatus;
}

/**
 * One row of the Work header's "Assign existing Agent" picker. Same
 * projection as `AgentPickerOption` plus the Agent's role line, which is
 * what actually tells an operator whether THIS Agent belongs on THIS
 * Work ("Release manager" vs "SEO writer") — the name alone rarely does.
 */
export interface AgentAssignCandidate extends AgentPickerOption {
    title: string | null;
}
