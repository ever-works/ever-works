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
}

/** Type guard — true when a plugin declares the `event-source` capability. */
export function isEventSourcePlugin(plugin: IPlugin): plugin is IEventSourcePlugin {
	return plugin.capabilities.includes('event-source');
}
