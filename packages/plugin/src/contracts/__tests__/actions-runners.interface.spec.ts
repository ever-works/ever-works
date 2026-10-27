import { describe, expect, it } from 'vitest';
import {
	ActionsRunnersApiError,
	isActionsRunnersApiError,
	isActionsRunnersPlugin,
	type IActionsRunnersPlugin
} from '../capabilities/actions-runners.interface.js';
import { ALL_PLUGIN_CAPABILITIES, isValidPluginCapability, PLUGIN_CAPABILITIES } from '../facade-capabilities.js';
import type { IPlugin } from '../plugin.interface.js';

/** Actions runners on computers (FL-18, CONTRACTS R-14, T-01) — the `actions-runners` capability. */
describe('the actions-runners capability', () => {
	it('is appended last, once, and validates', () => {
		expect(PLUGIN_CAPABILITIES.ACTIONS_RUNNERS).toBe('actions-runners');
		const keys = Object.keys(PLUGIN_CAPABILITIES);
		expect(keys[keys.length - 1]).toBe('ACTIONS_RUNNERS');
		expect(ALL_PLUGIN_CAPABILITIES.filter((value) => value === 'actions-runners')).toHaveLength(1);
		expect(isValidPluginCapability('actions-runners')).toBe(true);
		// Near misses stay invalid: manifests are validated against this guard.
		expect(isValidPluginCapability('actions-runner')).toBe(false);
		expect(isValidPluginCapability('github-actions-runners')).toBe(false);
	});
});

function plugin(overrides: Partial<IActionsRunnersPlugin> = {}): IPlugin {
	return {
		id: 'github-actions-runners',
		name: 'GitHub Actions runners',
		version: '1.0.0',
		category: 'integration',
		capabilities: ['actions-runners'],
		settingsSchema: { type: 'object', properties: {} },
		onLoad: async () => undefined,
		onUnload: async () => undefined,
		listRunners: async () => ({ runners: [], etag: null, notModified: false, rateLimitedUntil: null, rateLimitRemaining: null }),
		mintRegistrationToken: async () => ({ token: 't', expiresAt: null }),
		...overrides
	} as unknown as IPlugin;
}

describe('isActionsRunnersPlugin', () => {
	it('accepts a plugin that declares the capability and implements the reads and the token mint', () => {
		expect(isActionsRunnersPlugin(plugin())).toBe(true);
	});

	it('refuses a plugin without the capability, or without the methods', () => {
		expect(isActionsRunnersPlugin({ ...plugin(), capabilities: ['git-provider'] } as IPlugin)).toBe(false);
		expect(isActionsRunnersPlugin(plugin({ listRunners: undefined }))).toBe(false);
		expect(isActionsRunnersPlugin(plugin({ mintRegistrationToken: undefined }))).toBe(false);
	});
});

describe('ActionsRunnersApiError', () => {
	it('is matched by name, carries the code and never a token', () => {
		const error = new ActionsRunnersApiError('GitHub refused the request', 'permission', 403);
		expect(isActionsRunnersApiError(error)).toBe(true);
		expect(error.code).toBe('permission');
		expect(error.status).toBe(403);
		expect(error.rateLimitedUntil).toBeNull();
		expect(isActionsRunnersApiError(new Error('x'))).toBe(false);
	});
});
