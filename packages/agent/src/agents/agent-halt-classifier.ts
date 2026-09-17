/**
 * AW-23 — "was this run failure a rejected credential?"
 *
 * A dead token is the one failure mode the three-strikes rule handles
 * badly: three runs fail, three runs' worth of time and money is spent,
 * and the agent still only says `error`. Recognising it lets the platform
 * halt after ONE failure and say which connection was refused.
 *
 * PURE and deliberately CONSERVATIVE:
 *
 *  - It defaults to `false`. A false negative costs the user the ordinary
 *    three-failure path, which is what happens today. A false positive
 *    halts a healthy agent on one unlucky error, which is worse.
 *  - It is PROVIDER-AGNOSTIC. No plugin id appears here and none ever may:
 *    the phrase list below is the vocabulary of HTTP and of authentication
 *    in general, not of any one vendor. Which thing was refused is
 *    supplied by the caller as a facade-resolved display name.
 *  - 🛑 It NEVER returns any part of the error message. The message is
 *    read and thrown away; only a boolean leaves this module. That is what
 *    keeps a token echoed inside a provider error out of the halt detail,
 *    the activity feed, the API payload and the card.
 *
 * Where the classified run-failure taxonomy exists, its verdict is the
 * better input and should be preferred; this predicate is the narrow
 * fallback for everything it has not classified yet.
 */

export interface CredentialFaultInput {
    /** HTTP status the provider returned, when the failure carried one. */
    statusCode?: number | null;
    /** The raw failure message. Read here and never copied out. */
    errorMessage?: string | null;
}

/**
 * Closed phrase list. Every entry is generic authentication vocabulary —
 * add a phrase only if it could be written by any provider, never one
 * that names a vendor, a product or a plugin.
 */
const CREDENTIAL_FAULT_PHRASES: readonly string[] = [
    'invalid api key',
    'invalid_api_key',
    'incorrect api key',
    'invalid authentication',
    'authentication failed',
    'authentication_error',
    'unauthorized',
    'unauthenticated',
    'permission denied',
    'invalid access token',
    'invalid_token',
    'expired token',
    'token expired',
    'token has expired',
    'credential is invalid',
    'invalid credentials',
    'revoked',
    'api key not valid',
    'missing api key',
    'no api key provided',
    'account deactivated',
];

/**
 * Phrases that look authentication-shaped but describe a different fault
 * entirely. Checked FIRST: a rate limit and a quota are not a dead
 * credential, and halting an agent on either would be wrong.
 */
const NOT_CREDENTIAL_PHRASES: readonly string[] = [
    'rate limit',
    'rate_limit',
    'too many requests',
    'quota exceeded',
    'insufficient_quota',
    'insufficient credits',
    'billing',
    'payment required',
    'overloaded',
];

/**
 * True when the failure is best explained by a credential the provider
 * refused. 401 and 403 count on their own; anything else needs a phrase.
 */
export function isCredentialFault(input: CredentialFaultInput): boolean {
    const message = typeof input.errorMessage === 'string' ? input.errorMessage.toLowerCase() : '';
    if (message && NOT_CREDENTIAL_PHRASES.some((phrase) => message.includes(phrase))) {
        return false;
    }
    if (input.statusCode === 401 || input.statusCode === 403) return true;
    if (!message) return false;
    return CREDENTIAL_FAULT_PHRASES.some((phrase) => message.includes(phrase));
}
