import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Jira Cloud webhook request signing — API-side pure helpers.
 *
 * A Jira Cloud webhook created WITH a secret signs every delivery
 * `sha256=HEX(HMAC_SHA256(secret, rawBody))` in the `X-Hub-Signature`
 * header (the same scheme GitHub uses under `X-Hub-Signature-256`).
 * Deliberate small twin of the GitHub / Slack helpers next door:
 * connector-facing receivers verify with their own pure util, and the
 * API never takes a static import on the `jira-connector` plugin
 * package for it (connector plugins are dynamically distributed).
 *
 * Verification is FAIL-CLOSED — a webhook created WITHOUT a secret sends
 * no header at all and is rejected, as are missing secrets and
 * non-matching digests; the digest comparison is constant-time
 * (`crypto.timingSafeEqual`). Jira deliveries carry a `timestamp` in the
 * body but no signed timestamp header, so replay hardening rides the
 * ingest spine's `(source, sourceEventId)` dedupe instead.
 */

export interface JiraSignatureInput {
    /** Raw, unparsed request body exactly as delivered. */
    readonly rawBody: string;
    /** `X-Hub-Signature` header value (`sha256=<hex>`). */
    readonly signature: string | undefined;
    /** The webhook secret configured on the Jira Cloud webhook. Missing/empty fails closed. */
    readonly webhookSecret: string | undefined;
}

export interface JiraSignatureResult {
    readonly valid: boolean;
    /** Stable machine-readable reason on failure (never echoes secrets). */
    readonly reason?: 'missing-webhook-secret' | 'missing-signature' | 'signature-mismatch';
}

/** Compute the expected `sha256=<hex>` signature for a delivery. */
export function computeJiraSignature(webhookSecret: string, rawBody: string): string {
    const digest = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    return `sha256=${digest}`;
}

/** Verify a Jira Cloud webhook delivery. Fail-closed on every degenerate input. */
export function verifyJiraSignature(input: JiraSignatureInput): JiraSignatureResult {
    if (typeof input.webhookSecret !== 'string' || input.webhookSecret.length === 0) {
        return { valid: false, reason: 'missing-webhook-secret' };
    }
    if (!input.signature) {
        return { valid: false, reason: 'missing-signature' };
    }

    const expected = computeJiraSignature(input.webhookSecret, input.rawBody);
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
