import type { FleetJobView } from '@ever-works/contracts';
import { BaseEvent } from './base';

/**
 * Fleet job lifecycle events — agent execution v2, slice B.
 *
 * `FleetJobService` is the lease protocol: it knows when a node claimed
 * a job and when the job reached a verdict, and NOTHING else in the
 * platform used to learn either fact. An `agent-task` therefore ran on a
 * PC, finished, and its `AgentRun` sat `queued` until the stuck sweeper
 * reaped it hours later. These events are how the API-side reconciler
 * turns "the node said so" into AgentRun / Task / pull-request state.
 *
 * Emitted by the AGENT package, consumed on the API side (the same
 * direction `WorkCreatedEvent` flows), so `packages/agent` keeps zero
 * knowledge of what reconciliation means.
 */

/** A node won the CAS claim on a queued job. */
export class FleetJobLeasedEvent extends BaseEvent {
    static EVENT_NAME = 'fleet.job.leased';

    constructor(
        public readonly job: FleetJobView,
        /** Node holding the claim (the same id as `job.nodeId`). */
        public readonly nodeId: string,
        /** Owner the job belongs to. */
        public readonly userId: string,
    ) {
        super();
    }
}

/** Why a job reached its terminal state. */
export type FleetJobCompletionSource =
    /** The node reported a verdict through `POST /api/fleet/jobs/:id/complete`. */
    | 'node-report'
    /** The reclaim sweep exhausted the attempt budget without a verdict. */
    | 'lease-exhausted'
    /** An operator cancelled a job that no node had claimed yet. */
    | 'cancelled';

/**
 * A job reached `done` or `failed`.
 *
 * The verdict rides ON THE EVENT (`result` / `error`) rather than on the
 * wire view: `FleetJobView` deliberately omits both (a node's own report
 * echoed back to it, or a 256 KB result on every Fleet list, is neither
 * wanted), and a listener needs exactly this pair to reconcile.
 */
export class FleetJobCompletedEvent extends BaseEvent {
    static EVENT_NAME = 'fleet.job.completed';

    constructor(
        public readonly job: FleetJobView,
        public readonly userId: string,
        public readonly source: FleetJobCompletionSource,
        /** Node that reported, when one did. */
        public readonly nodeId: string | null = null,
        /** Executor output on success (per-kind shape), as stored on the row. */
        public readonly result: Record<string, unknown> | null = null,
        /** Failure detail on `failed`, as stored on the row. */
        public readonly error: string | null = null,
    ) {
        super();
    }

    get succeeded(): boolean {
        return this.job.status === 'done';
    }
}
