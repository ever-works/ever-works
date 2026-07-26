import type { FleetJobKind, FleetJobStatus, FleetJobView } from '@ever-works/contracts';

/**
 * Ports the `node` job runtime binds to.
 *
 * The plugin package must NOT import `@ever-works/agent` (that would be
 * a package cycle: agent → plugin). It therefore declares the narrow
 * store/lease ports it needs and the operator supplies an adapter over
 * `FleetJobService` at wiring time — exactly the shape every sibling
 * runtime uses for its own client (`PgBossInstance`, the BullMQ
 * connection, the Temporal client).
 */

/** What `enqueue` needs to write one lease-able fleet job row. */
export interface FleetJobEnqueueRequest {
	/** Owner whose fleet may execute this job. */
	userId: string;
	organizationId?: string | null;
	kind: FleetJobKind;
	payload?: Record<string, unknown> | null;
	/** Capability tags a node must advertise to be eligible. */
	requiredCapabilities?: string[];
	maxAttempts?: number;
	idempotencyKey?: string | null;
}

/**
 * The server-side store the dispatcher writes to. One method per real
 * operation; every one is already implemented by `FleetJobService`, so
 * the operator adapter is a pass-through.
 */
export interface FleetJobStore {
	enqueue(request: FleetJobEnqueueRequest): Promise<FleetJobView>;
	/** Look up a job by id. Returns null for unknown ids — never throws. */
	findById?(jobId: string): Promise<FleetJobView | null>;
	/**
	 * Best-effort cancellation. A job that has not been leased yet can be
	 * dropped outright; a leased one can only be marked, since a node
	 * already holds it. Absent on stores that do not support it.
	 */
	cancel?(jobId: string): Promise<boolean>;
}

/** Options for the dispatcher factory. */
export interface NodeDispatcherFactoryOptions {
	readonly store: FleetJobStore;
	/**
	 * Owner every enqueue is attributed to when the call site does not
	 * supply one. Required, because a fleet job with no owner can never
	 * be leased — nodes only ever see their own owner's work.
	 */
	readonly defaultUserId?: string;
	/** Capability tags added to every job this factory enqueues. */
	readonly defaultRequiredCapabilities?: readonly string[];
}

/**
 * The node-side lease surface a worker host polls. Implemented over
 * HTTP by `apps/node` (`FleetJobClient`), and by an in-process fake in
 * tests.
 */
export interface FleetLeaseTransport {
	lease(request: { max: number; leaseTtlSec?: number }): Promise<FleetJobView[]>;
	heartbeat(jobId: string, leaseTtlSec?: number): Promise<boolean>;
	complete(
		jobId: string,
		outcome: {
			success: boolean;
			result?: Record<string, unknown> | null;
			error?: string | null;
		}
	): Promise<boolean>;
}

/** One registered executor: "this is how a job of kind X gets run". */
export type FleetJobHandler = (job: FleetJobView) => Promise<Record<string, unknown> | void>;

/** Provider-status projection of a fleet job's lifecycle. */
export const FLEET_JOB_STATUS_TO_RUN_STATUS: Readonly<
	Record<FleetJobStatus, 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'>
> = {
	queued: 'queued',
	leased: 'queued',
	running: 'running',
	done: 'completed',
	failed: 'failed'
};
