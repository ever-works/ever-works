import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

import { isPluginCategory, toPluginSettingsSchemaProperty, type PluginContext } from '@ever-works/plugin';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it, vi } from 'vitest';

import { OidcIdentityPlugin } from '../oidc-identity.plugin.js';
import { OIDC_IDENTITY_SETTING_KEYS, oidcIdentitySettingsSchema } from '../settings.schema.js';

/**
 * APW-12 T5 — the `oidc-identity` settings schema and the discovery shape of the
 * package that carries it (plan §4.2; spec FR-2, FR-3, FR-7, ACC-12-03).
 *
 * Two deliberate choices in this file:
 *
 *   1. **The schema is exercised by the platform's own validator
 *      configuration**, copied from `SettingsSchemaValidatorService`
 *      (`packages/agent/src/plugins/services/settings-schema-validator.service.ts:60-68`
 *      — `allErrors: true`, `strict: false`, `useDefaults: false`,
 *      `coerceTypes: false`, plus `addFormats`). A limit is therefore proven by
 *      feeding the validator a document that breaks it, not by re-reading the
 *      number out of the schema.
 *   2. **No assertion here can print the secret.** Every check that touches
 *      `clientSecret` compares a boolean first (`const leaked = …;
 *      expect(leaked).toBe(false)`), because a failed `expect(value)` would
 *      paste the secret into the test's own failure message — the property
 *      ACC-12-03 protects, applied to this spec as well.
 */

const SECRET = 'ever-id-client-secret-0123456789abcdef-do-not-print';
const MASKED_SECRET_PLACEHOLDER = '********';

/** The ajv the API and the agent package both use, configured the same way. */
const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false, coerceTypes: false });
addFormats(ajv);
const validate = ajv.compile(oidcIdentitySettingsSchema as object);

const messages = (): string[] => validate.errors?.map((error) => `${error.instancePath} ${error.message}`) ?? [];

/** The smallest configuration plan §4.2 accepts: the three required keys. */
const minimalSettings = {
	issuerUrl: 'https://auth.ever.co',
	clientId: 'ever-works-web',
	clientSecret: SECRET
};

const withSettings = (overrides: Record<string, unknown>): Record<string, unknown> => ({
	...minimalSettings,
	...overrides
});

interface PluginPackageJson {
	name: string;
	version: string;
	type: string;
	main: string;
	module: string;
	everworks: { plugin: Record<string, unknown> };
}

const packageJson = JSON.parse(
	readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')
) as PluginPackageJson;
const manifest = packageJson.everworks.plugin;

describe('oidc-identity settings schema — the keys of plan §4.2', () => {
	it('declares exactly the twelve keys of plan §4.2, in the table order', () => {
		expect(Object.keys(oidcIdentitySettingsSchema.properties ?? {})).toEqual([...OIDC_IDENTITY_SETTING_KEYS]);
	});

	it("keeps every key at 'global' scope — one issuer set per installation (FR-7)", () => {
		const notGlobal = OIDC_IDENTITY_SETTING_KEYS.filter(
			(key) => oidcIdentitySettingsSchema.properties?.[key]?.['x-scope'] !== 'global'
		);
		expect(notGlobal).toEqual([]);
	});

	it('marks clientSecret x-secret, and marks nothing else', () => {
		const secrets = OIDC_IDENTITY_SETTING_KEYS.filter(
			(key) => oidcIdentitySettingsSchema.properties?.[key]?.['x-secret'] === true
		);
		expect(secrets).toEqual(['clientSecret']);
	});

	it("carries the plan's env fallbacks on exactly the seven keys that declare one", () => {
		const envVars = Object.fromEntries(
			OIDC_IDENTITY_SETTING_KEYS.map((key) => [
				key,
				oidcIdentitySettingsSchema.properties?.[key]?.['x-envVar']
			]).filter(([, value]) => value !== undefined)
		);
		expect(envVars).toEqual({
			issuerUrl: 'EVER_ID_ISSUER_URL',
			clientId: 'EVER_ID_CLIENT_ID',
			clientSecret: 'EVER_ID_CLIENT_SECRET',
			allowedIssuers: 'EVER_ID_ALLOWED_ISSUERS',
			apiAudience: 'EVER_ID_API_AUDIENCE',
			signUpAllowed: 'EVER_ID_SIGN_UP_ALLOWED',
			clockSkewSeconds: 'EVER_ID_CLOCK_SKEW_SECONDS'
		});
	});

	it('requires the three keys plan §4.2 marks required — and only those', () => {
		expect(oidcIdentitySettingsSchema.required).toEqual(['issuerUrl', 'clientId', 'clientSecret']);
	});

	it('declares availability as platform-written: hidden, with the four §9.2 timestamps', () => {
		const availability = oidcIdentitySettingsSchema.properties?.availability;
		expect(availability?.['x-hidden']).toBe(true);
		expect(Object.keys(availability?.properties ?? {})).toEqual([
			'unavailableSince',
			'discoveryRefreshedAt',
			'jwksRefreshedAt',
			'lastLogoutNoticeAt'
		]);
	});
});

