/**
 * Request-recorder redaction for bearer secrets that must never be written
 * down: share-link tokens and the view sessions exchanged for them.
 *
 * Defence in depth. No API route takes a share token in its path or query
 * string, but every place the platform records a request — request logs,
 * error monitoring, product analytics — passes URLs and messages through
 * these helpers before writing, so a future route, a proxied page address or
 * a mistake cannot reintroduce the token into a record.
 *
 * Pure string functions, no dependencies, safe on any input.
 */

export const REDACTED_MARKER = '[redacted]';

/** `/share/<token>` with or without a locale prefix; the token is 16+ URL-safe characters. */
const SHARE_PATH = /(\/share\/)[A-Za-z0-9_-]{16,}/g;
/** A secret-named query parameter: `?token=`, `&viewSession=`, `view_session=`. */
const SECRET_QUERY = /([?&;](?:token|view_?session)=)[^&#\s]*/gi;
/** `Bearer <credential>` wherever it appears in text. */
const BEARER = /(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi;
/** A JSON-ish `"token": "..."` / `"viewSession": "..."` pair. */
const JSON_SECRET = /("(?:token|viewSession|view_session)"\s*:\s*")[^"]*(")/gi;

/**
 * Redact a URL (or a `METHOD url` line) for recording: a share token after a
 * `/share/` segment and any secret-named query value become `[redacted]`.
 * Anything else — including every ordinary path — is returned unchanged.
 */
export function redactSecretUrl<T extends string | null | undefined>(url: T): T {
    if (typeof url !== 'string' || url.length === 0) return url;
    return url
        .replace(SHARE_PATH, `$1${REDACTED_MARKER}`)
        .replace(SECRET_QUERY, `$1${REDACTED_MARKER}`) as T;
}

/**
 * Redact free text for recording (an error message, a log line, a
 * serialised body): everything {@link redactSecretUrl} does, plus `Bearer`
 * credentials and JSON `token` / `viewSession` values.
 */
export function redactSecretValue<T extends string | null | undefined>(text: T): T {
    if (typeof text !== 'string' || text.length === 0) return text;
    return redactSecretUrl(text)
        .replace(BEARER, `$1${REDACTED_MARKER}`)
        .replace(JSON_SECRET, `$1${REDACTED_MARKER}$2`) as T;
}
