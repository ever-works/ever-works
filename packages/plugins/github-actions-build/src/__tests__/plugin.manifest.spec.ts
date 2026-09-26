import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

import {
	APP_BUILD_SETTING_ALLOW_VALUES_ON_PULL_REQUESTS,
	APP_BUILD_SETTING_ATTESTATIONS,
	APP_BUILD_SETTING_RECLAIM_DISK,
	APP_BUILD_SETTING_VERIFICATION_PROMPTED_REQUIRES_APPROVAL
} from '@ever-works/contracts';
import {
	PLUGIN_CATEGORIES,
	isPluginCategory,
	toPluginSettingsSchemaProperty,
	type PluginContext
} from '@ever-works/plugin';
import Ajv from 'ajv';
import { describe, expect, it, vi } from 'vitest';

import { GitHubActionsBuildPlugin, notImplemented } from '../github-actions-build.plugin.js';
import {
	GITHUB_ACTIONS_BUILD_PLATFORM_MANAGED_KEYS,
	GITHUB_ACTIONS_BUILD_SETTING_DEFAULTS,
	GITHUB_ACTIONS_BUILD_SETTING_KEYS,
	PREPARATION_STATE_KEYS,
	gitHubActionsBuildSettingsSchema,
	type PlatformManagedJsonSchema
} from '../settings.schema.js';

/**
 * APW-05 T7 — the plugin manifest, the plan §4.4 settings schema, and the
 * negative assertion that keeps preparation state out of it (`APW05-G03`).
 *
 * Three deliberate choices in this file:
 *
 *   1. **The schema is exercised by the platform's own validator
 *      configuration**, transcribed from `SettingsSchemaValidatorService`
 *      (`packages/agent/src/plugins/services/settings-schema-validator.service.ts:60-68`
 *      — `allErrors: true`, `strict: false`, `useDefaults: false`,
 *      `coerceTypes: false`; `addFormats` is omitted because this schema declares
 *      no `format` keyword, so it would change nothing). A bound is therefore proven by
 *      feeding the validator a document that breaks it, not by re-reading the
 *      number out of the schema — and `useDefaults: false` is what makes the
 *      "`largerRunnerMemoryGiB` is required when the label is set" rule bite.
 *   2. **No assertion can print a token.** Every check that touches `pullToken`
 *      compares a boolean or a marker first, because a failed `expect(value)`
 *      would paste the value into the test's own failure message.
 *   3. **The five preparation keys are asserted absent *and* shown to be real.**
 *      A negative assertion over five strings is vacuous unless those strings
 *      name something: they are the `work_build_preparations` columns of plan
 *      §3.1b (APW-05 T4/T5/T6), and the last case in the first describe block
 *      reads that entity to prove it.
 *
 * **Routed, and reported rather than faked (`APW05-G07`).** T7's Test line also
 * asks that `validateSettingsScope` refuse `pullToken` and `pullTokenExpiresAt`
 * at every scope. That method is `PluginSettingsService.validateSettingsScope`
 * (`packages/agent/src/plugins/services/plugin-settings.service.ts:812`) — private,
 * in another package, and it reads no platform-managed marker today
 * (`x-platformManaged` exists nowhere in the tree). The plugin side owns exactly
 * one half of that handshake, and it is asserted here: both keys carry the marker
 * and both sit at `x-scope: 'work'`, so neither is offered to a user- or
 * admin-scoped read. The refusal half is the agent-side half of `APW05-G07`.
 */

const SECRET = 'ghp_pull_token_0123456789abcdef_do_not_print';
const MASKED = '********';

/** The ajv the API and the agent package both use, configured the same way. */
const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false, coerceTypes: false });
const validate = ajv.compile(gitHubActionsBuildSettingsSchema as object);
const messages = (): string[] => validate.errors?.map((error) => `${error.instancePath} ${error.message}`) ?? [];

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

/**
 * One property of the settings schema, typed as the platform-managed shape.
 *
 * The schema's `properties` is `Record<string, JsonSchema | PlatformManagedJsonSchema>`
 * — the union `PlatformManagedJsonSchema` exists so plan §4.4's marker can be
 * declared at all (see `settings.schema.ts`) — so this accessor is where the
 * marker becomes readable without a cast that would hide it.
 */