describe('oidc-identity settings schema — the plan §4.2 limits, through the platform validator', () => {
	it('accepts the minimal configuration the plan requires (control for every limit below)', () => {
		const valid = validate(minimalSettings) as boolean;
		expect({ valid, errors: messages() }).toEqual({ valid: true, errors: [] });
	});

	it('accepts 1–3 allowed issuers and refuses 0 or 4', () => {
		const one = validate(withSettings({ allowedIssuers: ['https://auth.ever.co'] })) as boolean;
		expect(one).toBe(true);
		const three = validate(
			withSettings({
				allowedIssuers: ['https://auth.ever.co', 'https://auth2.ever.co', 'https://auth3.ever.co']
			})
		) as boolean;
		expect(three).toBe(true);

		const zero = validate(withSettings({ allowedIssuers: [] })) as boolean;
		expect(zero).toBe(false);
		expect(messages()).toContain('/allowedIssuers must NOT have fewer than 1 items');

		const four = validate(withSettings({ allowedIssuers: ['a', 'b', 'c', 'd'] })) as boolean;
		expect(four).toBe(false);
		expect(messages()).toContain('/allowedIssuers must NOT have more than 3 items');
	});

	it('accepts at most 5 local clients and refuses 6 — and only the cli/node kinds (FR-39)', () => {
		const five = Array.from({ length: 5 }, (_, index) => ({ kind: 'cli', clientId: `client-${index}` }));
		const fiveValid = validate(withSettings({ localClients: five })) as boolean;
		expect(fiveValid).toBe(true);

		const six = [...five, { kind: 'node', clientId: 'client-5' }];
		const sixValid = validate(withSettings({ localClients: six })) as boolean;
		expect(sixValid).toBe(false);
		expect(messages()).toContain('/localClients must NOT have more than 5 items');

		const wrongKind = validate(withSettings({ localClients: [{ kind: 'web', clientId: 'browser' }] })) as boolean;
		expect(wrongKind).toBe(false);
		expect(messages()).toContain('/localClients/0/kind must be equal to one of the allowed values');
	});

	it('accepts a clock skew of 0–120 seconds and refuses −1, 121 or a fraction (FR-2)', () => {
		expect(validate(withSettings({ clockSkewSeconds: 0 })) as boolean).toBe(true);
		expect(validate(withSettings({ clockSkewSeconds: 120 })) as boolean).toBe(true);

		const negative = validate(withSettings({ clockSkewSeconds: -1 })) as boolean;
		expect(negative).toBe(false);
		expect(messages()).toContain('/clockSkewSeconds must be >= 0');

		const tooLarge = validate(withSettings({ clockSkewSeconds: 121 })) as boolean;
		expect(tooLarge).toBe(false);
		expect(messages()).toContain('/clockSkewSeconds must be <= 120');

		const fractional = validate(withSettings({ clockSkewSeconds: 60.5 })) as boolean;
		expect(fractional).toBe(false);
		expect(messages()).toContain('/clockSkewSeconds must be integer');
	});

	it('accepts https anywhere and http only for localhost (FR-2)', () => {
		expect(validate(withSettings({ issuerUrl: 'https://auth.ever.co/realms/ever-id' })) as boolean).toBe(true);
		expect(validate(withSettings({ issuerUrl: 'https://auth.ever.co:8443' })) as boolean).toBe(true);
		expect(validate(withSettings({ issuerUrl: 'http://localhost:8080/realms/ever' })) as boolean).toBe(true);
		expect(validate(withSettings({ issuerUrl: 'http://127.0.0.1:9000' })) as boolean).toBe(true);

		const plainHttp = validate(withSettings({ issuerUrl: 'http://auth.ever.co' })) as boolean;
		expect(plainHttp).toBe(false);
		expect(messages()).toContain(
			'/issuerUrl must match pattern "^(https://[^\\s]+|http://(localhost|127\\.0\\.0\\.1)(:\\d{1,5})?(/[^\\s]*)?)$"'
		);

		const httpAccountManagement = validate(
			withSettings({ accountManagementUrl: 'http://auth.ever.co/account' })
		) as boolean;
		expect(httpAccountManagement).toBe(false);
		expect(messages()).toContain('/accountManagementUrl must match pattern "^https://[^\\s]+$"');
		expect(validate(withSettings({ accountManagementUrl: 'https://auth.ever.co/account' })) as boolean).toBe(true);
	});

	it('accepts at most 10 delegated client names and honours the 255/60 length caps (FR-48)', () => {
		const names = Array.from({ length: 10 }, (_, index) => ({
			clientId: `client-${index}`,
			displayName: `App ${index}`
		}));
		expect(validate(withSettings({ delegatedClientNames: names })) as boolean).toBe(true);
		expect(validate(withSettings({ delegatedClientNames: names.slice(0, 1) })) as boolean).toBe(true);

		const eleven = [...names, { clientId: 'client-10', displayName: 'App 10' }];
		const elevenValid = validate(withSettings({ delegatedClientNames: eleven })) as boolean;
		expect(elevenValid).toBe(false);
		expect(messages()).toContain('/delegatedClientNames must NOT have more than 10 items');

		const longName = validate(
			withSettings({ delegatedClientNames: [{ clientId: 'client', displayName: 'x'.repeat(61) }] })
		) as boolean;
		expect(longName).toBe(false);
		expect(messages()).toContain('/delegatedClientNames/0/displayName must NOT have more than 60 characters');

		const longClientId = validate(
			withSettings({ delegatedClientNames: [{ clientId: 'x'.repeat(256) }] })
		) as boolean;
		expect(longClientId).toBe(false);
		expect(messages()).toContain('/delegatedClientNames/0/clientId must NOT have more than 255 characters');
	});

	it('refuses a settings document that omits a required key', () => {
		const missingSecret = validate({ issuerUrl: 'https://auth.ever.co', clientId: 'ever-works-web' }) as boolean;
		expect(missingSecret).toBe(false);
		expect(messages()).toContain(" must have required property 'clientSecret'");
	});
});

