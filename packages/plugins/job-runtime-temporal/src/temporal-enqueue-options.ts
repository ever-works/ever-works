import type { JobEnqueueOptions } from '@ever-works/plugin';
import type { TemporalStartWorkflowOptions } from './temporal-types.js';

/**
 * EW-742 P4 T31 — translator: platform `JobEnqueueOptions` → Temporal
 * `WorkflowStartOptions` carrier per `providers.md` § Temporal.
 *
 * Temporal has rich native fields, so most translations are direct:
 *
 *   - `idempotencyKey`    → `workflowId` (Temporal's idempotency key
 *                           is the workflow id itself — re-starting
 *                           with the same id is rejected unless the
 *                           `workflowIdReusePolicy` allows it).
 *   - `tenantId`          → `searchAttributes.tenantId` (per
 *                           providers.md). The per-tenant Temporal
 *                           NAMESPACE selection happens at
 *                           start-workflow time by the operator's
 *                           `dispatchersBuilder` (one WorkflowClient
 *                           per tenant namespace, per ADR-017 Q1).
 *   - `concurrencyKey`    → `searchAttributes.concurrencyKey` (we use
 *                           a searchable attribute so the operator's
 *                           workflow can `await condition()` on it
 *                           for serialisation, OR they can use
 *                           workflowIdReusePolicy='reject-duplicate').
 *   - `maxDurationSeconds`→ `workflowExecutionTimeout` (string form;
 *                           Temporal accepts seconds via string like
 *                           '900s').
 *   - `tags`              → `searchAttributes.tags` (Temporal supports
 *                           list-valued attributes natively).
 *   - `machineHint`       → `memo.machineHint` (informational; Temporal
 *                           doesn't route by machine class).
 *
 * # workflowId priority
 *
 * If both `idempotencyKey` AND a per-call `workflowId` are provided,
 * the per-call `workflowId` wins (the operator may want a structured
 * id like `kb-embed:work-7:rev-2`). When neither is set, the caller
 * MUST pass `workflowId` to `factory.start()` — the translator never
 * invents one.
 *
 * # searchAttributes shape
 *
 * Temporal expects search attributes as `Record<string, unknown[]>`
 * (list-valued for indexing). We wrap scalar values in single-element
 * arrays.
 */
export interface MappedTemporalEnqueue {
	/** Workflow id derived from idempotencyKey, or undefined if not set. */
	readonly workflowIdFromIdempotency: string | undefined;
	readonly startOptions: Partial<Omit<TemporalStartWorkflowOptions, 'workflowId' | 'args'>>;
}

export function mapEnqueueOptions(opts: JobEnqueueOptions): MappedTemporalEnqueue {
	const searchAttributes: Record<string, readonly unknown[]> = {};
	const memo: Record<string, unknown> = {};
	if (opts.tenantId !== undefined) searchAttributes['tenantId'] = [opts.tenantId];
	if (opts.concurrencyKey !== undefined) searchAttributes['concurrencyKey'] = [opts.concurrencyKey];
	if (opts.tags !== undefined && opts.tags.length > 0) searchAttributes['tags'] = [...opts.tags];
	if (opts.machineHint !== undefined) memo['machineHint'] = opts.machineHint;

	const mutableStart: {
		searchAttributes?: Record<string, readonly unknown[]>;
		memo?: Record<string, unknown>;
		workflowExecutionTimeout?: string;
	} = {};
	if (Object.keys(searchAttributes).length > 0) mutableStart.searchAttributes = searchAttributes;
	if (Object.keys(memo).length > 0) mutableStart.memo = memo;
	if (opts.maxDurationSeconds !== undefined) {
		mutableStart.workflowExecutionTimeout = `${opts.maxDurationSeconds}s`;
	}

	return {
		workflowIdFromIdempotency: opts.idempotencyKey,
		startOptions: mutableStart as Partial<Omit<TemporalStartWorkflowOptions, 'workflowId' | 'args'>>
	};
}
