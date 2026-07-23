import type { JobEnqueueOptions } from '@ever-works/plugin';
import type { PgBossFactoryOptions, PgBossInstance, PgBossJobRecord } from './pgboss-types.js';
import { mapEnqueueOptions } from './pgboss-enqueue-options.js';

/**
 * EW-742 P3.2 follow-up — operator-facing factory that wraps a
 * pg-boss instance and exposes per-queue dispatcher functions.
 *
 * # Usage (operator-side worker app)
 *
 * ```ts
 * import PgBoss from 'pg-boss';
 * import { PgBossJobRuntimePlugin, PgBossDispatcherFactory } from '@ever-works/job-runtime-pgboss-plugin';
 *
 * const boss = new PgBoss({ connectionString: process.env.PGBOSS_CONNECTION_STRING!, schema: 'ew' });
 * await boss.start();
 *
 * const factory = new PgBossDispatcherFactory({ boss });
 * const plugin = new PgBossJobRuntimePlugin().useDispatchers({
 *   dispatchKbEmbedDocument: (payload) => factory.send('kb-embed-document', payload)
 * }).useDispatcherFactory(factory);
 * ```
 *
 * # Per-tenant schema isolation
 *
 * For tenant-scoped schema isolation (ADR-017 Q2), build one PgBoss
 * instance per tenant schema and wrap each in its own factory; pass
 * the per-tenant factory through `PgBossJobRuntimePluginOptions.dispatchersBuilder`
 * so `bindToTenant(snap)` views route to the right schema's send().
 */
export class PgBossDispatcherFactory {
	constructor(private readonly opts: PgBossFactoryOptions) {}

	/** Queues already created this process (createQueue is idempotent but hits the DB). */
	private readonly ensuredQueues = new Set<string>();

	/**
	 * jobId -> queue name for jobs this dispatcher has sent, so `cancel(jobId)`
	 * can call pg-boss v10's `cancel(name, id)` (v10 removed the by-id-only form).
	 * Bounded (insertion-order eviction) so a long-lived dispatcher can't leak;
	 * the realistic cancel pattern is "cancel a job I just scheduled", which is
	 * always in the recent window.
	 *
	 * LIMITATION: only the instance that SENT the job knows its queue. A cancel
	 * issued from a different process/instance won't find it here and returns
	 * false. The fully general fix is to thread the queue name through the
	 * platform's `cancel(runId)` contract (or persist a jobId->queue map);
	 * tracked as a follow-up.
	 */
	private readonly sentJobQueue = new Map<string, string>();
	private static readonly MAX_TRACKED = 50_000;

	private rememberJobQueue(id: string | null, queue: string): void {
		if (!id) return;
		if (this.sentJobQueue.size >= PgBossDispatcherFactory.MAX_TRACKED) {
			const oldest = this.sentJobQueue.keys().next().value;
			if (oldest !== undefined) this.sentJobQueue.delete(oldest);
		}
		this.sentJobQueue.set(id, queue);
	}

	/**
	 * pg-boss v10 no longer auto-creates a queue on first `send` — sending to a
	 * queue that was never `createQueue`'d silently returns `null` and drops the
	 * job. Ensure it exists before the first send (cached per process so the hot
	 * path only pays the DB round-trip once per queue).
	 */
	private async ensureQueue(name: string): Promise<void> {
		if (this.ensuredQueues.has(name) || !this.opts.boss.createQueue) return;
		// Default ('standard') policy: a queue must hold many concurrent jobs
		// (multi-tenant, batched). Idempotency is NOT a queue policy here — a
		// keyed 'short'/'stately' policy would cap the queue to one job and break
		// those. Instead `mapEnqueueOptions` pairs `singletonKey` with
		// `singletonSeconds` per send, which dedups same-key jobs on a standard
		// queue while leaving unkeyed/different-key jobs unaffected.
		await this.opts.boss.createQueue(name);
		this.ensuredQueues.add(name);
	}

