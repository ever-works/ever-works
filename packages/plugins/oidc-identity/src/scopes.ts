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
 * **T8** added the two scopes on the verifying side —
 * {@link OIDC_DELEGATED_READ_SCOPE} (`apps:read`, FR-44) and
 * {@link OIDC_SESSION_EXCHANGE_SCOPE} (`ever-works:session`, FR-39/FR-40) — for
 * the same reason, one step further along the flow: `verifyAccessToken` is handed
 * `requiredScopes` by its caller, and the caller and the provider's registration
 * have to spell them identically.
 *
 * Nothing here is a secret and nothing here is provider-specific: the same three
 * sign-in scopes are what any OpenID Connect relying party asks for, which is why
 * this file names no issuer.
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
 * APW-12 **T8** — the two scopes Ever Works *verifies* rather than requests.
 *
 * They are the other side of the same wire vocabulary: a sign-in **asks** for
 * `openid email profile`, and a token that arrives from Ever ID is **checked**
 * against one of these. Both spellings live in this file because a scope string
 * three components have to agree on is exactly the thing that should have one
 * definition — FR-40's exchange scope is read by the local client, by the API
 * endpoint that verifies the token and by the provider's own registration, and
 * FR-44's delegated scope by the App Launcher, the marked endpoint and the
 * provider.
 *
 * The values are `EVER_ID_SCOPES` in `packages/contracts/src/apps/ever-id.ts`,
 * transcribed rather than imported for the reason this package depends on
 * `@ever-works/plugin` alone (see `discovery.ts`), and
 * `src/__tests__/access-token.spec.ts` reads that file off disk and asserts the
 * two agree.
 */
export const OIDC_DELEGATED_READ_SCOPE = 'apps:read';

/**
 * FR-39/FR-40 — the scope a local client's access token must carry to be
 * exchanged for an Ever Works session (`EVER_ID_SCOPES.SESSION_EXCHANGE`).
 */
export const OIDC_SESSION_EXCHANGE_SCOPE = 'ever-works:session';

/** The two scopes {@link OIDC_DELEGATED_READ_SCOPE} and {@link OIDC_SESSION_EXCHANGE_SCOPE} name, in one list. */
export const OIDC_TOKEN_SCOPES = [OIDC_DELEGATED_READ_SCOPE, OIDC_SESSION_EXCHANGE_SCOPE] as const;

/** Union of {@link OIDC_TOKEN_SCOPES}. */
export type OidcTokenScope = (typeof OIDC_TOKEN_SCOPES)[number];

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
