import type { JobEnqueueOptions } from '@ever-works/plugin';
import type { FleetJobKind, FleetJobView } from '@ever-works/contracts';
import { isFleetJobKind } from '@ever-works/contracts';
import { mapEnqueueOptions } from './node-enqueue-options.js';
import type { FleetJobStore, NodeDispatcherFactoryOptions } from './node-types.js';

/**
 * Operator-facing factory that turns the owner's FLEET into a queue.
 *
 * Where `PgBossDispatcherFactory` wraps a pg-boss instance and
 * `BullMqDispatcherFactory` wraps a Redis connection, this wraps the
 * `fleet_jobs` store: `enqueue` writes one lease-able row, and the
 * machines the owner enrolled in Fleet poll for it over the same
 * outbound-only channel enrollment and heartbeat already use.
 *
 * # Usage (operator-side, API process)
 *
 * ```ts
 * import { NodeJobRuntimePlugin, NodeDispatcherFactory } from '@ever-works/job-runtime-node-plugin';
 *
 * const factory = new NodeDispatcherFactory({
 *   store: {
 *     enqueue: (req) => fleetJobService.enqueue(req),
 *     findById: (id) => fleetJobService.findViewById(id)
 *   }
 * });
 * const plugin = new NodeJobRuntimePlugin().useDispatcherFactory(factory);
 * ```
 *
 * # Why `userId` is required
 *
 * A fleet job with no owner can never be leased: a node only ever sees
 * its OWN owner's queued work (least privilege — §6.3 of the Desktop
 * PRD). `enqueue` therefore refuses rather than writing an orphan row
 * nothing will ever pick up.
 */
export class NodeJobOwnerRequiredError extends Error {
	constructor() {
		super(
			'@ever-works/job-runtime-node-plugin: every fleet job needs an owner (userId). ' +
				'Pass it per-call or set `defaultUserId` on the dispatcher factory — a job with no ' +
				"owner can never be leased, because a node only sees its own owner's work."
		);
		this.name = 'NodeJobOwnerRequiredError';
	}
}

export interface NodeEnqueueRequest {
	kind: FleetJobKind;
	payload?: Record<string, unknown> | null;
	userId?: string;
	organizationId?: string | null;
	maxAttempts?: number;
	/** Extra capability requirements beyond the `cap:` tags in the options. */
	requiredCapabilities?: readonly string[];
	/**
	 * Why the job is queued with nothing able to run it yet (today only
	 * `waiting-for-runner`). Forwarded verbatim to the store; omitted
	 * means "queued normally".
	 */
	queuedReason?: string | null;
}

export class NodeDispatcherFactory {
	constructor(private readonly opts: NodeDispatcherFactoryOptions) {}

	/** The store this factory writes to — exposed for operator lifecycle. */
	get store(): FleetJobStore {
		return this.opts.store;
	}

	/**
	 * Enqueue one job onto the fleet. Returns the created (or, on an
	 * idempotency hit, the pre-existing) job's id.
	 */
	async enqueue(request: NodeEnqueueRequest, enqueueOptions: JobEnqueueOptions = {}): Promise<string> {
		if (!isFleetJobKind(request.kind)) {
			throw new Error(
				`@ever-works/job-runtime-node-plugin: unsupported fleet job kind '${String(request.kind)}'`
			);
		}
		const userId = request.userId ?? this.opts.defaultUserId;
		if (!userId) {
			throw new NodeJobOwnerRequiredError();
		}

		const mapped = mapEnqueueOptions(enqueueOptions);
		const requiredCapabilities = dedupe([
			...(this.opts.defaultRequiredCapabilities ?? []),
			...(request.requiredCapabilities ?? []),
			...mapped.requiredCapabilities
		]);

		const payload =
			Object.keys(mapped.metaForPayload).length > 0
				? { ...(request.payload ?? {}), ...mapped.metaForPayload }
				: (request.payload ?? null);

		const created = await this.opts.store.enqueue({
			userId,
			organizationId: request.organizationId ?? null,
			kind: request.kind,
			payload,
			requiredCapabilities,
			...(request.maxAttempts !== undefined ? { maxAttempts: request.maxAttempts } : {}),
			...(request.queuedReason !== undefined ? { queuedReason: request.queuedReason } : {}),
			idempotencyKey: mapped.idempotencyKey
		});
		return created.id;
	}

	/**
	 * Best-effort lookup. Returns null when the store cannot resolve the
	 * id (unknown job, or a store that does not implement lookup) rather
	 * than throwing — callers treat null as "stale, try the DB instead".
	 */
	async getJob(jobId: string): Promise<FleetJobView | null> {
		if (!this.opts.store.findById) return null;
		try {
			return await this.opts.store.findById(jobId);
		} catch {
			return null;
		}
	}

	/**
	 * Ask the store to cancel a job. Returns false when the store has no
	 * cancel support or the call fails — a cancel that could not be
	 * delivered must read as "not cancelled", never as success.
	 */
	async cancel(jobId: string): Promise<boolean> {
		if (!this.opts.store.cancel) return false;
		try {
			return await this.opts.store.cancel(jobId);
		} catch {
			return false;
		}
	}
}

function dedupe(values: readonly string[]): string[] {
	const out: string[] = [];
	for (const value of values) {
		if (typeof value !== 'string') continue;
		const trimmed = value.trim();
		if (!trimmed || out.includes(trimmed)) continue;
		out.push(trimmed);
	}
	return out;
}
