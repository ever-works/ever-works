/**
 * EW-P4-3 — the request-body limit for the inbound-email webhooks.
 *
 * The API parses JSON / urlencoded bodies with a tight global limit (1 MB,
 * `BODY_LIMIT`, see `main.ts`) so a small public endpoint cannot be used to
 * make the parser buffer large bodies. A provider's inbound webhook is the
 * one public route that legitimately carries large bodies: Postmark posts the
 * whole message as JSON with base64 attachments, Mailgun as form fields. With
 * the global limit, any message with more than ~1 MB of attachments was
 * refused (413) before its signature was even checked, so the inbound
 * attachment budget (`MAX_INBOUND_ATTACHMENT_BYTES`) was unreachable.
 *
 * `main.ts` mounts parsers with THIS limit on `INBOUND_EMAIL_WEBHOOK_PATH`
 * only, ahead of the global ones. Default 25 MB — the `proxy-body-size` the
 * Ever Works ingress already allows on every environment, so a body the
 * ingress lets through is no longer refused by the API. Base64 adds a third,
 * so that admits roughly 18 MB of attachments per message. Operators may
 * raise it with `INBOUND_EMAIL_BODY_LIMIT` (and the ingress with it), up to a
 * hard ceiling; an invalid or over-ceiling value falls back to the default.
 */
export const INBOUND_EMAIL_WEBHOOK_PATH = '/api/email/inbound';

export const DEFAULT_INBOUND_EMAIL_BODY_LIMIT = '25mb';

/** {@link DEFAULT_INBOUND_EMAIL_BODY_LIMIT} in bytes. */
export const DEFAULT_INBOUND_EMAIL_BODY_LIMIT_BYTES = 25 * 1024 * 1024;

/** Hard ceiling for `INBOUND_EMAIL_BODY_LIMIT` (Postmark's own inbound cap is 35 MB). */
export const MAX_INBOUND_EMAIL_BODY_LIMIT_BYTES = 50 * 1024 * 1024;

/** `1mb`, `512kb`, `1048576` → bytes; `null` when it is not a byte size. */
export function parseByteSize(value: string): number | null {
    const trimmed = value.trim().toLowerCase();
    const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/.exec(trimmed);
    if (!match) return null;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return null;
    const unit = match[2] ?? 'b';
    const multiplier =
        unit === 'gb' ? 1024 ** 3 : unit === 'mb' ? 1024 ** 2 : unit === 'kb' ? 1024 : 1;
    return amount * multiplier;
}

/**
 * The body limit for the inbound-email webhooks, in BYTES: the parsed
 * `requested` size when it is valid and within the ceiling, else the default
 * (with a warning). A number, not the raw text, so the parsers enforce exactly
 * the size validated here — body-parser reads an unrecognised string such as
 * `" 25mb "` (stray whitespace) as 25 bytes.
 */
export function resolveInboundEmailBodyLimit(
    requested: string | undefined,
    warn: (message: string) => void = (message) => {
        // eslint-disable-next-line no-console
        console.warn(message);
    },
): number {
    if (!requested?.trim()) return DEFAULT_INBOUND_EMAIL_BODY_LIMIT_BYTES;
    const parsed = parseByteSize(requested);
    if (parsed === null || parsed <= 0 || parsed > MAX_INBOUND_EMAIL_BODY_LIMIT_BYTES) {
        warn(
            `[bootstrap] INBOUND_EMAIL_BODY_LIMIT="${requested}" is invalid or exceeds the ${MAX_INBOUND_EMAIL_BODY_LIMIT_BYTES}-byte cap; falling back to ${DEFAULT_INBOUND_EMAIL_BODY_LIMIT}.`,
        );
        return DEFAULT_INBOUND_EMAIL_BODY_LIMIT_BYTES;
    }
    return Math.floor(parsed);
}
