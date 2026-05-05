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

export function redactString(value: string, secrets: ReadonlyArray<string>): string {
    let out = value;
    for (const secret of secrets) {
        if (secret && secret.length >= 4) {
            out = out.split(secret).join(REDACTED);
        }
    }
    return out;
}
