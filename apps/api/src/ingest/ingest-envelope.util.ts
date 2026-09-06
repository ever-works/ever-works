/**
 * Small pure helpers shared by the inbound normalizers (GitHub issues,
 * Dependabot, Jira, Sentry). They exist so every receiver keeps its
 * envelopes inside the `ingested_events` column widths and never hands
 * the spine an `occurredAt` it will reject.
 *
 * The PR-review bridge carries private twins of these; they are
 * deliberately NOT exported from there (a sibling slice owns that file),
 * so the new normalizers share this module instead.
 */

/** `ingested_events.sourceEventId` is `varchar(200)`. */
export const INGESTED_EVENT_SOURCE_EVENT_ID_MAX_CHARS = 200;
/** `ingested_events.subjectExternalId` is `varchar(200)`. */
export const INGESTED_EVENT_SUBJECT_EXTERNAL_ID_MAX_CHARS = 200;
/** `ingested_events.title` is `varchar(500)`. */
export const INGESTED_EVENT_TITLE_MAX_CHARS = 500;
/** `ingested_events.actorName` is `varchar(200)`. */
export const INGESTED_EVENT_ACTOR_MAX_CHARS = 200;
/** `ingested_events.sourceUrl` is `varchar(2048)`. */
export const INGESTED_EVENT_SOURCE_URL_MAX_CHARS = 2048;
/**
 * Free-text cap inside envelope payloads (issue bodies, descriptions).
 * The payload itself is capped at 32 KB serialized by the spine; this
 * keeps one field from eating the whole budget.
 */
export const INGESTED_EVENT_TEXT_MAX_CHARS = 4000;

/** Keep a value inside its `ingested_events` column width. */
export function capped(value: string, max: number): string {
    return value.length > max ? value.slice(0, max) : value;
}

/**
 * A source-reported timestamp when it parses, otherwise now.
 *
 * The spine REJECTS an envelope whose `occurredAt` will not parse, so a
 * malformed provider timestamp must never reach it — losing the true
 * time is a much smaller loss than losing the event.
 */
export function isoOrNow(value: string | number | null | undefined): string {
    if (typeof value === 'number' && Number.isFinite(value)) {
        // Sentry / Jira sometimes report unix epochs (seconds or ms).
        const ms = value < 1e12 ? value * 1000 : value;
        const parsed = new Date(ms);
        if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
    if (typeof value === 'string' && value.length > 0) {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
    return new Date().toISOString();
}

/** A non-empty trimmed string, or undefined. */
export function nonEmpty(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * An `https:` URL kept inside the `sourceUrl` column, or undefined.
 * Provider payloads are unverified data — a non-https or oversized link
 * is dropped rather than persisted as a deep link.
 */
export function httpsUrl(value: unknown): string | undefined {
    const raw = nonEmpty(value);
    if (!raw) return undefined;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return undefined;
    }
    if (url.protocol !== 'https:') return undefined;
    if (url.username.length > 0 || url.password.length > 0) return undefined;
    return capped(url.toString(), INGESTED_EVENT_SOURCE_URL_MAX_CHARS);
}
