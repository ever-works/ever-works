/**
 * The generated-secret fingerprint `GET /state` publishes.
 *
 * The App spec generates `FIXTURE_SESSION_SECRET` once per App Work and never rotates it
 * (`generate: { kind: chars, length: 32, rotate: never }`). The blueprint README's row is explicit:
 * `GET /state` returns "only its length and a hash prefix, never the value", and the value is
 * "identical across redeploys". A pure function of the value is exactly that: stable across restarts,
 * redeploys and rebuilds, and useless to anyone who reads it.
 */

import crypto from 'node:crypto';

/**
 * @param {string} value the secret
 * @param {number} [prefixLength] how many hex characters of the digest to publish
 * @returns {{length: number, sha256Prefix8: string, set: boolean}}
 */
export function fingerprint(value, prefixLength = 8) {
	const secret = value ?? '';
	return {
		length: secret.length,
		sha256Prefix8: secret ? crypto.createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, prefixLength) : '',
		set: secret.length > 0
	};
}

/** Constant-time comparison, so the cron endpoint does not leak the token one byte at a time. */
export function safeEqual(a, b) {
	const left = Buffer.from(String(a ?? ''), 'utf8');
	const right = Buffer.from(String(b ?? ''), 'utf8');
	if (left.length !== right.length || left.length === 0) return false;
	return crypto.timingSafeEqual(left, right);
}
