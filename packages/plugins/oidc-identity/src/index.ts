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
