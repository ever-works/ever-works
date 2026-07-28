import type { IngestedEventEnvelope } from '@ever-works/contracts';
import type { IPlugin } from '../plugin.interface.js';
import type { PluginSettings } from '../../settings/settings.types.js';

/**
 * Event-source capability (Wave 6) — plugins that surface external
 * events into the platform's event-ingest spine (capability
 * `event-source`).
 *
 * v1 is PULL-model: the platform's `event-ingest-tick` cron (and, per
 * connector, activation-time backfill) calls `pullEvents` with a
 * watermark + opaque cursor and receives normalized
 * `IngestedEventEnvelope` rows. Webhook PUSH lands with each concrete
 * connector — pushed events flow through the same envelope shape via
 * `POST /api/ingest/events`, so nothing upstream changes.
 *
 * Dedupe contract: `(source, sourceEventId)` is the event identity.
 * Implementations may re-deliver events freely (overlapping windows,
 * retries, backfill) — the ingest pipeline drops duplicates.
 *
 * Historical catch-up is the OPTIONAL `backfill()` method on this same
 * capability (see {@link EventSourceBackfillInput}). It used to be a
 * private, settings-shaped convention re-invented inside each connector
 * (`backfillDays` widening the first pull); promoting it onto the
 * contract means every connector exposes history the same way, callers
 * feature-detect once with {@link supportsEventSourceBackfill}, and a
 * connector with no history to offer simply omits the method and keeps
 * loading exactly as before.
 */
export interface EventSourcePullInput {
	/** ISO 8601 watermark — return events that occurred at/after this. */
	since: string;
	/**
	 * Opaque continuation cursor from a previous pull. Implementations
	 * define the format; callers only round-trip it.
	 */
	cursor?: string;
	/** Resolved plugin settings (4-level hierarchy, resolved upstream). */
	settings?: PluginSettings;
}

export interface EventSourcePullResult {
	/** Normalized events, oldest-first preferred. */
	events: IngestedEventEnvelope[];
	/** Present when more events remain — pass back on the next pull. */
	nextCursor?: string;
}

/**
 * Upper bound on the opt-in historical backfill window, in days.
 *
 * Shared by every connector so "how far back can I go?" has ONE answer
 * across the fabric instead of a per-plugin constant that drifts.
 */
export const EVENT_SOURCE_BACKFILL_MAX_DAYS = 90;

/**
 * Normalize a user-supplied backfill window (settings value, API body,
 * env var) to a whole number of days inside `0 … max`.
 *
 * `0` means "backfill off" and is the safe default for every garbage
 * input (`undefined`, `'nope'`, `NaN`, negatives) — an unparseable
 * window must never widen the sweep.
 */
export function clampEventSourceBackfillDays(value: unknown, max: number = EVENT_SOURCE_BACKFILL_MAX_DAYS): number {
	const num = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(num) || num <= 0) return 0;
	return Math.min(Math.floor(num), max);
}

/**
 * Input for an explicit, bounded HISTORICAL sweep — the opt-in
 * `backfill()` capability method.
 *
 * `pullEvents` is the incremental, watermark-driven half of an event
 * source: it answers "what happened since the last sweep?". `backfill`
 * is the out-of-band half: "go fetch this window of history, once".
 * Activation-time catch-up, a user clicking "import the last 30 days",
 * and a repair sweep after an outage all speak this shape.
 */
export interface EventSourceBackfillInput {
	/** ISO 8601 lower bound (inclusive) of the historical window. */
	since: string;
	/**
	 * ISO 8601 upper bound. Defaults to "now" when absent. Sources whose
	 * API cannot bound the far end (Drive/Calendar `updatedMin`-style
	 * filters) MAY ignore it — over-wide windows are free because the
	 * ingest pipeline dedupes on `(source, sourceEventId)`.
	 */
	until?: string;
	/**
	 * Opaque continuation cursor from a previous `backfill` page. Callers
	 * only round-trip it; the format is the implementation's business
	 * (sharing it with `pullEvents` is fine and encouraged).
	 */
	cursor?: string;
	/** Resolved plugin settings (4-level hierarchy, resolved upstream). */
	settings?: PluginSettings;
}

/**
 * Result of one `backfill` page. Same shape as a pull page plus an
 * explicit `complete` flag, so a caller does not have to infer "done"
 * from a missing cursor when a source wants to say it out loud.
 */
export interface EventSourceBackfillResult extends EventSourcePullResult {
	/** True when the requested window is fully drained. */
	complete?: boolean;
}

/**
 * Thrown when the event source cannot pull in this runtime/config
 * (missing credentials, no workspace connected, …). Matched BY NAME
 * across packages — maps to a loud, actionable failure upstream, never
 * a silent no-op.
 */
export class EventSourceNotConfiguredError extends Error {
	constructor(message?: string) {
		super(message ?? 'Event-source plugin is not configured in this runtime.');
		this.name = 'EventSourceNotConfiguredError';
	}
}

/** Event-source plugin interface — capability `event-source`. */
export interface IEventSourcePlugin extends IPlugin {
	readonly providerName: string;

	/** Pull normalized events since the watermark (cursor-paged). */
	pullEvents(input: EventSourcePullInput): Promise<EventSourcePullResult>;

	/**
	 * OPTIONAL — bounded historical sweep over an explicit window.
	 *
	 * Optional on purpose: a source with no history to offer (a webhook
	 * relay, a live-only feed) simply omits it and still loads and pulls
	 * exactly as before. Callers MUST feature-detect with
	 * {@link supportsEventSourceBackfill} rather than assume.
	 *
	 * Implementations MUST stay bounded: cap the pages fetched per call
	 * and hand back a `nextCursor` so a long window resumes instead of
	 * turning one activation into an unbounded crawl. Re-delivering
	 * events already ingested is fine — `(source, sourceEventId)` dedupe
	 * makes overlap free.
	 */
	backfill?(input: EventSourceBackfillInput): Promise<EventSourceBackfillResult>;
}

/** Type guard — true when a plugin declares the `event-source` capability. */
export function isEventSourcePlugin(plugin: IPlugin): plugin is IEventSourcePlugin {
	return plugin.capabilities.includes('event-source');
}

/**
 * Feature-detect the optional `backfill()` method.
 *
 * Checks the METHOD, not a capability string: `backfill` is opt-in
 * within the `event-source` capability, so a connector advertises it by
 * implementing it. Callers must materialize a lazily-loaded plugin
 * BEFORE calling this — a cold lazy proxy's synchronous surface is
 * empty, so an un-materialized plugin reports `false` (fail-closed,
 * which is the safe direction: worst case the caller skips a backfill
 * it could have run).
 */
export function supportsEventSourceBackfill(
	plugin: IPlugin
): plugin is IEventSourcePlugin & Required<Pick<IEventSourcePlugin, 'backfill'>> {
	return isEventSourcePlugin(plugin) && typeof (plugin as IEventSourcePlugin).backfill === 'function';
}