const platformManagedSchema = (key: string): PlatformManagedJsonSchema | undefined =>
	gitHubActionsBuildSettingsSchema.properties?.[key] as PlatformManagedJsonSchema | undefined;

describe('github-actions-build — the plan §4.3 manifest and the discovery shape', () => {
	it('carries the plan §4.3 everworks.plugin block', () => {
		expect(manifest).toEqual({
			id: 'github-actions-build',
			name: 'GitHub Actions builds',
			version: '1.0.0',
			category: 'build',
			capabilities: ['build'],
			description:
				"Builds the App Work's container image on GitHub-hosted runners, through the workflow Ever Works writes into the repository's tracked branch",
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			autoEnable: true,
			builtIn: true,
			visibility: 'user-only'
		});
	});

	it('declares the category T3 appended to PLUGIN_CATEGORIES, on a gate that fails closed', () => {
		expect(manifest.category).toBe('build');
		expect(new GitHubActionsBuildPlugin().category).toBe('build');
		// The gate itself: `isPluginCategory` is what the loader's manifest and
		// class validators consult, and it accepts nothing outside the tuple.
		expect(isPluginCategory('build')).toBe(true);
		expect(isPluginCategory('definitely-not-a-plugin-category')).toBe(false);
		expect(PLUGIN_CATEGORIES).toContain('build');
	});

	it('uses the filter name T7 and every later task calls it by', () => {
		expect(packageJson.name).toBe('@ever-works/github-actions-build-plugin');
	});

	it('satisfies every manifest rule the loader checks before it loads the class', () => {
		// Transcribed from PluginManifestValidatorService.validate
		// (packages/agent/src/plugins/services/plugin-manifest-validator.service.ts:44-97):
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
		expect((manifest.capabilities as unknown[]).map((capability) => typeof capability)).toEqual(['string']);
		expect(typeof (manifest.author as { name?: unknown }).name).toBe('string');
		expect(manifest.capabilities).toEqual(['build']);
	});

	it('declares an entry point the loader can confine and import', () => {
		// PluginLoaderService.loadPluginModule / confinePluginEntry
		// (packages/agent/src/plugins/services/plugin-loader.service.ts:326-336, :832-860):
		// relative, no `..` segment, and an executable JS extension.
		expect(packageJson.type).toBe('module');
		expect(packageJson.main).toBe('./dist/index.cjs');
		expect(packageJson.main.split(/[/\\]/)).not.toContain('..');
		expect(['.js', '.mjs', '.cjs']).toContain(extname(packageJson.main));
		expect(packageJson.module).toBe('./dist/index.js');
	});

	it('answers the same manifest the package.json declares', () => {
		const plugin = new GitHubActionsBuildPlugin();
		const fromClass = plugin.getManifest();
		expect(fromClass.id).toBe(manifest.id);
		expect(fromClass.name).toBe(manifest.name);
		expect(fromClass.version).toBe(manifest.version);
		expect(fromClass.category).toBe(manifest.category);
		expect(fromClass.capabilities).toEqual(manifest.capabilities);
		expect(fromClass.builtIn).toBe(manifest.builtIn);
		expect(fromClass.autoEnable).toBe(manifest.autoEnable);
		expect(fromClass.license).toBe(manifest.license);
		expect(fromClass.visibility).toBe(manifest.visibility);
	});

	it('keeps onLoad and onUnload on the prototype — what makes the class loadable', () => {
		// PluginClassValidatorService.isPluginClass
		// (packages/agent/src/plugins/services/plugin-class-validator.service.ts:42-55)
		// inspects the prototype, so an arrow-function property would leave the
		// plugin undiscoverable.
		expect(typeof Object.getOwnPropertyDescriptor(GitHubActionsBuildPlugin.prototype, 'onLoad')?.value).toBe(
			'function'
		);
		expect(typeof Object.getOwnPropertyDescriptor(GitHubActionsBuildPlugin.prototype, 'onUnload')?.value).toBe(
			'function'
		);
		expect(Object.prototype.hasOwnProperty.call(new GitHubActionsBuildPlugin(), 'onLoad')).toBe(false);
	});

	it('loads and unloads against a plugin context', async () => {
		const plugin = new GitHubActionsBuildPlugin();
		const context = {
			pluginId: 'github-actions-build',
			logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
			getSettings: vi.fn().mockResolvedValue({})
		} as unknown as PluginContext;

		await plugin.onLoad(context);
		await plugin.onUnload();

		expect(context.logger.log).toHaveBeenCalledTimes(1);
	});
});

