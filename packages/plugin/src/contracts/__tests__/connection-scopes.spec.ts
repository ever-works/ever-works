import { describe, expect, it } from 'vitest';
import {
	CONNECTION_SCOPES_CAPABILITY,
	isConnectionScopesPlugin,
	type IConnectionScopesPlugin
} from '../capabilities/connection-scopes.interface.js';
import { ALL_PLUGIN_CAPABILITIES, PLUGIN_CAPABILITIES } from '../facade-capabilities.js';
import type { IPlugin } from '../plugin.interface.js';

describe('connection-scopes capability (AW-15)', () => {
	it('registers `connection-scopes` in the capability registry', () => {
		expect(CONNECTION_SCOPES_CAPABILITY).toBe('connection-scopes');
		expect(PLUGIN_CAPABILITIES.CONNECTION_SCOPES).toBe('connection-scopes');
		expect(ALL_PLUGIN_CAPABILITIES).toContain('connection-scopes');
	});

	it('the guard is true only when the capability is declared AND implemented', () => {
		const declared = {
			capabilities: ['git-provider', 'connection-scopes'],
			getConnectionScopePresets: () => []
		} as unknown as IConnectionScopesPlugin;
		const undeclared = {
			capabilities: ['git-provider'],
			getConnectionScopePresets: () => []
		} as unknown as IPlugin;
		const unimplemented = { capabilities: ['connection-scopes'] } as unknown as IPlugin;
		const malformed = { capabilities: undefined } as unknown as IPlugin;

		expect(isConnectionScopesPlugin(declared)).toBe(true);
		expect(isConnectionScopesPlugin(undeclared)).toBe(false);
		expect(isConnectionScopesPlugin(unimplemented)).toBe(false);
		expect(isConnectionScopesPlugin(malformed)).toBe(false);
	});

	it('does not move any existing capability export', () => {
		expect(PLUGIN_CAPABILITIES.OAUTH).toBe('oauth');
		expect(PLUGIN_CAPABILITIES.GIT_PROVIDER).toBe('git-provider');
		expect(PLUGIN_CAPABILITIES.EVENT_SOURCE).toBe('event-source');
	});
});
