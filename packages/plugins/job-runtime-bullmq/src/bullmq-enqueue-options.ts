import type { JobEnqueueOptions } from '@ever-works/plugin';

/**
 * EW-742 P4 T31 — translator: platform `JobEnqueueOptions` → BullMQ
 * `JobsOptions` carrier per `providers.md`.
 *
 * Mapping rules (locked in `tasks.md` T31):
 *
 *   - `idempotencyKey` → `jobId` (BullMQ's dedup mechanism — same
 *     jobId in the same queue is rejected at `Queue.add` time).
 *   - `tenantId`       → custom `tenantId` field on `JobsOptions` (the
 *     "native carrier" per `providers.md` § BullMQ); workers read it
 *     off `job.opts.tenantId` to route per-tenant.
 *   - `concurrencyKey` → custom `concurrencyKey` field; BullMQ Pro
 *     supports `group.id` natively but plain BullMQ doesn't, so the
 *     worker honours it via the `concurrencyKey` field.
 *   - `tags`           → custom `tags` field (BullMQ doesn't tag
 *     natively; preserved for observability).
 *   - `maxDurationSeconds` → no direct BullMQ option (the worker
 *     enforces its own `lockDuration`/`lockRenewTime`); we surface
 *     it on `maxDurationSeconds` for the operator's handler to honor.
 *   - `machineHint`    → custom `machineHint` field; BullMQ doesn't
 *     route by machine class.
 *
 * Every translated field is `undefined`-safe: a missing entry on the
 * input is omitted from the output (NOT written as `undefined`) so
 * downstream `Object.keys` walks see a clean payload.
 *
 * The translator is intentionally a pure function — easy to unit-test
 * and to compose with a per-call `extraOpts` spread.
 */
export function mapEnqueueOptions(opts: JobEnqueueOptions): Readonly<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	if (opts.idempotencyKey !== undefined) out['jobId'] = opts.idempotencyKey;
	if (opts.tenantId !== undefined) out['tenantId'] = opts.tenantId;
	if (opts.concurrencyKey !== undefined) out['concurrencyKey'] = opts.concurrencyKey;
	if (opts.tags !== undefined) out['tags'] = opts.tags;
	if (opts.maxDurationSeconds !== undefined) out['maxDurationSeconds'] = opts.maxDurationSeconds;
	if (opts.machineHint !== undefined) out['machineHint'] = opts.machineHint;
	return out;
}