describe('github-actions-build — the build capability declaration (T7, R-13)', () => {
	const plugin = new GitHubActionsBuildPlugin();

	it('claims exactly the build capability the facade resolves on', () => {
		expect([...plugin.capabilities]).toEqual(['build']);
	});

	it("declares buildKind 'github-actions'", () => {
		expect(plugin.buildKind).toBe('github-actions');
	});

	it('supports dockerfile, and excludes auto (R-13)', () => {
		expect([...plugin.supportedStrategies]).toEqual(['dockerfile']);
		expect(plugin.supportedStrategies).not.toContain('auto');
	});

	it('no longer throws not implemented from ANY member — the list is empty', async () => {
		// Rule: a capability a plugin claims, it implements — and where it cannot
		// yet, it fails loudly instead of answering.
		//
		// The history of this case IS the epic's: it listed all five members until
		// 2026-09-21, when T12 implemented four (`startBuild`, `getBuild`,
		// `cancelBuild`, `getLogsUrl`); `prepareRepository` stayed, waiting on T11's
		// runner selector; T11 landed on 2026-09-22 and T41's checks job turned out
		// to be already written, so §4.6 could be composed and the list is now empty.
		//
		// Each member is called with empty inputs, so it fails on the SHAPE of what
		// it was given. What this pins is the distinction: whatever these five do
		// now, `is not implemented yet` is not it.
		const cases: Array<() => Promise<unknown>> = [
			() => plugin.prepareRepository({} as never, { token: 'x' }, {} as never),
			() => plugin.startBuild({} as never, { token: 'x' }),
			() => plugin.getBuild({} as never, { token: 'x' }, (text) => text),
			() => plugin.cancelBuild({} as never, { token: 'x' }),
			() => plugin.getLogsUrl({} as never, { token: 'x' })
		];
		for (const call of cases) {
			await expect(call()).rejects.not.toThrow(/is not implemented yet/);
		}

		// The helper stays exported and its message format stays pinned. It is the
		// shape the NEXT unwritten member must use, and deleting a working refusal
		// helper because nothing currently refuses is how the next one ends up
		// throwing a bare `Error('todo')`.
		expect(notImplemented('someFutureMember', 'APW-05 T99').message).toBe(
			'github-actions-build: someFutureMember is not implemented yet — APW-05 T99 owns it.'
		);
	});

	it('declares `checkImageAccess` now that it does something, and still not `listRecentRuns`', () => {
		// The contract makes both optional and a caller materialises them, so a
		// throwing placeholder would claim a wiring that does not exist. T14 gave
		// `checkImageAccess` a real implementation (`registry/ghcr-access.ts`), so it
		// is declared; T12's run discovery is still unwritten, so it is not.
		expect(typeof (plugin as unknown as Record<string, unknown>).checkImageAccess).toBe('function');
		expect((plugin as unknown as Record<string, unknown>).listRecentRuns).toBeUndefined();
	});

	it('declares no validateSettings for the pull token — that check is T29s (plan §4.12)', () => {
		// Plan §4.12: `IPlugin.validateSettings?(settings)` receives the settings map
		// only — no workId, no image repository, no Build sha — so it can neither ask
		// "can this token read THIS image" nor write `pullTokenExpiresAt`. The check
		// is `AppBuildPullTokenService.save`, not this class.
		expect((plugin as unknown as Record<string, unknown>).validateSettings).toBeUndefined();
	});
});

