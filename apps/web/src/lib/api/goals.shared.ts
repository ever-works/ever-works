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
 * Spec FR-12: per-Goal evaluation frequency is clamped server-side to
 * a minimum of 15 minutes regardless of what the form submits. Mirror
 * of `MIN_CHECK_FREQUENCY_MINUTES` from the agent package so the form
 * can surface the hint without importing the agent barrel.
 */
export const MIN_CHECK_FREQUENCY_MINUTES = 15;
export const DEFAULT_CHECK_FREQUENCY_MINUTES = 60;
