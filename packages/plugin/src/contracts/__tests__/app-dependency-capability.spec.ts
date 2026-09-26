import { describe, expect, it } from 'vitest';
import { PLUGIN_CATEGORIES, type PluginCategory } from '../plugin-manifest.types.js';
import { PLUGIN_CAPABILITIES, type PluginCapability } from '../facade-capabilities.js';
import { isAppDependencyProvider, type IAppDependencyProvider } from '../capabilities/app-dependency.interface.js';
import type { IPlugin } from '../plugin.interface.js';

/**
 * APW-07 T3 — the `app-dependency` capability and category.
 *
 * The interface itself is pinned by its own compile-time shape (the service that
 * implements it, `AppDependenciesService`, is checked against it in
 * `packages/agent`). What this spec exists for is the two things a capability can
 * silently get wrong:
 *
 *  1. **the constant and the category are the strings the plan names**, so a
 *     provider's manifest, the selector and the web's category maps all agree;
 *  2. **nothing was removed to make room for it.** Both tuples are append-only
 *     surfaces: a capability or category that disappears silently breaks every
 *     plugin manifest that declares it, and the failure shows up as a plugin that
 *     loads with fewer capabilities than it has — never as an error. The
 *     `EXISTING_*` lists below are the pre-APW-07 snapshot, so a removal fails
 *     here with the missing name in the message.
 */

/**
 * Every capability VALUE that existed before APW-07 T3 appended `app-dependency`.
 *
 * Taken from acade-capabilities.ts at that commit rather than hand-written: the
 * capability values are not the category names (`form-schema-provider`, not `form`;
 * `metrics-provider`, not `metrics`), and a first draft of this list conflated the two
 * and failed on its own snapshot.
 */
const EXISTING_CAPABILITIES = [
	'agent-memory',
	'ai-provider',
	'browser-automation',
	'code-edit',
	'connection-scopes',
	'connector',
	'connector-bluesky',
	'connector-discord',
	'connector-hubspot',
	'connector-linear',
	'connector-mastodon',
	'connector-notion',
	'connector-pipedrive',
	'connector-slack',
	'connector-whatsapp',
	'content-extractor',
	'data-source',
	'deployment',
	'device-auth',
	'email-inbound',
	'email-outbound',
	'event-source',
	'form-schema-provider',
	'get-object',
	'git-provider',
	'metrics-provider',
	'notification-channel',
	'notification-channel-discord',
	'notification-channel-novu',
	'notification-channel-slack',
	'notification-channel-telegram',
	'notification-channel-whatsapp',
	'oauth',
	'pipeline',
	'pipeline-modifier',
	'playbook-provider',
	'presigned-put',
	'prompt-provider',
	'put-object',
	'screenshot',
	'search',
	'skills-provider',
	'storage',
	'task-tracker',
	'terminal-stream',
	'workspace'
] as const;

/** Every category that existed before APW-07 T3 appended `app-dependency`. */
const PRE_APW07_CATEGORIES = [
	'git-provider',
	'deployment',
	'screenshot',
	'search',
	'content-extractor',
	'data-source',
	'ai-provider',
	'pipeline',
	'form',
	'integration',
	'utility',
	'theme',
	'storage',
	'database',
	'email-provider',
	'notification-channel',
	'connector',
	'vector-store',
	'dns',
	'secret-store-resolver',
	'job-runtime',
	'memory',
	'rag',
	'metrics'
] as const;

/**
 * Every category present BESIDES `app-dependency`, in the tuple's own order: the
 * block above followed by whatever a later epic appended — APW-05 T2 added
 * `build`, then APW-12 T4 added `identity` (the `identity-provider` capability),
 * the last entry.
 *
 * The epic that appends a category extends this list in the same change (and its
 * own spec pins where its member sits). Leaving it behind does not make the
 * append-only assertion below weaker, it makes it FAIL on a legitimate append,
 * which is exactly how this line was found.
 */
const EXISTING_CATEGORIES = [...PRE_APW07_CATEGORIES, 'build', 'identity'] as const;

