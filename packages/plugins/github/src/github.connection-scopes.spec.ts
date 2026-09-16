import { describe, expect, it, vi } from 'vitest';
import { isConnectionScopesPlugin } from '@ever-works/plugin';

vi.mock('libsodium-wrappers', () => ({
	default: {
		ready: Promise.resolve(),
		from_base64: vi.fn(),
		crypto_box_seal: vi.fn(),
		to_base64: vi.fn()
	}
}));

const { GitHubPlugin } = await import('./github.plugin.js');
const { GITHUB_CONNECTION_SCOPE_PRESETS, GITHUB_MUTATING_AGENT_TOOLS } = await import('./github.connection-scopes.js');

/**
 * The tool-grant pattern grammar (`*`, `prefix*`, exact), case-insensitive.
 * Restated in this spec only because this package does not depend on
 * `@ever-works/contracts` directly; the platform evaluates the declared
 * patterns with the contracts matcher.
 */
function patternMatches(patterns: readonly string[], toolName: string): boolean {
	const name = toolName.toLowerCase();
	return patterns.some((raw) => {
		const pattern = raw.toLowerCase();
		if (pattern === '*') return true;
		if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
		return pattern === name;
	});
}

describe('GitHub connection scope presets', () => {
	const plugin = new GitHubPlugin();
	const presets = plugin.getConnectionScopePresets();
	const read = presets.find((preset) => preset.id === 'read');
	const write = presets.find((preset) => preset.id === 'write');

	it('declares the capability and implements it', () => {
		expect(plugin.capabilities).toContain('connection-scopes');
		expect(isConnectionScopesPlugin(plugin)).toBe(true);
		expect(presets).toBe(GITHUB_CONNECTION_SCOPE_PRESETS);
	});

	it('declares both levels, least → most access', () => {
		expect(presets.map((preset) => preset.id)).toEqual(['read', 'write']);
		expect(read).toBeDefined();
		expect(write).toBeDefined();
	});

	it('read unlocks no mutating tool', () => {
		for (const tool of GITHUB_MUTATING_AGENT_TOOLS) {
			expect(patternMatches(read!.toolPatterns, tool)).toBe(false);
		}
	});

	it('write unlocks every mutating tool', () => {
		for (const tool of GITHUB_MUTATING_AGENT_TOOLS) {
			expect(patternMatches(write!.toolPatterns, tool)).toBe(true);
		}
	});

	it('write.providerScopes is a strict superset of read.providerScopes', () => {
		for (const scope of read!.providerScopes) {
			expect(write!.providerScopes).toContain(scope);
		}
		expect(write!.providerScopes.length).toBeGreaterThan(read!.providerScopes.length);
	});
});
