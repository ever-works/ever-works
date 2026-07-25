import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Slack Events API request signing (v0) — pure helpers, no SDK calls.
 *
 * Slack signs each delivery as `v0=HEX(HMAC_SHA256(secret, "v0:{ts}:{rawBody}"))`
 * and sends it in `x-slack-signature` alongside `x-slack-request-timestamp`.
 * Verification is FAIL-CLOSED: missing secret, missing headers, malformed
 * timestamp, out-of-tolerance skew, or a non-matching digest all yield
 * `valid: false`. The digest comparison is constant-time
 * (`crypto.timingSafeEqual`) so the check leaks no prefix information.
 */

/** Maximum accepted clock skew between Slack's timestamp and ours (seconds). */
export const SLACK_SIGNATURE_TOLERANCE_SECONDS = 300;

export interface SlackSignatureInput {
	/** Raw, unparsed request body exactly as delivered. */
	readonly rawBody: string;
	/** `x-slack-request-timestamp` header value (unix seconds). */
	readonly timestamp: string | undefined;
	/** `x-slack-signature` header value (`v0=<hex>`). */
	readonly signature: string | undefined;
	/** The app's signing secret. Missing/empty fails closed. */
	readonly signingSecret: string | undefined;
	/** Override "now" (ms since epoch) — for tests. Defaults to `Date.now()`. */
	readonly nowMs?: number;
	/** Override the skew tolerance (seconds) — for tests. */
	readonly toleranceSeconds?: number;
}

export interface SlackSignatureResult {
	readonly valid: boolean;
	/** Stable machine-readable reason on failure (never echoes secrets). */
	readonly reason?:
		| 'missing-signing-secret'
		| 'missing-headers'
		| 'invalid-timestamp'
		| 'stale-timestamp'
		| 'signature-mismatch';
}

/** Compute the expected `v0=<hex>` signature for a delivery. */
export function computeSlackSignature(signingSecret: string, timestamp: string, rawBody: string): string {
	const digest = createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex');
	return `v0=${digest}`;
}

/** Verify a Slack Events API delivery. Fail-closed on every degenerate input. */
export function verifySlackSignature(input: SlackSignatureInput): SlackSignatureResult {
	if (typeof input.signingSecret !== 'string' || input.signingSecret.length === 0) {
		return { valid: false, reason: 'missing-signing-secret' };
	}
	if (!input.timestamp || !input.signature) {
		return { valid: false, reason: 'missing-headers' };
	}

	const tsSeconds = Number(input.timestamp);
	if (!Number.isFinite(tsSeconds)) {
		return { valid: false, reason: 'invalid-timestamp' };
	}
	const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
	const tolerance = input.toleranceSeconds ?? SLACK_SIGNATURE_TOLERANCE_SECONDS;
	if (Math.abs(nowSeconds - tsSeconds) > tolerance) {
		return { valid: false, reason: 'stale-timestamp' };
	}

	const expected = computeSlackSignature(input.signingSecret, input.timestamp, input.rawBody);
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
