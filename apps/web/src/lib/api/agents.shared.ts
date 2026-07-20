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
