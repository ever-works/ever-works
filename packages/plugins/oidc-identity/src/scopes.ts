/**
 * APW-12 T7 — the scopes a sign-in asks Ever ID for, and the one it never asks for.
 *
 * Plan §4.2: "`src/scopes.ts`: sign-in scopes `openid email profile`; the plugin
 * never requests `offline_access` (spec FR-38)."
 *
 * Both halves of that sentence are requirements, and they are not symmetrical:
 *
 *   - **`openid email profile`** is what a sign-in needs. `openid` is what makes
 *     the response an OpenID Connect authentication (and what obliges the
 *     provider to return an ID token at all, FR-11); `email` and `profile` carry
 *     `email`, `email_verified` and `name`, which FR-23/FR-24/FR-25 branch on
 *     when an unknown pair is offered account creation or a connection. Asking
 *     for anything else would be asking for access the sign-in path does not
 *     read.
 *   - **`offline_access` is never requested.** FR-38 states the reason in one
 *     line — "Ever Works never stores Ever ID refresh tokens in P1" — and the
 *     cheapest way to keep that promise is not to be able to receive one: a
 *     provider only issues a refresh token to a client that asked for
 *     `offline_access`, so a request that never carries the scope can never
 *     produce a token this platform would have to decide what to do with.
 *
 * ## Why this is its own module
 *
 * The scope string is a wire value three separate places need to agree on: the
 * authorization request this package builds (T7), the `GET /client-config`
 * answer a local client reads before it signs in (FR-39, plan §5.1) and the
 * documentation that tells a person what Ever Works asks for. It is a constant
 * rather than a literal because a second spelling of `'openid email profile'`
 * is a second thing that can drift.
 *
 * Nothing here is a secret and nothing here is provider-specific: the same three
 * scopes are what any OpenID Connect relying party asks for, which is why this
 * file names no issuer.
 */

/**
 * The three sign-in scopes, in the order the authorization request sends them.
 *
 * The order is fixed rather than incidental: the request is asserted
 * byte-for-byte against this list by `src/__tests__/authorization-request.spec.ts`,
 * so a reordering is a visible change rather than a silent one.
 */
export const OIDC_SIGN_IN_SCOPES = ['openid', 'email', 'profile'] as const;

/** Union of {@link OIDC_SIGN_IN_SCOPES}. */
export type OidcSignInScope = (typeof OIDC_SIGN_IN_SCOPES)[number];

/**
 * The `scope` parameter of every authorization request: `openid email profile`.
 *
 * Space-delimited, per RFC 6749 §3.3 — and `buildAuthorizationRequest` sends
 * **this** string, never one assembled at the call site.
 */
export const OIDC_SIGN_IN_SCOPE = OIDC_SIGN_IN_SCOPES.join(' ');

/**
 * The scopes Ever Works never asks for (FR-38).
 *
 * Named rather than inlined so the refusal is testable: `isSignInScope` answers
 * `false` for a request that carries one, and the spec asserts both that a
 * built request does not, and that the guard refuses a string that does.
 */
export const OIDC_NEVER_REQUESTED_SCOPES = ['offline_access'] as const;

/** One of {@link OIDC_NEVER_REQUESTED_SCOPES}. */
export type OidcNeverRequestedScope = (typeof OIDC_NEVER_REQUESTED_SCOPES)[number];

/**
 * Is `value` exactly the sign-in scope set — the three of
 * {@link OIDC_SIGN_IN_SCOPES}, and nothing else?
 *
 * Deliberately an equality rather than a "contains" test: a request carrying an
 * extra scope (a refresh-token scope, a delegated-read scope, a scope a caller
 * appended) is not the sign-in request this package means to send, and the
 * honest answer for it is `false`. It is exported so the spec — and any future
 * caller that has a scope string in hand rather than the constant — can ask the
 * question the plugin answers by construction.
 */
export function isSignInScope(value: string): boolean {
	const requested = value.split(/\s+/u).filter((scope) => scope.length > 0);
	if (requested.length !== OIDC_SIGN_IN_SCOPES.length) return false;
	const unique = new Set(requested);
	if (unique.size !== requested.length) return false;
	return OIDC_SIGN_IN_SCOPES.every((scope) => unique.has(scope));
}
