/**
 * Event-ingest spine (Wave 6) — the ONE normalized event shape every
 * connector produces and the platform pipeline consumes.
 *
 * External systems (chat workspaces, issue trackers, doc suites, git
 * hosts, …) emit wildly different event payloads. Each event-source
 * plugin normalizes its raw events into `IngestedEventEnvelope` rows;
 * the platform then fans a single pipeline out over them: dedupe-insert
 * → Activity-log entry → Memory observation (best-effort, with
 * provenance) → chat surfacing via the existing recall paths. Answers
 * and feed rows link back to the origin through `sourceUrl`.
 *
 * This package is the zero-dependency wire/storage shape only — no
 * runtime behavior lives here (same rule as `tasks/task-gates.types.ts`).
 */

/** Who did the thing in the external system (best-effort attribution). */
export interface IngestedEventActor {
	/** Display name as the source reports it. */
	name: string;
	/** Stable id in the source system (user id, login, …). */
	externalId?: string;
}

/** What the event happened TO in the external system. */
export interface IngestedEventSubject {
	/** Source-namespaced subject type, e.g. `channel`, `page`, `issue`. */
	type: string;
	/** Stable id of the subject in the source system. */
	externalId: string;
	/** Human-readable subject title, when the source provides one. */
	title?: string;
}

/**
 * One normalized external event.
 *
 * Identity: `(source, sourceEventId)` — the ingest pipeline dedupes on
 * it, so connectors may re-deliver the same event freely (webhook
 * retries, overlapping pull windows, historical backfill).
 */
export interface IngestedEventEnvelope {
	/** Connector-assigned envelope id (uuid recommended). */
	id: string;
	/** Producing plugin id, e.g. `slack-connector`. */
	source: string;
	/** The event's stable id in the source system. */
	sourceEventId: string;
	/**
	 * Source-namespaced event kind, e.g. `slack.message`,
	 * `github.pull_request.merged`. Free-form string on purpose — the
	 * platform never enumerates connector kinds.
	 */
	kind: string;
	/** ISO 8601 timestamp of when the event happened at the source. */
	occurredAt: string;
	actor?: IngestedEventActor;
	subject?: IngestedEventSubject;
	/** Deep link to the original message / PR / page / commit. */
	sourceUrl?: string;
	/**
	 * Source-specific details. Size-capped: the serialized payload must
	 * stay within {@link INGEST_EVENT_PAYLOAD_MAX_BYTES}.
	 */
	payload: Record<string, unknown>;
	/** Optional Work routing hint resolved by the connector. */
	workId?: string;
	/** Optional Organization scope hint. */
	organizationId?: string;
}

/**
 * Serialized-payload byte cap per envelope. Enforced at the API edge
 * (DTO validation) and defensively re-checked by the ingest service.
 */
export const INGEST_EVENT_PAYLOAD_MAX_BYTES = 32 * 1024;

/** Maximum envelopes accepted per ingest call / batch. */
export const INGEST_EVENT_BATCH_MAX = 100;
