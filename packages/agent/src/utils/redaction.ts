/**
 * Redaction policy for headers and JSON body fields that MAY carry secrets.
 *
 * The current `LoggingInterceptor` does not log request bodies or headers,
 * so this is a defence-in-depth utility for any future log site (Sentry
 * breadcrumbs, debug-mode dumps, custom interceptors). It also documents
 * the project-wide policy in one place.
 *
 * Add to `REDACTED_HEADERS` whenever a new endpoint accepts a sensitive
 * header (e.g. `X-GitHub-Token`, `X-Webhook-Secret`).
 */

const REDACTED = '[REDACTED]';

/** Headers that MUST be redacted from any log line that includes them. */
export const REDACTED_HEADERS: ReadonlyArray<string> = [
    'authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'x-github-token',
    'x-hub-signature-256',
    'x-ever-works-signature',
    'idempotency-key',
];

/** Top-level JSON body fields that MUST be redacted. */
export const REDACTED_BODY_FIELDS: ReadonlyArray<string> = [
    'password',
    'token',
    'accessToken',
    'refreshToken',
    'secret',
    'apiKey',
    'agentPayment',
];

export function redactHeaders(
    headers: Record<string, string | string[] | undefined> | undefined,
): Record<string, string | string[] | undefined> {
    if (!headers) return {};
    const out: Record<string, string | string[] | undefined> = {};
    const lower = new Set(REDACTED_HEADERS.map((h) => h.toLowerCase()));
    for (const [name, value] of Object.entries(headers)) {
        out[name] = lower.has(name.toLowerCase()) && value !== undefined ? REDACTED : value;
    }
    return out;
}

/**
 * Recursively walk a JSON-like value and redact any property whose key
 * matches {@link REDACTED_BODY_FIELDS} (case-insensitive).
 *
 * **Key-name match only** — no path patterns. If a nested field
 * carries a secret but its key isn't in `REDACTED_BODY_FIELDS`,
 * it's NOT redacted just because it's under a sensitive-looking
 * parent (`{config: {webhookSecret: '…'}}` requires
 * `'webhookSecret'` in the list, not just `'config'`). Extend
 * `REDACTED_BODY_FIELDS` whenever a new sensitive field name
 * appears anywhere in the payload schema.
 *
 * Pass-through for non-objects (primitives, `null`, `undefined`)
 * and arrays (descended into).
 */
export function redactBody(body: unknown): unknown {
    if (body === null || body === undefined) return body;
    if (typeof body !== 'object') return body;
    if (Array.isArray(body)) return body.map((item) => redactBody(item));

    const out: Record<string, unknown> = {};
    const lower = new Set(REDACTED_BODY_FIELDS.map((f) => f.toLowerCase()));
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        if (lower.has(k.toLowerCase())) {
            out[k] = REDACTED;
        } else if (v && typeof v === 'object') {
            out[k] = redactBody(v);
        } else {
            out[k] = v;
        }
    }
    return out;
}

/**
 * Replace each occurrence of a known-secret string with `[REDACTED]`.
 *
 * **Behaviours worth knowing:**
 *
 *   - **Case-sensitive substring match** via `split().join()`. The
 *     secret `'ghp_abc'` will redact `'ghp_abc'` but NOT `'GHP_ABC'`
 *     or `'Ghp_Abc'`. Most production secrets are case-stable so
 *     this is usually fine; widen to a case-insensitive match if
 *     you're scrubbing user-typed values.
 *
 *   - **Secrets shorter than 4 chars are SKIPPED** to avoid mass
 *     false-positives (`'k'` would redact every `k` in the string).
 *     If you need to redact a 3-char value, the caller has to do
 *     it themselves.
 *
 *   - **No regex escaping needed** — `split(secret)` treats the
 *     argument as a literal string, so a secret containing `.`,
 *     `*`, etc. matches verbatim.
 *
 *   - **Order matters** when secrets overlap. Earlier entries in
 *     the array are redacted first, so a long secret that contains
 *     a shorter one should appear before the short one.
 */
export function redactString(value: string, secrets: ReadonlyArray<string>): string {
    let out = value;
    for (const secret of secrets) {
        if (secret && secret.length >= 4) {
            out = out.split(secret).join(REDACTED);
        }
    }
    return out;
}
