import type { JobEnqueueOptions } from '@ever-works/plugin';

/**
 * EW-742 P4 T31 — translator: platform `JobEnqueueOptions` → pg-boss
 * `send` options + per-job payload field per `providers.md`.
 *
 * pg-boss's native options object accepts most of what we need; a few
 * fields (tenantId, concurrencyKey, tags, machineHint) are not native
 * and surface as a `meta` field that the worker reads off
 * `job.data._ew` to route per-tenant (the spec calls this the "payload
 * field" carrier per `providers.md` § pg-boss).
 *
 * Mapping rules:
 *
 *   - `idempotencyKey`    → `singletonKey` (pg-boss's dedup mechanism)
 *   - `tenantId`          → returned in `metaForPayload._ew.tenantId`
 *                          + the per-tenant schema lookup is done
 *                          BEFORE publish by the dispatchers builder
 *                          (caller-side, see plugin
 *                          `dispatchersBuilder` hook)
 *   - `concurrencyKey`    → `metaForPayload._ew.concurrencyKey`
 *                          (pg-boss has no native concurrency-key;
 *                          worker honours)
 *   - `maxDurationSeconds`→ `expireInSeconds` (native: pg-boss kills
 *                          the job once this many seconds elapse)
 *   - `tags` / `machineHint` → `metaForPayload._ew` passthroughs
 *
 * The translator returns TWO outputs so the dispatcher can:
 *   1. shallow-merge `sendOptions` onto pg-boss's options arg
 *   2. shallow-merge `metaForPayload` onto the job's `data` arg under
 *      a reserved `_ew` namespace (workers know to look there)
 *
 * Pure function — easy to unit-test and to compose with operator
 * overrides.
 */
export interface MappedPgBossEnqueue {
	readonly sendOptions: Readonly<Record<string, unknown>>;
	readonly metaForPayload: Readonly<Record<string, unknown>>;
}

/**
 * Dedup horizon for a keyed (`idempotencyKey`) send — see mapEnqueueOptions.
 * 6h. pg-boss rejects a `singletonSeconds` greater than the queue's archive
 * interval (default 12h), so this stays comfortably under that ceiling while
 * still covering the realistic duplicate window (retries, double-submits).
 */
export const IDEMPOTENCY_WINDOW_SECONDS = 21_600;

export function mapEnqueueOptions(opts: JobEnqueueOptions): MappedPgBossEnqueue {
	const sendOptions: Record<string, unknown> = {};
	const meta: Record<string, unknown> = {};
	if (opts.idempotencyKey !== undefined) {
		sendOptions['singletonKey'] = opts.idempotencyKey;
		// pg-boss v10 no longer dedups on `singletonKey` alone (v9 did). On a
		// 'standard' queue, dedup requires pairing the key with `singletonSeconds`
		// — "at most one job per key within this window". We default to 24h so a
		// re-send of the same logical job (the point of an idempotencyKey) is
		// suppressed for a generous horizon; distinct keys are unaffected. This is
		// the multi-job-safe alternative to a keyed queue policy (which would cap
		// the whole queue to one job).
		sendOptions['singletonSeconds'] = IDEMPOTENCY_WINDOW_SECONDS;
	}
	if (opts.maxDurationSeconds !== undefined) sendOptions['expireInSeconds'] = opts.maxDurationSeconds;
	if (opts.tenantId !== undefined) meta['tenantId'] = opts.tenantId;
	if (opts.concurrencyKey !== undefined) meta['concurrencyKey'] = opts.concurrencyKey;
	if (opts.tags !== undefined) meta['tags'] = opts.tags;
	if (opts.machineHint !== undefined) meta['machineHint'] = opts.machineHint;
	const metaForPayload: Record<string, unknown> = Object.keys(meta).length > 0 ? { _ew: meta } : {};
	return { sendOptions, metaForPayload };
}