describe('oidc-identity settings schema — ACC-12-03: the secret cannot leave the schema', () => {
	it('marks the secret through the SDK descriptor every API response is built from', () => {
		const described = toPluginSettingsSchemaProperty(oidcIdentitySettingsSchema);
		expect(described.properties.clientSecret.secret).toBe(true);
		expect(described.properties.issuerUrl.secret).toBeUndefined();
		expect(described.properties.clientSecret.scope).toBe('global');
	});

	it('projects settings without the secret value and without dropping the rest', () => {
		const described = toPluginSettingsSchemaProperty(oidcIdentitySettingsSchema);
		const settings: Record<string, unknown> = { ...minimalSettings, displayName: 'Ever ID' };

		// The platform's own rule, read off the descriptors rather than re-declared
		// here: an `x-secret` field is masked (plugin-operations.service.ts:1792,
		// :1932); every other field travels with its value.
		const response = Object.fromEntries(
			Object.entries(settings).map(([key, value]) => [
				key,
				described.properties[key]?.secret === true ? MASKED_SECRET_PLACEHOLDER : value
			])
		);

		const secretLeaked = JSON.stringify(response).includes(SECRET);
		expect(secretLeaked).toBe(false);
		const maskedCorrectly = response.clientSecret === MASKED_SECRET_PLACEHOLDER;
		expect(maskedCorrectly).toBe(true);
		// Non-vacuity: a projection that dropped everything would pass the two above.
		expect(response.issuerUrl).toBe(minimalSettings.issuerUrl);
		expect(response.clientId).toBe(minimalSettings.clientId);
		expect(response.displayName).toBe('Ever ID');
	});

	it('offers no default or example that could stand in for the secret', () => {
		const secretKey = oidcIdentitySettingsSchema.properties?.clientSecret;
		expect(secretKey?.default).toBeUndefined();
		expect(secretKey?.examples).toBeUndefined();
	});

	it('keeps a validation failure from echoing the secret', () => {
		// A type violation, so this case does not lean on any one numeric limit:
		// a limit perturbation must redden that limit's own test and nothing here.
		const invalid = withSettings({ signUpAllowed: 'yes' });
		const invalidRejected = validate(invalid) as boolean;
		expect(invalidRejected).toBe(false);
		expect(messages()).toContain('/signUpAllowed must be boolean');
		const errorsCarrySecret = JSON.stringify(validate.errors ?? []).includes(SECRET);
		expect(errorsCarrySecret).toBe(false);
	});
});

