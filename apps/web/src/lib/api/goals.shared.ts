/**
 * Goals & Metrics — client-safe contract values.
 *
 * These pure union types and numeric constants carry NO server
 * dependency, so they live apart from `goals.ts` (which is
 * `server-only`). `'use client'` components (e.g. `GoalForm`) import
 * them from here directly; `goals.ts` re-exports them so server-side
 * callers keep a single import site. Importing a value (not just a
 * type) from `goals.ts` in a client component pulls its `server-only`
 * guard into the client bundle and fails the build — this split
 * avoids that while keeping one canonical definition.
 */
export type GoalStatus = 'draft' | 'active' | 'paused' | 'completed';
export type GoalOutcome = 'achieved' | 'missed' | 'abandoned';
export type GoalComparator = 'gte' | 'lte';
export type GoalWindow = 'day' | 'week' | 'month' | 'total' | 'point';

/**
 * Goal KIND (self-build slice AG, EW-795). `metric` is the original Goal —
 * a metrics-provider number measured against a target; `delivery` has no
 * metric at all and completes on its approved Definition of Done alone.
 * Mirrors `GOAL_KINDS` in `@ever-works/contracts`.
 */
export type GoalKind = 'metric' | 'delivery';
export const GOAL_KINDS: GoalKind[] = ['metric', 'delivery'];

/**
 * Spec FR-12: per-Goal evaluation frequency is clamped server-side to
 * a minimum of 15 minutes regardless of what the form submits. Mirror
 * of `MIN_CHECK_FREQUENCY_MINUTES` from the agent package so the form
 * can surface the hint without importing the agent barrel.
 */
export const MIN_CHECK_FREQUENCY_MINUTES = 15;
export const DEFAULT_CHECK_FREQUENCY_MINUTES = 60;

/**
 * Autonomy layer — client-safe mirrors of the Goal execution-loop
 * contract. Same reason as the unions above: the DoD checklist, the
 * limits dialog and the orchestrator log are all `'use client'`
 * components and must not pull the `server-only` module into the bundle.
 */
export type GoalDoDStatus = 'open' | 'done' | 'waived';
export type GoalDoDSource = 'operator' | 'planner';
export type GoalLoopStatus = 'running' | 'paused' | 'done' | 'cancelled' | 'stuck';
export type GoalExecutionTarget = 'cloud' | 'local-runner';
export type GoalEventKind =
    | 'route'
    | 'dispatch'
    | 'complete'
    | 'limit'
    | 'nudge'
    | 'control'
    | 'dod';

export const GOAL_DOD_STATUSES: GoalDoDStatus[] = ['open', 'done', 'waived'];
export const GOAL_LOOP_STATUSES: GoalLoopStatus[] = [
    'running',
    'paused',
    'done',
    'cancelled',
    'stuck',
];
export const GOAL_EXECUTION_TARGETS: GoalExecutionTarget[] = ['cloud', 'local-runner'];

/** Mirrors the server-side bounds so the forms can refuse locally too. */
export const MAX_GOAL_DOD_CRITERIA = 50;
export const MAX_DOD_TEXT_CHARS = 500;
export const MAX_DOD_EVIDENCE_CHARS = 1000;
export const MAX_DOD_NOTE_CHARS = 500;
export const MAX_NUDGE_CHARS = 2000;
