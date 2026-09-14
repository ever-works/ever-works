/**
 * Connection health (AW-15) — the CONTRACT half.
 *
 * One vocabulary for "is this connection still working?", shared by the API
 * (which stamps it on every real connection attempt), the web Settings screen
 * (which renders it) and any later probe. Pure and dependency-free.
 *
 *   unknown             never checked
 *   healthy             the last attempt succeeded
 *   degraded            1–2 consecutive failed attempts that were not credential problems
 *   expired             the provider rejected the credential, a referenced credential is
 *                       missing, or the credential is refused on a plain-http endpoint
 *                       (`https_required`) — the owner must act
 *   unreachable         3 or more consecutive failed attempts that were not credential problems
 *   insecure_transport  a WARNING, not a failure: the last attempt succeeded, but it sent
 *                       literal credentials to a plain-http endpoint. The connection keeps
 *                       working exactly as it did before; the owner is told it is unencrypted.
 */

/** Every health state, in display order. */
export const CONNECTION_HEALTH_STATES = [
	'unknown',
	'healthy',
	'degraded',
	'expired',
	'unreachable',
	'insecure_transport'
] as const;

export type ConnectionHealth = (typeof CONNECTION_HEALTH_STATES)[number];

/**
 * Classified reason for the last failed attempt. A CODE, never a provider
 * response body — the UI translates it, and nothing credential-bearing can
 * ride along in it.
 */
export const CONNECTION_HEALTH_ERROR_CODES = [
	'credential_rejected',
	'credential_missing',
	'insecure_transport',
	'timeout',
	'unreachable',
	'not_found',
	'failed',
	'https_required'
] as const;

export type ConnectionHealthErrorCode = (typeof CONNECTION_HEALTH_ERROR_CODES)[number];

/**
 * Codes the owner must fix (a credential or the endpoint) — never cured by retrying.
 *
 * `https_required` is a REFUSAL: a `{{cred.key}}` reference aimed at a plain-http
 * endpoint, or literal credentials there while the organization setting
 * "Require https for connection credentials" is on. Nothing was sent.
 *
 * `insecure_transport` is deliberately NOT here: it is the warning for literal
 * credentials that were sent over plain http and worked — see
 * `CONNECTION_HEALTH_WARNING_CODES`.
 */
export const CONNECTION_CREDENTIAL_ERROR_CODES: readonly ConnectionHealthErrorCode[] = Object.freeze([
	'credential_rejected',
	'credential_missing',
	'https_required'
] as ConnectionHealthErrorCode[]);

/**
 * Codes that describe a WORKING connection the owner should still look at.
 * A warning never expires a connection and never blocks it.
 */
export const CONNECTION_HEALTH_WARNING_CODES: readonly ConnectionHealthErrorCode[] = Object.freeze([
	'insecure_transport'
] as ConnectionHealthErrorCode[]);

/** Consecutive non-credential failures after which a connection is `unreachable`. */
export const CONNECTION_UNREACHABLE_AFTER_FAILURES = 3;

export function isConnectionHealth(value: unknown): value is ConnectionHealth {
	return typeof value === 'string' && (CONNECTION_HEALTH_STATES as readonly string[]).includes(value);
}

export function isConnectionHealthErrorCode(value: unknown): value is ConnectionHealthErrorCode {
	return typeof value === 'string' && (CONNECTION_HEALTH_ERROR_CODES as readonly string[]).includes(value);
}

/** States that put a connection in the "needs attention" banner. */
export function connectionHealthNeedsAttention(health: ConnectionHealth | null | undefined): boolean {
	return health === 'expired' || health === 'unreachable';
}

/** A working connection that carries a warning (today: credentials sent over plain http). */
export function connectionHealthIsWarning(health: ConnectionHealth | null | undefined): boolean {
	return health === 'insecure_transport';
}