describe('oidc-identity plugin discovery shape', () => {
	it('carries the plan §4.2 everworks.plugin manifest block', () => {
		expect(manifest).toEqual({
			id: 'oidc-identity',
			name: 'OpenID Connect identity (Ever ID)',
			version: '1.0.0',
			category: 'identity',
			capabilities: ['identity-provider'],
			description:
				'OpenID Connect relying party for Ever ID: browser sign-in, connected identities, delegated reads and back-channel logout',
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			autoEnable: false
		});
	});

	it('is discovered disabled by default — the manifest autoEnable is false (FR-5)', () => {
		expect(manifest.autoEnable).toBe(false);
		expect(manifest.builtIn).toBe(true);
	});

	it('satisfies every manifest rule the loader checks before it loads the class', () => {
		// Transcribed from PluginManifestValidatorService.validate
		// (packages/agent/src/plugins/services/plugin-manifest-validator.service.ts:45-118):
		// required strings, the id pattern and length window, semver, capabilities
		// as strings, and an author whose name is a string.
		const requiredStrings = ['id', 'name', 'version', 'category'].filter(
			(key) => typeof manifest[key] !== 'string' || (manifest[key] as string).trim() === ''
		);
		expect(requiredStrings).toEqual([]);
		expect(/^[a-z][a-z0-9-]*[a-z0-9]$/.test(manifest.id as string)).toBe(true);
		expect((manifest.id as string).length).toBeGreaterThanOrEqual(3);
		expect((manifest.id as string).length).toBeLessThanOrEqual(64);
		expect(/^\d+\.\d+\.\d+/.test(manifest.version as string)).toBe(true);
		const capabilityTypes = (manifest.capabilities as unknown[]).map((capability) => typeof capability);
		expect(capabilityTypes).toEqual(['string']);
		expect(typeof (manifest.author as { name?: unknown }).name).toBe('string');
	});

	it('declares an entry point the loader can confine and import', () => {
		// PluginLoaderService.loadPluginModule / confinePluginEntry
		// (packages/agent/src/plugins/services/plugin-loader.service.ts:326-336, :832-860):
		// relative, no `..` segment, and an executable JS extension.
		expect(packageJson.type).toBe('module');
		expect(packageJson.main).toBe('./dist/index.cjs');
		expect(packageJson.main.startsWith('./')).toBe(true);
		expect(packageJson.main.split(/[/\\]/)).not.toContain('..');
		expect(['.js', '.mjs', '.cjs']).toContain(extname(packageJson.main));
		expect(packageJson.module).toBe('./dist/index.js');
	});

	it('declares the category T4 appends to PLUGIN_CATEGORIES, on a gate that fails closed', () => {
		expect(manifest.category).toBe('identity');
		expect(new OidcIdentityPlugin().category).toBe('identity');
		// The gate itself: `isPluginCategory` is what
		// plugin-manifest-validator.service.ts:89 and plugin-class-validator.service.ts:30
		// consult, and it accepts nothing outside the tuple. 'identity' joins that
		// tuple in T4 (packages/plugin/src/contracts/plugin-manifest.types.ts:5-117);
		// asserting membership here today would make this spec red until T4 ships,
		// so the interlock is recorded in the T5 report and proven by the
		// discovery run quoted there.
		// T4 shipped: `'identity'` IS in the tuple now (measured: 27 categories,
		// tail `[app-dependency, build, identity]`), so the interlock this spec
		// used to describe can finally be *asserted*.
		expect(isPluginCategory('identity')).toBe(true);
		expect(isPluginCategory('definitely-not-a-plugin-category')).toBe(false);
	});
});

