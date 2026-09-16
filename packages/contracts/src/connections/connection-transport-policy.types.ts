import { credentialRefPattern } from '../policy/tool-grant.types.js';

/**
 * Connection credential transport (AW-15) — the organization setting and the
 * pure verdict every create, update and connection attempt shares.
 *
 * ## What already worked, and what is new
 *
 * An MCP connection whose auth headers hold LITERAL values has always been
 * able to use a plain `http://` endpoint. That keeps working: such a
 * connection is allowed and flagged `insecure_transport` (a warning) so the
 * owner sees the credential travels unencrypted.
 *
 * Resolving `{{cred.key}}` references inside headers is new, so nothing relies
 * on sending a resolved secret over plain http. A reference aimed at a
 * plain-http endpoint is refused (`https_required`) and the secret is never
 * looked up.
 *
 * An organization can opt into refusing literal credentials over plain http
 * too, with the setting below. It is OFF unless the organization turns it on.
 */

/** Stored on `organizations.connection_policy`. `null` / `{}` = every default. */
export interface OrganizationConnectionPolicy {
	/**
	 * "Require https for connection credentials". When `true`, a connection
	 * whose auth headers carry ANY value (literal or reference) must use an
	 * `https:` endpoint. Default `false`: literal credentials over plain http
	 * keep working, with a warning.
	 */
	requireHttpsForCredentials?: boolean;
}

/** The setting's key inside `OrganizationConnectionPolicy`. */
export const REQUIRE_HTTPS_FOR_CREDENTIALS_SETTING = 'requireHttpsForCredentials' as const;

/** The setting's human name, used verbatim in every refusal it causes. */
export const REQUIRE_HTTPS_FOR_CREDENTIALS_SETTING_LABEL = 'Require https for connection credentials';

/**
 * Shape guard for the stored / submitted policy. Unknown keys are dropped and
 * only a real boolean is kept, so a junk value can never switch enforcement on
 * or off by accident. An object with nothing left is `null` ("all defaults").
 */
export function sanitizeOrganizationConnectionPolicy(raw: unknown): OrganizationConnectionPolicy | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const candidate = raw as Record<string, unknown>;
	const out: OrganizationConnectionPolicy = {};
	if (typeof candidate.requireHttpsForCredentials === 'boolean') {
		out.requireHttpsForCredentials = candidate.requireHttpsForCredentials;
	}
	return Object.keys(out).length > 0 ? out : null;
}

/** Does this stored policy refuse literal credentials over plain http? Default: no. */
export function organizationRequiresHttpsForCredentials(policy: unknown): boolean {
	return sanitizeOrganizationConnectionPolicy(policy)?.requireHttpsForCredentials === true;
}

/**
 * The verdict for one endpoint + header map.
 *
 *   secure          no credential leaves in cleartext (https, stdio, or no headers)
 *   insecure        literal credentials over plain http — allowed, with a warning
 *   refused         nothing may be sent; `reason` says why
 */
export type CredentialTransportVerdict =
	| { verdict: 'secure' }
	| { verdict: 'insecure' }
	| { verdict: 'refused'; reason: CredentialTransportRefusalReason };

/**
 *   credential_references  a `{{cred.key}}` reference aimed at plain http
 *   organization_policy    literal credentials over plain http while the
 *                          organization requires https
 */
export type CredentialTransportRefusalReason = 'credential_references' | 'organization_policy';

export interface CredentialTransportInput {
	url: string | null | undefined;
	transport?: string | null;
	headers: Readonly<Record<string, string>> | null | undefined;
	/** The organization setting. Omitted / `false` = literal credentials over http stay allowed. */
	requireHttpsForCredentials?: boolean;
}

function isHttps(url: string | null | undefined): boolean {
	if (typeof url !== 'string' || url.length === 0) return false;
	try {
		return new URL(url).protocol === 'https:';
	} catch {
		return false;
	}
}

/**
 * Decide how one connection may send its headers.
 *
 * `stdio` rows are exempt — they never dial a network address. A header map
 * with no non-empty value carries no credential, so plain http without
 * headers is `secure` in every case (it sends nothing to protect).
 */
export function assessCredentialTransport(input: CredentialTransportInput): CredentialTransportVerdict {
	if (input.transport === 'stdio') return { verdict: 'secure' };
	const values = Object.values(input.headers ?? {}).filter(
		(value): value is string => typeof value === 'string' && value.length > 0
	);
	if (values.length === 0) return { verdict: 'secure' };
	if (isHttps(input.url)) return { verdict: 'secure' };
	if (values.some((value) => credentialRefPattern().test(value))) {
		return { verdict: 'refused', reason: 'credential_references' };
	}
	if (input.requireHttpsForCredentials === true) {
		return { verdict: 'refused', reason: 'organization_policy' };
	}
	return { verdict: 'insecure' };
}
