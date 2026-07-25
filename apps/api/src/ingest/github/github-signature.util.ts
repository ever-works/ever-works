import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * GitHub webhook request signing — API-side pure helpers.
 *
 * Deliveries are signed `sha256=HEX(HMAC_SHA256(secret, rawBody))`
 * (`x-hub-signature-256` header). Deliberate small twin of the Slack
 * helper next door (`slack/slack-signature.util.ts`): connector-facing
 * receivers verify with their own pure util, the API never imports a
 * plugin package for it. Verification is FAIL-CLOSED — missing
 * secret/header and non-matching digests all yield `valid: false`; the
 * digest comparison is constant-time (`crypto.timingSafeEqual`).
 *
 * GitHub deliveries carry no timestamp header, so unlike the Slack
 * twin there is no staleness window — replay hardening rides the
 * ingest spine's `(source, sourceEventId)` dedupe instead.
 */

export interface GitHubSignatureInput {
    /** Raw, unparsed request body exactly as delivered. */
    readonly rawBody: string;
    /** `x-hub-signature-256` header value (`sha256=<hex>`). */
    readonly signature: string | undefined;
    /** The configured webhook secret. Missing/empty fails closed. */
    readonly webhookSecret: string | undefined;
}

export interface GitHubSignatureResult {
    readonly valid: boolean;
    /** Stable machine-readable reason on failure (never echoes secrets). */
    readonly reason?: 'missing-webhook-secret' | 'missing-signature' | 'signature-mismatch';
}

/** Compute the expected `sha256=<hex>` signature for a delivery. */
export function computeGitHubSignature(webhookSecret: string, rawBody: string): string {
    const digest = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    return `sha256=${digest}`;
}

/** Verify a GitHub webhook delivery. Fail-closed on every degenerate input. */
export function verifyGitHubSignature(input: GitHubSignatureInput): GitHubSignatureResult {
    if (typeof input.webhookSecret !== 'string' || input.webhookSecret.length === 0) {
        return { valid: false, reason: 'missing-webhook-secret' };
    }
    if (!input.signature) {
        return { valid: false, reason: 'missing-signature' };
    }

    const expected = computeGitHubSignature(input.webhookSecret, input.rawBody);
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