describe('github-actions-build — the plan §4.4 settings schema', () => {
	it('declares the nine keys of plan §4.4, in the table order', () => {
		expect(Object.keys(gitHubActionsBuildSettingsSchema.properties ?? {})).toEqual([
			...GITHUB_ACTIONS_BUILD_SETTING_KEYS
		]);
	});

	it('defaults attestations false and reclaimDisk true (FR-25, plan §4.4)', () => {
		expect(gitHubActionsBuildSettingsSchema.properties?.attestations?.default).toBe(false);
		expect(gitHubActionsBuildSettingsSchema.properties?.reclaimDisk?.default).toBe(true);
		expect(GITHUB_ACTIONS_BUILD_SETTING_DEFAULTS.attestations).toBe(false);
		expect(GITHUB_ACTIONS_BUILD_SETTING_DEFAULTS.reclaimDisk).toBe(true);
	});

	it('defaults the two XC-01 booleans to the safe values (plan §4.7b)', () => {
		const props = gitHubActionsBuildSettingsSchema.properties;
		expect(props?.[APP_BUILD_SETTING_ALLOW_VALUES_ON_PULL_REQUESTS]?.default).toBe(false);
		expect(props?.[APP_BUILD_SETTING_VERIFICATION_PROMPTED_REQUIRES_APPROVAL]?.default).toBe(true);
	});

	it('carries the four keys the contracts name, by the contracts name', () => {
		// The setting keys are read by APW-07's resolver and by the prepare runner, so
		// they are pinned against the contract constants rather than only spelled here.
		const properties = gitHubActionsBuildSettingsSchema.properties ?? {};
		for (const key of [
			APP_BUILD_SETTING_RECLAIM_DISK,
			APP_BUILD_SETTING_ATTESTATIONS,
			APP_BUILD_SETTING_ALLOW_VALUES_ON_PULL_REQUESTS,
			APP_BUILD_SETTING_VERIFICATION_PROMPTED_REQUIRES_APPROVAL
		]) {
			expect(Object.keys(properties)).toContain(key);
		}
	});

	it('marks pullToken x-secret and both platform-managed keys x-platformManaged (APW05-G07)', () => {
		const platformManaged = GITHUB_ACTIONS_BUILD_SETTING_KEYS.filter(
			(key) => platformManagedSchema(key)?.['x-platformManaged'] === true
		);
		expect(platformManaged).toEqual([...GITHUB_ACTIONS_BUILD_PLATFORM_MANAGED_KEYS]);

		const secrets = GITHUB_ACTIONS_BUILD_SETTING_KEYS.filter(
			(key) => platformManagedSchema(key)?.['x-secret'] === true
		);
		expect(secrets).toEqual(['pullToken']);
	});

	it('keeps both managed keys at work scope, so no user- or admin-scoped read offers them', () => {
		expect(platformManagedSchema('pullToken')?.['x-scope']).toBe('work');
		expect(platformManagedSchema('pullTokenExpiresAt')?.['x-scope']).toBe('work');
	});

	it('marks the secret through the SDK descriptor every API response is built from', () => {
		const describedProperties = toPluginSettingsSchemaProperty(gitHubActionsBuildSettingsSchema).properties ?? {};
		expect(describedProperties.pullToken.secret).toBe(true);
		expect(describedProperties.pullToken.scope).toBe('work');
		expect(describedProperties.reclaimDisk.secret).toBeUndefined();
	});

	it('projects settings without the token value and without dropping the rest', () => {
		const describedProperties = toPluginSettingsSchemaProperty(gitHubActionsBuildSettingsSchema).properties ?? {};
		const settings: Record<string, unknown> = { pullToken: SECRET, reclaimDisk: false, largerRunnerLabel: 'big' };
		const response = Object.fromEntries(
			Object.entries(settings).map(([key, value]) => [
				key,
				describedProperties[key]?.secret === true ? MASKED : value
			])
		);
		const leaked = JSON.stringify(response).includes(SECRET);
		expect(leaked).toBe(false);
		expect(response.pullToken).toBe(MASKED);
		// Non-vacuity: a projection that dropped everything would pass the two above.
		expect(response.reclaimDisk).toBe(false);
		expect(response.largerRunnerLabel).toBe('big');
	});

	it('offers no default or example that could stand in for the token', () => {
		const token = gitHubActionsBuildSettingsSchema.properties?.pullToken;
		expect(token?.default).toBeUndefined();
		expect(token?.examples).toBeUndefined();
	});
});

