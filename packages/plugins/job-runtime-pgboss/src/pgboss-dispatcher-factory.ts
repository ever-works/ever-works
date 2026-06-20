import type { PgBossFactoryOptions, PgBossInstance, PgBossJobRecord } from './pgboss-types.js';

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
		return this.opts.boss.send(name, payload, merged);
	}

	/** Cancel an in-flight job by id. Returns true once the cancel call resolves. */
	async cancel(jobId: string): Promise<boolean> {
		try {
			await this.opts.boss.cancel(jobId);
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
