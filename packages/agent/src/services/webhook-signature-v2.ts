import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhooks v2 signature (EW-P1-5, integration contract v1 B.5 —
 * `docs/specs/features/integrations-api-v1/contract/webhook-signature-vectors.json`).
 *
 * `X-Ever-Works-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<rawBody>")>`
 *
 * - The HMAC key is the secret string exactly as issued, as UTF-8 bytes (never
 *   base64-decoded).
 * - During a secret rotation's grace window the header carries one `v1=` per
 *   live secret (current first); a receiver accepts when ANY matches.
 * - Receivers reject a timestamp more than {@link WEBHOOK_V2_TOLERANCE_SECONDS}
 *   away from their clock (inclusive window).
 *
 * The same scheme as Gauzy's `verifyWebhookSignature`, so one verifier serves
 * both directions. v1 subscriptions keep `X-Ever-Works-Signature-256`.
 */
export const WEBHOOK_V2_SIGNATURE_HEADER = 'X-Ever-Works-Signature';
export const WEBHOOK_V2_EVENT_ID_HEADER = 'X-Ever-Works-Event-Id';
export const WEBHOOK_V2_TOLERANCE_SECONDS = 300;

/** hex(HMAC-SHA256(secret, "<t>.<rawBody>")), `t` exactly as it appears in the header. */
export function computeWebhookV2Digest(
    rawBody: string,
    secret: string,
    timestampSeconds: number | string,
): string {
    return createHmac('sha256', Buffer.from(secret, 'utf8'))
        .update(`${timestampSeconds}.${rawBody}`, 'utf8')
        .digest('hex');
}

/**
 * The `X-Ever-Works-Signature` value for `rawBody`, with one `v1=` per secret
 * (the current secret first, then a rotated-out secret still in its grace window).
 */
export function signWebhookV2(
    rawBody: string,
    secrets: readonly string[],
    timestampSeconds: number,
): string {
    const live = secrets.filter((secret) => typeof secret === 'string' && secret.length > 0);
    if (live.length === 0) throw new Error('signWebhookV2 needs at least one secret');
    if (!Number.isInteger(timestampSeconds)) {
        throw new Error('signWebhookV2 needs an integer unix timestamp (seconds)');
    }
    return [
        `t=${timestampSeconds}`,
        ...live.map((secret) => `v1=${computeWebhookV2Digest(rawBody, secret, timestampSeconds)}`),
    ].join(',');
}

const HEX = /^[0-9a-f]+$/i;

/**
 * Reference verifier (receiver side), exactly the published rules:
 * split on `,`, trim each part, take the first `t=` and every `v1=`; reject a
 * missing / non-finite `t` or no `v1`; reject `|now - t| > tolerance`; accept
 * when ANY `v1` equals the expected digest, compared in constant time. A `v1`
 * of another length or not hex is a mismatch, never an exception.
 */
export function verifyWebhookV2Signature(
    rawBody: string,
    header: string | null | undefined,
    secret: string,
    nowSeconds: number = Math.floor(Date.now() / 1000),
    toleranceSeconds: number = WEBHOOK_V2_TOLERANCE_SECONDS,
): boolean {
    if (typeof header !== 'string' || header.length === 0) return false;
    let timestamp: string | undefined;
    const signatures: string[] = [];
    for (const raw of header.split(',')) {
        const part = raw.trim();
        if (part.startsWith('t=')) {
            if (timestamp === undefined) timestamp = part.slice(2);
        } else if (part.startsWith('v1=')) {
            signatures.push(part.slice(3));
        }
    }
    if (timestamp === undefined || timestamp.trim() === '' || signatures.length === 0) {
        return false;
    }
    const t = Number(timestamp);
    if (!Number.isFinite(t)) return false;
    if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;

    const expected = Buffer.from(computeWebhookV2Digest(rawBody, secret, timestamp), 'utf8');
    let matched = false;
    for (const signature of signatures) {
        if (signature.length !== expected.length || !HEX.test(signature)) continue;
        if (timingSafeEqual(Buffer.from(signature.toLowerCase(), 'utf8'), expected)) {
            matched = true;
        }
    }
    return matched;
}