	/** Underlying pg-boss instance — exposed for operator advanced lifecycle. */
	get boss(): PgBossInstance {
		return this.opts.boss;
	}

	/**
	 * Enqueue one job. Returns the pg-boss-assigned id, or `null` when
	 * pg-boss returns null (e.g. dedup hit on `singletonKey`).
	 */
	async send(name: string, payload: unknown, callOpts?: Readonly<Record<string, unknown>>): Promise<string | null> {
		const merged = this.opts.defaultSendOptions
			? { ...this.opts.defaultSendOptions, ...(callOpts ?? {}) }
			: callOpts;
		await this.ensureQueue(name);
		const id = await this.opts.boss.send(name, payload, merged);
		this.rememberJobQueue(id, name);
		return id;
	}

	/**
	 * EW-742 P4 T31 — enqueue with platform-canonical
	 * `JobEnqueueOptions`. Translates each field onto the pg-boss
	 * carrier per `providers.md` § pg-boss:
	 *
	 *   - `idempotencyKey`    → `sendOptions.singletonKey`
	 *   - `maxDurationSeconds`→ `sendOptions.expireInSeconds`
	 *   - `tenantId` / `concurrencyKey` / `tags` / `machineHint` →
	 *     stamped onto the job payload under a reserved `_ew`
	 *     namespace so the worker can route per-tenant without
	 *     requiring custom pg-boss columns.
	 *
	 * Per-tenant schema selection happens BEFORE this call — the
	 * caller picks the right `PgBoss` instance via the plugin's
	 * `dispatchersBuilder` hook (one `PgBoss` per tenant schema, per
	 * ADR-017 Q2).
	 *
	 * `extraOpts` is shallow-merged on top of the translated
	 * sendOptions so operators can still pass pg-boss-native fields
	 * (retryLimit, retryBackoff, startAfter, etc.) that have no
	 * `JobEnqueueOptions` equivalent.
	 */
	async enqueue(
		name: string,
		payload: Readonly<Record<string, unknown>> | null,
		enqueueOptions: JobEnqueueOptions,
		extraOpts?: Readonly<Record<string, unknown>>
	): Promise<string | null> {
		const { sendOptions, metaForPayload } = mapEnqueueOptions(enqueueOptions);
		const mergedPayload =
			Object.keys(metaForPayload).length > 0 ? { ...(payload ?? {}), ...metaForPayload } : (payload ?? {});
		const baseOpts = this.opts.defaultSendOptions
			? { ...this.opts.defaultSendOptions, ...sendOptions }
			: sendOptions;
		const mergedOpts = extraOpts ? { ...baseOpts, ...extraOpts } : baseOpts;
		await this.ensureQueue(name);
		const id = await this.opts.boss.send(name, mergedPayload, mergedOpts);
		this.rememberJobQueue(id, name);
		return id;
	}

	/**
	 * Cancel an in-flight job by id. pg-boss v10 requires the queue name
	 * (`cancel(name, id)` — the by-id-only form was removed), so this resolves
	 * the queue from what this dispatcher sent. Returns false if the queue is
	 * unknown here (e.g. the job was sent by a different instance — see
	 * `sentJobQueue`) or the cancel call itself fails.
	 */
	async cancel(jobId: string): Promise<boolean> {
		const queue = this.sentJobQueue.get(jobId);
		if (!queue) return false;
		try {
			await this.opts.boss.cancel(queue, jobId);
			this.sentJobQueue.delete(jobId);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Best-effort lookup of pg-boss's lifecycle state for a job. Returns
	 * `null` when pg-boss's `getJobById` is unavailable (e.g. mocked
	 * instance in operator tests).
	 */
	async getJob(jobId: string): Promise<PgBossJobRecord | null> {
		if (!this.opts.boss.getJobById) return null;
		try {
			return await this.opts.boss.getJobById(jobId);
		} catch {
			return null;
		}
	}
}
