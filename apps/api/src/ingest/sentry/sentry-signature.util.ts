import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Sentry integration webhook signing — API-side pure helpers.
 *
 * Sentry signs every integration webhook (issue alerts, event alerts,
 * issue lifecycle, installation lifecycle) with the integration's
 * CLIENT SECRET: `Sentry-Hook-Signature = HEX(HMAC_SHA256(clientSecret,
 * rawBody))` — a bare hex digest, no `sha256=` prefix (unlike GitHub and
 * Jira). Small twin of the GitHub / Slack / Jira helpers next door:
 * connector-facing receivers verify with their own pure util and the API
 * never imports a vendor SDK for it. Verification is FAIL-CLOSED —
 * missing secret/header and non-matching digests all yield
 * `valid: false`; the digest comparison is constant-time
 * (`crypto.timingSafeEqual`).
 *
 * Sentry also sends `Sentry-Hook-Timestamp`, but it is NOT part of the
 * signed material, so it cannot gate replay the way Slack's does; replay
 * hardening rides the ingest spine's `(source, sourceEventId)` dedupe.
 */

export interface SentrySignatureInput {
    /** Raw, unparsed request body exactly as delivered. */
    readonly rawBody: string;
    /** `Sentry-Hook-Signature` header value (bare hex digest). */
    readonly signature: string | undefined;
    /** The integration's client secret. Missing/empty fails closed. */
    readonly clientSecret: string | undefined;
}

export interface SentrySignatureResult {
    readonly valid: boolean;
    /** Stable machine-readable reason on failure (never echoes secrets). */
    readonly reason?: 'missing-client-secret' | 'missing-signature' | 'signature-mismatch';
}

/** Compute the expected bare-hex signature for a delivery. */
export function computeSentrySignature(clientSecret: string, rawBody: string): string {
    return createHmac('sha256', clientSecret).update(rawBody).digest('hex');
}

/** Verify a Sentry integration webhook delivery. Fail-closed on every degenerate input. */
export function verifySentrySignature(input: SentrySignatureInput): SentrySignatureResult {
    if (typeof input.clientSecret !== 'string' || input.clientSecret.length === 0) {
        return { valid: false, reason: 'missing-client-secret' };
    }
    if (!input.signature) {
        return { valid: false, reason: 'missing-signature' };
    }

    const expected = computeSentrySignature(input.clientSecret, input.rawBody);
    const expectedBuf = Buffer.from(expected, 'utf8');
    const actualBuf = Buffer.from(input.signature, 'utf8');
    // timingSafeEqual requires equal lengths; a length mismatch is already a
    // non-match and leaks nothing beyond the (public) signature format.
    if (expectedBuf.length !== actualBuf.length) {
        return { valid: false, reason: 'signature-mismatch' };
    }
    if (!timingSafeEqual(expectedBuf, actualBuf)) {
        return { valid: false, reason: 'signature-mismatch' };
    }
    return { valid: true };
}
