import type { JobEnqueueOptions } from '@ever-works/plugin';
import type { TriggerTaskOptions } from './trigger-types.js';

/**
 * EW-742 P4 T31 — translator: platform `JobEnqueueOptions` →
 * Trigger.dev `TriggerOptions` carrier per `providers.md` § Trigger.dev.
 *
 * Trigger.dev's `tasks.trigger(taskId, payload, opts)` accepts a rich
 * native options bag — most of the platform enqueue knobs have direct
 * counterparts. Tenant routing lands on `metadata.tenantId` so the
 * tenant-aware webhook handler can demultiplex by tag/payload field per
 * § Trigger.dev "shared" inherit mode (per-tenant projects switch the
 * underlying client instead).
 *
 *   - `idempotencyKey`     → `idempotencyKey` (Trigger.dev SDK native;
 *                            same key within the configured dedup
 *                            window collapses to one run).
 *   - `tenantId`           → `metadata.tenantId` (Trigger.dev's per-run
 *                            `metadata` is JSON-shaped; the tenant
 *                            webhook handler reads it for routing in
 *                            shared / tagged-shared inherit mode).
 *   - `concurrencyKey`     → `concurrencyKey` (SDK native).
 *   - `tags`               → `tags` (SDK native, array of strings; used
 *                            for filtering in the Trigger.dev UI).
 *   - `maxDurationSeconds` → `maxDuration` (SDK native, in seconds).
 *   - `machineHint`        → `machine` (SDK native — `'small-1x'` /
 *                            `'small-2x'` / etc. Operator-supplied
 *                            string passed through verbatim; Trigger.dev
 *                            validates against its accepted preset list
 *                            at trigger time).
 *
 * Per-tenant Trigger.dev CLIENT selection happens BEFORE this call —
 * the caller picks the right `TriggerClient` (per the snapshot's
 * `projectAccessToken`) via the plugin's `dispatchersBuilder` hook.
 *
 * The translator returns the full `TriggerTaskOptions` shape so the
 * dispatcher can spread it onto the SDK call directly.
 */
export interface MappedTriggerEnqueue {
	/**
	 * Translated options ready to spread into
	 * `client.tasks.trigger(taskId, payload, mapped)`. Includes
	 * `metadata.tenantId` when `JobEnqueueOptions.tenantId` was set.
	 */
	readonly options: TriggerTaskOptions;
}

export function mapEnqueueOptions(opts: JobEnqueueOptions): MappedTriggerEnqueue {
	const options: {
		idempotencyKey?: string;
		concurrencyKey?: string;
		tags?: readonly string[];
		maxDuration?: number;
		machine?: string;
		metadata?: Record<string, unknown>;
	} = {};

	if (opts.idempotencyKey !== undefined) options.idempotencyKey = opts.idempotencyKey;
	if (opts.concurrencyKey !== undefined) options.concurrencyKey = opts.concurrencyKey;
	if (opts.tags !== undefined) options.tags = opts.tags;
	if (opts.maxDurationSeconds !== undefined) options.maxDuration = opts.maxDurationSeconds;
	if (opts.machineHint !== undefined) options.machine = opts.machineHint;
	if (opts.tenantId !== undefined) options.metadata = { tenantId: opts.tenantId };

	return { options };
}