describe('the app-dependency capability (APW-07 T3)', () => {
	it('names the capability exactly as the plan does', () => {
		expect(PLUGIN_CAPABILITIES.APP_DEPENDENCY).toBe('app-dependency');
		const capability: PluginCapability = PLUGIN_CAPABILITIES.APP_DEPENDENCY;
		expect(capability).toBe('app-dependency');
	});

	it('appends the category without removing, reordering or duplicating a member', () => {
		expect(PLUGIN_CATEGORIES).toContain('app-dependency');

		// The append-only guarantee, asserted rather than assumed: every pre-existing
		// member is still there, in the same relative order, exactly once.
		const remaining = PLUGIN_CATEGORIES.filter((entry) => entry !== 'app-dependency');
		expect(remaining).toEqual([...EXISTING_CATEGORIES]);
		expect(new Set(PLUGIN_CATEGORIES).size).toBe(PLUGIN_CATEGORIES.length);

		// …and it was appended at the end of ITS change, which is what "append" means
		// here: a category inserted in the middle would renumber every index a consumer
		// persisted. Later epics append behind it (APW-05 T2's `build`), so the durable
		// form is "it sits immediately after the block that preceded it" — pinned as an
		// index and as a slice, both of which a mid-tuple insertion breaks.
		expect(PLUGIN_CATEGORIES.indexOf('app-dependency')).toBe(PRE_APW07_CATEGORIES.length);
		expect(PLUGIN_CATEGORIES.slice(0, PRE_APW07_CATEGORIES.length)).toEqual([...PRE_APW07_CATEGORIES]);

		// The derived union follows the tuple (a `satisfies` line, so a future edit
		// cannot widen one without the other).
		const asCategory: PluginCategory = 'app-dependency';
		expect(PLUGIN_CATEGORIES).toContain(asCategory);
	});

	it('keeps every pre-existing capability present', () => {
		const values = Object.values(PLUGIN_CAPABILITIES) as readonly string[];
		for (const capability of EXISTING_CAPABILITIES) {
			expect(values, capability).toContain(capability);
		}
		// A capability value and its key are the same string for this family (the map is
		// `KEY: 'value'` with identical spellings) — the house convention across the file.
		expect(PLUGIN_CAPABILITIES.APP_DEPENDENCY).toBe('app-dependency');
	});
});

describe('isAppDependencyProvider (APW-07 T3)', () => {
	/**
	 * A minimal provider: the capability, one descriptor, and the four methods the guard
	 * checks (`supports`, `provision`, `deprovision` — and `dependencyProviders` being an
	 * array). `getOutputs` / `backupStatus` are part of the interface a real provider
	 * implements; the guard deliberately does not require them, and the last case below
	 * pins that difference.
	 */
	const provider = {
		id: 'inline-postgres',
		name: 'Inline PostgreSQL',
		version: '1.0.0',
		capabilities: [PLUGIN_CAPABILITIES.APP_DEPENDENCY],
		dependencyProviders: [{ kind: 'postgres', providerId: 'inline-postgres', label: 'PostgreSQL' }],
		supports: async () => ({ supported: true }),
		provision: async () => ({ status: 'ready' }),
		deprovision: async () => ({ status: 'released' })
	} as unknown as IAppDependencyProvider;

	it('accepts a plugin that declares the capability and the members', () => {
		expect(isAppDependencyProvider(provider as unknown as IPlugin)).toBe(true);
	});

	it('refuses a plugin that declares the capability but not the members', () => {
		// The capability string alone is not enough: the guard checks the METHODS, because
		// a manifest can claim a capability its implementation does not have — and the
		// lazy-plugin proxy over-reports optional members, so a `typeof` guard on the real
		// plugin is what makes the answer trustworthy.
		expect(
			isAppDependencyProvider({
				...provider,
				provision: undefined
			} as unknown as IPlugin)
		).toBe(false);

		expect(
			isAppDependencyProvider({
				...provider,
				dependencyProviders: undefined
			} as unknown as IPlugin)
		).toBe(false);
	});

	it('requires the capability itself, not just the shape', () => {
		expect(
			isAppDependencyProvider({
				...provider,
				capabilities: [PLUGIN_CAPABILITIES.DEPLOYMENT]
			} as unknown as IPlugin)
		).toBe(false);
	});
});
