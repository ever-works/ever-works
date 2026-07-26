import type { JobEnqueueOptions } from '@ever-works/plugin';
import { clampLeaseTtlSec, FLEET_JOB_MAX_REQUIRED_CAPABILITIES } from '@ever-works/contracts';

/**
 * Translator: platform-canonical `JobEnqueueOptions` → fleet job row
 * fields, the `node` runtime's answer to `mapEnqueueOptions` in every
 * sibling provider.
 *
 * Mapping rules (fleet-specific carriers, same semantics):
 *
 *   - `idempotencyKey`     → `idempotencyKey` (UNIQUE column; a re-send
 *                            of the same logical job reuses the row
 *                            instead of doubling work onto the fleet).
 *   - `tags`               → `requiredCapabilities`. This is the whole
 *                            point of the fleet runtime: a tag is not
 *                            just an observability label here, it is the
 *                            scheduling predicate deciding WHICH machine
 *                            may lease the job. Only `cap:`-prefixed
 *                            tags are treated as capability
 *                            requirements, so an ordinary observability
 *                            tag can never accidentally narrow a job to
 *                            zero eligible nodes.
 *   - `maxDurationSeconds` → `leaseTtlSec` (a job whose node goes quiet
 *                            for longer than its own wall-clock budget
 *                            is by definition dead).
 *   - `tenantId` /
 *     `concurrencyKey` /
 *     `machineHint`        → stamped onto the payload under a reserved
 *                            `_ew` namespace, so the node-side executor
 *                            can route without needing new columns —
 *                            the same carrier convention pg-boss uses.
 *
 * Pure function: no I/O, trivially unit-testable, composable with
 * operator overrides.
 */

/** Prefix that marks a tag as a scheduling requirement, not a label. */
export const CAPABILITY_TAG_PREFIX = 'cap:';

export interface MappedNodeEnqueue {
	/** Capability tags a node must advertise to lease the job. */
	readonly requiredCapabilities: string[];
	/** Reserved-namespace fields to merge onto the job payload. */
	readonly metaForPayload: Readonly<Record<string, unknown>>;
	/** Idempotency key, or null when the caller supplied none. */
	readonly idempotencyKey: string | null;
	/** Clamped lease TTL derived from the run's wall-clock budget. */
	readonly leaseTtlSec: number;
}

export function mapEnqueueOptions(opts: JobEnqueueOptions = {}): MappedNodeEnqueue {
	const requiredCapabilities: string[] = [];
	for (const tag of opts.tags ?? []) {
		if (typeof tag !== 'string') continue;
		if (!tag.startsWith(CAPABILITY_TAG_PREFIX)) continue;
		const capability = tag.slice(CAPABILITY_TAG_PREFIX.length).trim();
		if (!capability || requiredCapabilities.includes(capability)) continue;
		requiredCapabilities.push(capability);
		if (requiredCapabilities.length >= FLEET_JOB_MAX_REQUIRED_CAPABILITIES) break;
	}

	const meta: Record<string, unknown> = {};
	if (opts.tenantId !== undefined) meta['tenantId'] = opts.tenantId;
	if (opts.concurrencyKey !== undefined) meta['concurrencyKey'] = opts.concurrencyKey;
	if (opts.machineHint !== undefined) meta['machineHint'] = opts.machineHint;
	if (opts.tags !== undefined) meta['tags'] = opts.tags;

	return {
		requiredCapabilities,
		metaForPayload: Object.keys(meta).length > 0 ? { _ew: meta } : {},
		idempotencyKey: typeof opts.idempotencyKey === 'string' ? opts.idempotencyKey : null,
		leaseTtlSec: clampLeaseTtlSec(opts.maxDurationSeconds)
	};
}
