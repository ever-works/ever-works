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
 * The external containers a connector can name when it does NOT know the
 * platform `workId` (which is almost always — a connector sees Slack
 * channels and GitHub repos, never Ever Works ids).
 *
 * Deliberately a closed union: the platform resolver has to understand
 * every kind it routes, so a connector inventing `kind: 'whatever'`
 * must fail to compile rather than silently resolve to `null` forever.
 */
export type IngestedEventWorkHintKind =
	/** Git host repository. `externalId` = `owner/repo`, lowercase-compared. */
	| 'repo'
	/** Chat channel. `externalId` = the channel's stable id (e.g. `C0123456789`). */
	| 'chat-channel'
	/** Issue-tracker team / project. `externalId` = team key or id. */
	| 'tracker-team'
	/** Doc-suite database / collection. `externalId` = database id. */
	| 'doc-database'
	/** Meeting room / recurring meeting. `externalId` = meeting id. */
	| 'meeting';

/**
 * `workId` routing hint — what external container this event belongs to,
 * in the SOURCE system's own vocabulary.
 *
 * Connectors populate this; the platform's ingest pipeline resolves it to
 * a real `workId` **within the owning user's Works only** (never across
 * users) and falls back to `null` when nothing matches. A hint is a hint:
 * an unresolvable one is not an error, it just leaves the event
 * user-scoped exactly as before.
 */
export interface IngestedEventWorkHint {
	kind: IngestedEventWorkHintKind;
	/**
	 * Stable identifier of the container in the source system. Matching
	 * is case-insensitive and whitespace-trimmed on both sides.
	 */
	externalId: string;
	/** Human-readable label (channel name, repo name, team name) — diagnostics only. */
	label?: string;
}

/** Serialized-hint caps, enforced at the API edge (DTO) and by the resolver. */
export const INGEST_WORK_HINT_EXTERNAL_ID_MAX_CHARS = 200;
export const INGEST_WORK_HINT_LABEL_MAX_CHARS = 200;

/**
 * Hint kinds a Work stores claims for in `works.externalRefs`.
 *
 * `repo` is excluded on purpose: a Work already declares its
 * repositories, and repo hints resolve through that existing identity
 * (one matcher, one source of truth) rather than a second hand-kept map.
 */
export type WorkExternalRefKind = Exclude<IngestedEventWorkHintKind, 'repo'>;

/** Ordered for stable UI rendering + exhaustive iteration in the resolver. */
export const WORK_EXTERNAL_REF_KINDS = [
	'chat-channel',
	'tracker-team',
	'doc-database',
	'meeting'
] as const satisfies readonly WorkExternalRefKind[];

/**
 * The external containers a Work claims, keyed by hint kind. Values are
 * the SOURCE system's ids (channel id, team key, database id, meeting
 * id), compared case-insensitively and trimmed.
 */
export type WorkExternalRefs = Partial<Record<WorkExternalRefKind, string[]>>;

/** Per-kind cap on claimed ids — bounds both the column and the resolver scan. */
export const WORK_EXTERNAL_REFS_MAX_PER_KIND = 50;

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
	/**
	 * Optional external-container hint the platform resolves to a
	 * `workId` when `workId` itself is unknown to the connector. Ignored
	 * when `workId` is present.
	 */
	workHint?: IngestedEventWorkHint;
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
