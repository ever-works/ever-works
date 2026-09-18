import type { IPlugin, JsonSchema, PluginCategory, PluginContext, PluginManifest } from '@ever-works/plugin';

import { oidcIdentitySettingsSchema } from './settings.schema.js';

/**
 * APW-12 T5 — the `oidc-identity` plugin, **scaffold only**.
 *
 * What exists here is the identity the platform's discovery path needs and
 * nothing more:
 *
 *   - the manifest the `everworks.plugin` block in `package.json` also declares
 *     (they must agree — `packages/agent/src/plugins/services/plugin-manifest-validator.service.ts`
 *     extracts the block from disk and `PluginClassValidatorService` compares the
 *     loaded class against it);
 *   - the settings schema of plan §4.2;
 *   - the two lifecycle hooks the loader calls. Both are **prototype methods on
 *     purpose**: `PluginClassValidatorService.isPluginClass`
 *     (`packages/agent/src/plugins/services/plugin-class-validator.service.ts:42-55`)
 *     accepts a class only when `onLoad` and `onUnload` sit on its prototype, so
 *     an arrow-function property would make this plugin undiscoverable.
 *
 * What does NOT exist yet, deliberately: every `IIdentityProviderPlugin` method
 * (`testConnection`, `getPublicConfig`, `buildAuthorizationRequest`,
 * `exchangeAuthorizationCode`, `verifyAccessToken`, `verifyLogoutToken`,
 * `buildEndSessionUrl`) and `healthCheck`. The capability string below is the
 * plan §4.2 contract — the manifest is fixed — but nothing in this class
 * pretends to implement it: there is no stub that would answer a connection
 * test, mint an authorization request or report health before T6/T7 write the
 * real thing. Until then the plugin is inert: `autoEnable: false`, so it is
 * discovered and listed disabled, and the façade (APW-12 §4.4) resolves nothing
 * from it.
 */
export class OidcIdentityPlugin implements IPlugin {
	readonly id = 'oidc-identity';
	readonly name = 'OpenID Connect identity (Ever ID)';
	readonly version = '1.0.0';

	/**
	 * The plan §4.2 category, `'identity'`.
	 *
	 * The assertion is needed only because this package lands **before T4**,
	 * which appends `'identity'` to `PLUGIN_CATEGORIES`
	 * (`packages/plugin/src/contracts/plugin-manifest.types.ts:5-117` — the tuple
	 * currently closes with `'build'`). Until that append lands the loader's own
	 * `isPluginCategory` check rejects the manifest, so this plugin is
	 * discoverable only after T4; the value itself is already exact, and the
	 * assertion is the one place the type union is narrower than the plan.
	 */
	readonly category: PluginCategory = 'identity' as PluginCategory;

	/** Plan §4.2: exactly one capability, `identity-provider`. */
	readonly capabilities: readonly string[] = ['identity-provider'];

	/** One issuer set per installation, configured by a platform admin (FR-7, FR-2). */
	readonly configurationMode = 'admin-only';

	readonly settingsSchema: JsonSchema = oidcIdentitySettingsSchema;

	async onLoad(context: PluginContext): Promise<void> {
		// No resources to hold yet: the discovery document, the key cache and the
		// transaction store all arrive with T6/T7, and both of the first two need
		// settings that are not read here.
		context.logger.log('OpenID Connect identity (Ever ID) plugin loaded — the OIDC flow lands in APW-12 T6');
	}

	async onUnload(): Promise<void> {
		// Symmetric with onLoad: nothing is held, so nothing is released.
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				'OpenID Connect relying party for Ever ID: browser sign-in, connected identities, delegated reads and back-channel logout',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			// The installation opts in explicitly: discovery lists it disabled (FR-5's
			// kill switch is the plugin toggle, plan §9.2).
			autoEnable: false
		};
	}
}

export default OidcIdentityPlugin;
