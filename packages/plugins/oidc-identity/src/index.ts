/**
 * `@ever-works/oidc-identity` — the OpenID Connect relying party for Ever ID
 * (APW-12). Package entry: the plugin class is the default export because that
 * is what `PluginLoaderService.loadPluginModule`
 * (`packages/agent/src/plugins/services/plugin-loader.service.ts:342`) reads
 * first out of the module it imports from `src/index.ts`.
 */
export { default, OidcIdentityPlugin } from './oidc-identity.plugin.js';
// APW-12 T7 — the FR-9/FR-11/FR-2 numbers the sign-in flow enforces, exported so a
// spec can pin them against `EVER_ID_LIMITS` off disk (the pattern T6 used for
// FR-13's three numbers) and so the API's `/client-config` (FR-39) reads the scope
// string from the place the request is built with it.
// APW-12 T8 — extended with the four numbers and the one event identifier the
// token verifiers enforce (FR-40's 300-second age, FR-45's 3,600-second lifetime
// ceiling, FR-33's 300-second notice age and 600-second replay window, and the
// back-channel-logout event), plus FR-2's default API audience, which
// `getPublicConfig` and `verifyAccessToken` now read from one constant. Every one
// of them is part of the package's published surface on purpose: the numbers are
// plan §4.3's and the API passes two of them straight back in as `maxAgeSeconds` /
// `maxLifetimeSeconds`, so a caller that had to spell `3600` itself would be a
// second place for the ceiling to live.
export {
	OIDC_ACCESS_TOKEN_MAX_AGE_SECONDS,
	OIDC_ACCESS_TOKEN_MAX_LIFETIME_SECONDS,
	OIDC_BACKCHANNEL_LOGOUT_EVENT,
	OIDC_CODE_VERIFIER_BYTES,
	OIDC_CODE_VERIFIER_LENGTH,
	OIDC_DEFAULT_API_AUDIENCE,
	OIDC_DEFAULT_CLOCK_SKEW_SECONDS,
	OIDC_ID_TOKEN_MAX_AGE_SECONDS,
	OIDC_LOGOUT_TOKEN_MAX_AGE_SECONDS,
	OIDC_LOGOUT_TOKEN_REPLAY_WINDOW_SECONDS,
	OIDC_NONCE_BYTES,
	OIDC_STATE_BYTES,
	OIDC_SUBJECT_MAX_LENGTH
} from './oidc-identity.plugin.js';
// APW-12 T7 — the sign-in scopes (plan §4.2, FR-38): `openid email profile`, and
// never `offline_access`. APW-12 T8 — the two scopes a **token** is verified
// against (FR-44's `apps:read`, FR-39/FR-40's `ever-works:session`).
export {
	OIDC_DELEGATED_READ_SCOPE,
	OIDC_NEVER_REQUESTED_SCOPES,
	OIDC_SESSION_EXCHANGE_SCOPE,
	OIDC_SIGN_IN_SCOPE,
	OIDC_SIGN_IN_SCOPES,
	OIDC_TOKEN_SCOPES,
	isSignInScope
} from './scopes.js';
export type { OidcNeverRequestedScope, OidcSignInScope, OidcTokenScope } from './scopes.js';
export {
	OIDC_IDENTITY_SETTING_KEYS,
	oidcIdentityHttpsUrlPattern,
	oidcIdentityIssuerUrlPattern,
	oidcIdentitySettingsSchema
} from './settings.schema.js';
export type {
	OidcIdentityAvailability,
	OidcIdentityDelegatedClientName,
	OidcIdentityLocalClient,
	OidcIdentitySettingKey,
	OidcIdentitySettings
} from './settings.schema.js';

// APW-12 T6 — the discovery reader and the signing-key cache, with the §4.3
// numbers they enforce. Exported because `tsup` bundles from **this** file: a
// module nothing here reaches is a module the published package does not have
// (measured before this export — `jwks-cache.ts` was absent from `dist/index.js`
// while its spec was green against the source). Nothing test-only is exported
// here: T8's fake provider ships from the `./testing` subpath (plan §10.4) and is
// **deliberately not** re-exported from this file, which is what keeps it out of
// the main bundle; T6's fixtures stay inside their spec files.
export {
	OIDC_DISCOVERY_CACHE_SECONDS,
	OIDC_IDENTITY_SIGNING_ALGS,
	OIDC_JWKS_CACHE_SECONDS,
	OIDC_JWKS_MAX_STALE_SECONDS,
	OIDC_JWKS_UNKNOWN_KID_COOLDOWN_SECONDS,
	OIDC_OUTBOUND_MAX_ATTEMPTS,
	OIDC_OUTBOUND_RETRY_DELAY_MS,
	OIDC_OUTBOUND_TIMEOUT_MS,
	OidcDiscoveryReader,
	OidcProviderUnavailableError,
	// APW-12 T7 — FR-15's single-attempt request, for the one call that is never
	// retried (the token endpoint, plan §4.2's `authorizationCodeGrant` half).
	fetchJsonOnce
} from './discovery.js';
export type {
	OidcDiscoveryDocument,
	OidcDiscoveryFailure,
	OidcDiscoveryRead,
	OidcFetchImpl,
	OidcFetchInit,
	OidcHttpResponse,
	OidcOutboundFailure,
	OidcProviderUnavailableReason,
	OidcIdentitySigningAlg
} from './discovery.js';
export { OidcJwksCache, OidcJwksVerificationError } from './jwks-cache.js';
export type { OidcJwksCacheOptions, OidcJwksFailureCode, OidcJwksVerification } from './jwks-cache.js';
