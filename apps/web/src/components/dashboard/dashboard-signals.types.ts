/**
 * Dashboard "signal" DTOs — the wire-only shapes surfaced by the
 * Attention and Soon home blocks (Dashboard blocks spec §2.2). These
 * are read-only projections composed server-side from already-shipped
 * entities; there is no persistence and no migration behind them.
 *
 * Kept as a directive-free, types-only module so it can be imported by
 * both the server compose (`(home)/dashboard-data.ts`) and the client
 * render components (`AttentionSection` / `SoonSection`) without
 * dragging a `server-only` guard across the RSC boundary.
 */

/**
 * A single "needs action right now" signal. `schedule-failed` and
 * `schedule-paused` are part of the contract but only start being
 * emitted once the Schedules front ships its aggregation — the compose
 * simply doesn't produce them until then.
 */
export type AttentionKind =
    | 'agent-error'
    | 'schedule-failed'
    | 'schedule-paused'
    | 'generation-failed'
    | 'task-blocked'
    | 'budget-exceeded';

export interface AttentionItem {
    /** Stable per underlying row, e.g. `agent:${agentId}`. */
    id: string;
    kind: AttentionKind;
    /** Maps to the RecentTasks danger/warning tone tokens. */
    severity: 'danger' | 'warning';
    /** Primary subject — entity name/title (agent name, task title, idea title). */
    label?: string;
    /** Optional numeric qualifier (consecutive failures, blocked count). */
    count?: number;
    /** Deep link to the offending entity — always derived server-side from an owned row. */
    href: string;
    /** ISO timestamp — used to sort most-recent-first within a severity band. */
    occurredAt?: string;
}

/** One upcoming scheduled run, projected from the Schedules front's aggregation. */
export interface SoonRunItem {
    id: string;
    sourceKind: 'work-schedule' | 'mission';
    /** Work or Mission title. */
    title: string;
    /** ISO timestamp of the next run. */
    nextRunAt: string;
    /** Deep link to the underlying Work / Mission. */
    href: string;
}