describe('github-actions-build — the plan §4.4 limits, through the platform validator', () => {
	it('accepts an empty settings document (the control for every limit below)', () => {
		const valid = validate({}) as boolean;
		expect({ valid, errors: messages() }).toEqual({ valid: true, errors: [] });
	});

	it('accepts a larger-runner label with its memory and refuses the label alone', () => {
		const withBoth = validate({ largerRunnerLabel: 'ubuntu-latest-8-cores', largerRunnerMemoryGiB: 32 }) as boolean;
		expect(withBoth).toBe(true);

		const alone = validate({ largerRunnerLabel: 'ubuntu-latest-8-cores' }) as boolean;
		expect(alone).toBe(false);
		expect(messages()).toContain(" must have required property 'largerRunnerMemoryGiB'");
	});

	it('binds the larger runner numbers to the plan §4.4 ranges', () => {
		expect(validate({ largerRunnerMemoryGiB: 8 }) as boolean).toBe(true);
		expect(validate({ largerRunnerMemoryGiB: 256 }) as boolean).toBe(true);
		expect(validate({ largerRunnerMemoryGiB: 7 }) as boolean).toBe(false);
		expect(messages()).toContain('/largerRunnerMemoryGiB must be >= 8');
		expect(validate({ largerRunnerMemoryGiB: 257 }) as boolean).toBe(false);
		expect(messages()).toContain('/largerRunnerMemoryGiB must be <= 256');

		expect(validate({ largerRunnerVcpu: 2 }) as boolean).toBe(true);
		expect(validate({ largerRunnerVcpu: 64 }) as boolean).toBe(true);
		expect(validate({ largerRunnerVcpu: 1 }) as boolean).toBe(false);
		expect(messages()).toContain('/largerRunnerVcpu must be >= 2');
	});

	it('refuses a label outside the plan §4.4 charset', () => {
		const invalid = validate({ largerRunnerLabel: 'ubuntu latest', largerRunnerMemoryGiB: 32 }) as boolean;
		expect(invalid).toBe(false);
		expect(messages()).toContain('/largerRunnerLabel must match pattern "^[A-Za-z0-9._-]{1,64}$"');
		expect(validate({ largerRunnerLabel: 'x'.repeat(65), largerRunnerMemoryGiB: 32 }) as boolean).toBe(false);
	});

	it('keeps a validation failure from echoing the token', () => {
		const invalid = { pullToken: SECRET, reclaimDisk: 'yes' };
		const rejected = validate(invalid) as boolean;
		expect(rejected).toBe(false);
		expect(messages()).toContain('/reclaimDisk must be boolean');
		const errorsCarryToken = JSON.stringify(validate.errors ?? []).includes(SECRET);
		expect(errorsCarryToken).toBe(false);
	});
});

describe('github-actions-build — no preparation key is declared (APW05-G03)', () => {
	const properties = Object.keys(gitHubActionsBuildSettingsSchema.properties ?? {});

	it('declares none of the five preparation keys of plan §3.1b', () => {
		for (const key of PREPARATION_STATE_KEYS) {
			expect(properties).not.toContain(key);
		}
		expect(properties.filter((key) => PREPARATION_STATE_KEYS.includes(key as never))).toEqual([]);
	});

	it('names five keys that really are preparation state, so the negative assertion is not vacuous', () => {
		// The real counterpart in the tree: the `work_build_preparations` entity
		// (APW-05 T4/T5/T6). These five spellings are its columns, which is why they
		// may not be settings: their one home is the per-App-Work preparation row,
		// and a settings key would put them back in reach of the settings API
		// (plan §4.6:900–907).
		const entity = readFileSync(
			new URL('../../../../agent/src/entities/work-build-preparation.entity.ts', import.meta.url),
			'utf-8'
		);
		const missing = PREPARATION_STATE_KEYS.filter((key) => !entity.includes(`${key}?:`));
		expect(missing).toEqual([]);
	});

	it('declares the settings the generator and the runner read, and nothing else', () => {
		expect(properties).toEqual([...GITHUB_ACTIONS_BUILD_SETTING_KEYS]);
	});
});
