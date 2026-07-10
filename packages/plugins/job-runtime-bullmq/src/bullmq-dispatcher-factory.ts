import type { JobEnqueueOptions } from '@ever-works/plugin';
import type { BullMqDeps, BullMqFactoryOptions, BullMqQueueAdapter } from './bullmq-types.js';
import { mapEnqueueOptions } from './bullmq-enqueue-options.js';

/**
 * EW-742 P3.2 follow-up — operator-facing factory that turns a single
 * BullMQ Redis connection into per-queue dispatcher functions.
 *
 * # Usage (operator-side, in their worker app)
 *
 * ```ts
 * import { Queue, Worker } from 'bullmq';
 * import IORedis from 'ioredis';
 * import { BullMqJobRuntimePlugin, BullMqDispatcherFactory } from '@ever-works/job-runtime-bullmq-plugin';
 *
 * const connection = new IORedis(process.env.BULLMQ_REDIS_URL!, { maxRetriesPerRequest: null });
 * const factory = new BullMqDispatcherFactory({ Queue, Worker }, { connection, prefix: 'ew' });
 *
 * const kbEmbed = factory.forQueue('kb-embed-document');
 * const plugin = new BullMqJobRuntimePlugin().useDispatchers({
 *   dispatchKbEmbedDocument: async (payload) => kbEmbed.dispatch('kb-embed-document', payload, {
 *     jobId: payload.idempotencyKey,
 *     attempts: 3
 *   })
 * });
 * ```
 *
 * # Per-tenant prefix isolation
 *
 * For tenant-scoped Redis prefix isolation (ADR-017 Q-bullmq), build
 * one factory per tenant prefix and use the
 * `BullMqJobRuntimePlugin.dispatchersBuilder` hook on the plugin so
 * `bindToTenant` returns a view whose `dispatchers` use the right
 * tenant's queues. See `bullmq-job-runtime.plugin.ts` for the hook.
 *
 * # Lifecycle
 *
 *   - `forQueue(name)` lazily constructs (and memoises) one `Queue`
 *     instance per name. The same instance is reused across
 *     `dispatch()` calls — which is what bullmq recommends to keep the
 *     `bclient` blocking-pop connection count bounded.
 *   - `close()` calls `queue.close()` on every cached queue. The shared
 *     connection itself is NOT closed here — the operator owns it.
 */

export interface BullMqDispatcher {
	/**
	 * Enqueue one job. Returns the bullmq-assigned job id, or `null` if
	 * the queue rejected the enqueue (e.g. dedup hit on `jobId`).
	 *
	 * The `name` arg is the bullmq job name (subtype within the queue);
	 * for single-job-per-queue setups, pass the queue name again.
	 *
	 * `opts` is a thin pass-through to `Queue.add`'s opts. Per-call
	 * options shallow-merge over the factory's `defaultJobOptions`.
	 */
	dispatch(name: string, payload: unknown, opts?: Readonly<Record<string, unknown>>): Promise<string | null>;
	/**
	 * EW-742 P4 T31 — enqueue with platform-canonical `JobEnqueueOptions`.
	 * The factory translates each field onto the BullMQ-native carrier
	 * per `providers.md` § BullMQ:
	 *
	 *   - `idempotencyKey` → `JobsOptions.jobId`
	 *   - `tenantId`       → custom `JobsOptions.tenantId`
	 *   - `concurrencyKey` → custom `JobsOptions.concurrencyKey`
	 *   - `tags`           → custom `JobsOptions.tags`
	 *   - `maxDurationSeconds` / `machineHint` → custom passthroughs
	 *
	 * `extraOpts` is shallow-merged on top of the translation so the
	 * operator can still pass bullmq-native options (priority, lifo,
	 * attempts, backoff) that have no `JobEnqueueOptions` equivalent.
	 */
	enqueue(
		name: string,
		payload: unknown,
		enqueueOptions: JobEnqueueOptions,
		extraOpts?: Readonly<Record<string, unknown>>
	): Promise<string | null>;
	/** Underlying queue handle — exposed for advanced lifecycle (drain, pause). */
	readonly queue: BullMqQueueAdapter;
}

export class BullMqDispatcherFactory {
	private readonly queues = new Map<string, BullMqQueueAdapter>();

	constructor(
		private readonly deps: BullMqDeps,
		private readonly opts: BullMqFactoryOptions
	) {}

	/**
	 * Lazily build (and cache) a dispatcher for one queue. Subsequent
	 * calls with the same `queueName` return the same dispatcher.
	 */
	forQueue(queueName: string): BullMqDispatcher {
		let queue = this.queues.get(queueName);
		if (!queue) {
			const queueOpts: Record<string, unknown> = { connection: this.opts.connection };
			if (this.opts.prefix !== undefined) {
				queueOpts['prefix'] = this.opts.prefix;
			}
			if (this.opts.defaultJobOptions !== undefined) {
				queueOpts['defaultJobOptions'] = this.opts.defaultJobOptions;
			}
			queue = new this.deps.Queue(queueName, queueOpts);
			this.queues.set(queueName, queue);
		}
		const q = queue;
		return {
			queue: q,
			dispatch: async (name, payload, callOpts) => {
				const merged = callOpts ? { ...callOpts } : undefined;
				const job = await q.add(name, payload, merged);
				return job?.id ?? null;
			},
			enqueue: async (name, payload, enqueueOptions, extraOpts) => {
				const translated = mapEnqueueOptions(enqueueOptions);
				const merged = extraOpts ? { ...translated, ...extraOpts } : translated;
				const job = await q.add(name, payload, merged);
				return job?.id ?? null;
			}
		};
	}

	/**
	 * Cancel a job by id across known queues. Returns `true` when the
	 * job was found and removal succeeded in any queue.
	 *
	 * BullMQ doesn't expose a global id → queue lookup, so we try each
	 * cached queue. Operators that need exact-queue cancel should call
	 * `forQueue(name).queue.getJob(id)?.remove()` directly.
	 */
	async cancel(jobId: string): Promise<boolean> {
		for (const q of this.queues.values()) {
			if (!q.getJob) continue;
			try {
				const job = await q.getJob(jobId);
				if (job) {
					await job.remove();
					return true;
				}
			} catch {
				// Try next queue.
			}
		}
		return false;
	}

	/** Close every cached queue. Idempotent. The shared connection is NOT closed. */
	async close(): Promise<void> {
		const queues = Array.from(this.queues.values());
		this.queues.clear();
		await Promise.allSettled(queues.map((q) => q.close()));
	}

	/** Number of distinct queues created so far — useful for tests / metrics. */
	get queueCount(): number {
		return this.queues.size;
	}
}
