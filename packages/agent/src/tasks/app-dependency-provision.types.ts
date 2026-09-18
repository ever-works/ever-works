/**
 * APW-07 T17 — the `app-dependency-provision` payload contract
 * (plan §7:864-888, CONTRACTS §5).
 *
 * `AppDependenciesService` emits one of these whenever a dependency has to be
 * provisioned, re-read or released; the task on APW-06's `app-cluster-io` queue
 * claims the row's lease, dials the provider through the facade and settles the
 * row. Everything else the job needs is re-derived from the database at run
 * time, which is why the payload is ids and flags only:
 *
 *   - a job runtime REPLAYS the original payload on a retry, so anything cached
 *     here would be stale by the time it runs (a dependency re-configured
 *     between enqueue and run would be provisioned from the old spec block);
 *   - the lease, the deadline and the outputs bookkeeping are all row state, and
 *     the row is the single writer's record of them.
 *
 * ## `mode`
 *
 * | Mode          | What one run does                                                                 |
 * | ------------- | --------------------------------------------------------------------------------- |
 * | `provision`   | one provider `provision` attempt, persisted (FR-41, FR-43)                          |
 * | `refresh`     | re-read the outputs and the backup state, bumping `outputsVersion` only on change   |
 * | `deprovision` | release (`deleteData: false`) or destroy (`deleteData: true`) what the provider made |
 *
 * ## The delayed re-dispatch, and why two fields carry it
 *
 * A `pending` outcome re-dispatches the same kind after `retryAfterMs` (capped
 * at 30 s, plan §7:875-876) rather than sleeping inside the job. The delay rides
 * the payload in the two spellings the codebase already uses for it:
 *
 *   - {@link AppDependencyProvisionPayload.notBefore} — epoch milliseconds, the
 *     arithmetic form the runner computes the budget in;
 *   - {@link AppDependencyProvisionPayload.deferUntil} — the same instant as
 *     ISO-8601, which is the exact shape `TriggerService` already turns into the
 *     runtime's `delay` option (`packages/tasks/src/trigger/trigger.service.ts:581-591`,
 *     the notification-channel-delivery precedent).
 *
 * Both are optional and both are honoured (the dispatcher prefers `deferUntil`
 * and falls back to `notBefore`), so a producer that only knows one of them does
 * not have to guess.
 *
 * ## `requestedAtMs`
 *
 * Epoch ms of the FIRST attempt of this chain, echoed on every re-dispatch, so
 * the kind's readiness deadline (FR-41) is measured from a value the work
 * carries rather than from a second clock read (plan §7:875). Absent means "this
 * chain starts now".
 *
 * No value, no configuration and no output is ever carried here (FR-5,
 * Constitution VII): the worker decrypts what it needs from the row.
 */

import type { AppDependencyKind } from '@ever-works/contracts';

/** What a single `app-dependency-provision` run is for (plan §7:868-877). */
export type AppDependencyProvisionMode = 'provision' | 'refresh' | 'deprovision';

/** The `app-dependency-provision` payload — the shape both the dispatcher and the task carry. */
export interface AppDependencyProvisionPayload {
    /** The App Work whose dependency row this run is for. */
    readonly workId: string;
    /**
     * The kind this run is for. Absent means "every active dependency of this
     * Work", which is how a Work-wide release reaches the job in one message;
     * `reconcile` and the routes always name one kind.
     */
    readonly kind?: AppDependencyKind;
    readonly mode: AppDependencyProvisionMode;
    /**
     * `deprovision` only: destroy the volume/database/bucket rather than keep it.
     * True only after the owner typed the App Work slug (FR-46, R-15); absent or
     * false means **keep** — the provider is asked to release, never to delete.
     */
    readonly deleteData?: boolean;
    /** The user whose Retry / Configure / Delete-data action asked for this (Activity attribution). */
    readonly requestedByUserId?: string;
    /** Epoch ms of the first attempt of this chain — the deadline's origin (plan §7:875). */
    readonly requestedAtMs?: number;
    /** When this run should start, in epoch milliseconds — the arithmetic form of `deferUntil`. */
    readonly notBefore?: number;
    /** The same instant as ISO-8601 — the form `TriggerService` maps onto the runtime's `delay`. */
    readonly deferUntil?: string;
}