describe('oidc-identity plugin class', () => {
	const plugin = new OidcIdentityPlugin();

	it('answers the same manifest the package.json declares', () => {
		const fromClass = plugin.getManifest();
		expect(fromClass.id).toBe(manifest.id);
		expect(fromClass.name).toBe(manifest.name);
		expect(fromClass.version).toBe(manifest.version);
		expect(fromClass.category).toBe(manifest.category);
		expect(fromClass.capabilities).toEqual(manifest.capabilities);
		expect(fromClass.builtIn).toBe(manifest.builtIn);
		expect(fromClass.autoEnable).toBe(manifest.autoEnable);
		expect(fromClass.license).toBe(manifest.license);
	});

	it('exposes the plan §4.2 schema as its settingsSchema', () => {
		expect(plugin.settingsSchema).toBe(oidcIdentitySettingsSchema);
		expect(plugin.configurationMode).toBe('admin-only');
	});

	it('keeps onLoad and onUnload on the prototype — what makes the class loadable', () => {
		// PluginClassValidatorService.isPluginClass
		// (packages/agent/src/plugins/services/plugin-class-validator.service.ts:42-55)
		// inspects the prototype, so an arrow-function property would leave the
		// plugin undiscoverable.
		expect(typeof Object.getOwnPropertyDescriptor(OidcIdentityPlugin.prototype, 'onLoad')?.value).toBe('function');
		expect(typeof Object.getOwnPropertyDescriptor(OidcIdentityPlugin.prototype, 'onUnload')?.value).toBe(
			'function'
		);
		expect(Object.prototype.hasOwnProperty.call(plugin, 'onLoad')).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(plugin, 'onUnload')).toBe(false);
	});

	it('claims the single plan §4.2 capability and nothing it does not implement', () => {
		expect([...plugin.capabilities]).toEqual(['identity-provider']);
	});

	it('loads and unloads against a plugin context', async () => {
		const context = {
			pluginId: 'oidc-identity',
			logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
			getSettings: vi.fn().mockResolvedValue({})
		} as unknown as PluginContext;

		await plugin.onLoad(context);
		await plugin.onUnload();

		expect(context.logger.log).toHaveBeenCalledTimes(1);
	});
});
