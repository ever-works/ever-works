import type { JobEnqueueOptions } from '@ever-works/plugin';
import type { InngestSendEvent } from './inngest-types.js';

/**
 * EW-742 P4 T31 — translator: platform `JobEnqueueOptions` → Inngest
 * `SendEvent` carrier per `providers.md` § Inngest.
 *
 * Inngest's `send()` accepts a few top-level fields (`id`, `user`)
 * and a free-form `data` payload. The platform's enqueue options map
 * onto a mix of native and `data._ew` passthroughs:
 *
 *   - `idempotencyKey`     → top-level `id` (Inngest's native event id
 *                            de-dup mechanism — same id within the
 *                            de-dup window collapses to one delivery).
 *   - `tenantId`           → `data._ew.tenantId` (per providers.md;
 *                            tenant webhook handler routes per this
 *                            field).
 *   - `concurrencyKey`     → `data._ew.concurrencyKey` (operator
 *                            handles via Inngest function `concurrency`
 *                            config; we surface the value so the
 *                            function's concurrency key callback can
 *                            return it).
 *   - `tags`               → `data._ew.tags`
 *   - `maxDurationSeconds` → `data._ew.maxDurationSeconds` (operator
 *                            handles via per-function `step.run`
 *                            timeouts; informational here).
 *   - `machineHint`        → `data._ew.machineHint`
 *
 * Per-tenant Inngest CLIENT selection happens BEFORE this call — the
 * caller picks the right `Inngest` client (eventKey + signingKey) via
 * the plugin's `dispatchersBuilder` hook (SaaS-only per providers.md).
 *
 * The translator returns `{ topLevel, dataMeta }` so the dispatcher
 * spreads `topLevel` onto the event AND merges `dataMeta` under
 * `data._ew`.
 */
export interface MappedInngestEnqueue {
	/**
	 * Fields that go ON the event itself (top-level), NOT under data.
	 * Currently just `id` for idempotency.
	 */
	readonly topLevel: Partial<Pick<InngestSendEvent, 'id'>>;
	/**
	 * Fields stamped under `data._ew` so the operator's Inngest function
	 * (or tenant webhook handler) can read them.
	 */
	readonly dataMeta: Readonly<Record<string, unknown>>;
}

export function mapEnqueueOptions(opts: JobEnqueueOptions): MappedInngestEnqueue {
	const topLevel: { id?: string } = {};
	const dataMeta: Record<string, unknown> = {};
	if (opts.idempotencyKey !== undefined) topLevel.id = opts.idempotencyKey;
	if (opts.tenantId !== undefined) dataMeta['tenantId'] = opts.tenantId;
	if (opts.concurrencyKey !== undefined) dataMeta['concurrencyKey'] = opts.concurrencyKey;
	if (opts.tags !== undefined) dataMeta['tags'] = opts.tags;
	if (opts.maxDurationSeconds !== undefined) dataMeta['maxDurationSeconds'] = opts.maxDurationSeconds;
	if (opts.machineHint !== undefined) dataMeta['machineHint'] = opts.machineHint;
	return { topLevel, dataMeta };
}
