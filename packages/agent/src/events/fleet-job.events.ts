import type { FleetJobView, FleetModelUsageLimit } from '@ever-works/contracts';
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
    | 'cancelled'
    /**
     * The queue SLA failed a job no eligible runner took within its
     * kind's max queued age (self-build slice S). `error` carries the
     * stable `queued-max-age-exceeded` prefix.
     */
    | 'queue-expired';

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

/**
 * Fleet usage limits — a node handed a job back because its model CLI is out
 * of quota, and the platform PARKED it: the job is `queued` again (attempt
 * refunded, `queuedReason: 'model-usage-limit'`), the node is throttled for
 * that CLI until `limit.retryAfter`, and nothing reached a verdict.
 *
 * Deliberately NOT a {@link FleetJobCompletedEvent}: every consumer of that
 * event treats it as the end of the run (failure counts, Inbox "run failed",
 * Task state). A park is the opposite — the run continues after the reset —
 * so it travels as its own fact and the reconciler re-queues the AgentRun
 * and files at most one notice per node per throttle window (`newWindow`).
 */
export class FleetJobParkedEvent extends BaseEvent {
    static EVENT_NAME = 'fleet.job.parked';

    constructor(
        /** The job as it now stands (`queued`). */
        public readonly job: FleetJobView,
        public readonly userId: string,
        /** Node that reported the limit. */
        public readonly nodeId: string,
        /** Its display name, for the notice. */
        public readonly nodeName: string | null,
        /** Which CLI, which window, until when — `retryAfter` already clamped. */
        public readonly limit: FleetModelUsageLimit,
        /** True when this opened a NEW throttle window for that node + CLI (notify once). */
        public readonly newWindow: boolean,
    ) {
        super();
    }
}

/**
 * Self-build slice Z (EW-796) — a run-scoped MCP credential was minted
 * for a job the node holds.
 *
 * The audit trail for the bridge, on the SAME event bus every other job
 * lifecycle fact travels on, so an operator can answer "did this run
 * have platform tools, and for how long" from the job's own history —
 * without depending on the `fleet_audit` table (a sibling slice owns
 * that, and the bridge must not couple to it).
 *
 * The token itself is NOT on this event and never will be. What is here
 * is what an auditor needs: which job, which run, which node asked, and
 * when the credential stops working.
 */
export class FleetJobMcpCredentialMintedEvent extends BaseEvent {
    static EVENT_NAME = 'fleet.job.mcp-credential.minted';

    constructor(
        public readonly jobId: string,
        public readonly userId: string,
        public readonly nodeId: string,
        /** Platform `AgentRun` the credential acts for, when the job carries one. */
        public readonly runId: string | null,
        /** Organization the token's scope is pinned to; null = personal. */
        public readonly organizationId: string | null,
        /** When the credential stops being accepted (lease deadline + grace). */
        public readonly expiresAt: Date,
        /**
         * True when this mint ROTATED an earlier token for the same job
         * (the node re-mints as its lease is renewed). A rotation
         * deactivates every predecessor, so at most one token per job is
         * ever live.
         */
        public readonly rotated: boolean = false,
    ) {
        super();
    }
}

/**
 * Every run-scoped credential for a job was revoked.
 *
 * Emitted by the mint path's rotation, by the node's explicit
 * post-model-step revoke, and by the API-side listener that reacts to
 * `FleetJobCompletedEvent` — so `done`, `failed`, `cancelled` and
 * `lease-exhausted` all converge on the same fact being recorded.
 */
export class FleetJobMcpCredentialRevokedEvent extends BaseEvent {
    static EVENT_NAME = 'fleet.job.mcp-credential.revoked';

    constructor(
        public readonly jobId: string,
        /** How many still-active tokens were deactivated (0 = nothing to do). */
        public readonly revoked: number,
        /** What triggered the revoke, for the audit line. */
        public readonly reason: 'rotation' | 'node-request' | 'job-settled',
        public readonly runId: string | null = null,
    ) {
        super();
    }
}
