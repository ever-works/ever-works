/**
 * `@ever-works/oidc-identity` — the OpenID Connect relying party for Ever ID
 * (APW-12). Package entry: the plugin class is the default export because that
 * is what `PluginLoaderService.loadPluginModule`
 * (`packages/agent/src/plugins/services/plugin-loader.service.ts:342`) reads
 * first out of the module it imports from `src/index.ts`.
 */
export { default, OidcIdentityPlugin } from './oidc-identity.plugin.js';
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
// here: T8's fake provider goes to a `./testing` subpath (plan §10.4), and T6's
// fixtures stay inside their spec files.
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
	OidcProviderUnavailableError
} from './discovery.js';
export type {
	OidcDiscoveryDocument,
	OidcDiscoveryFailure,
	OidcDiscoveryRead,
	OidcFetchImpl,
	OidcHttpResponse,
	OidcOutboundFailure,
	OidcProviderUnavailableReason,
	OidcIdentitySigningAlg
} from './discovery.js';
export { OidcJwksCache, OidcJwksVerificationError } from './jwks-cache.js';
export type { OidcJwksCacheOptions, OidcJwksFailureCode, OidcJwksVerification } from './jwks-cache.js';
