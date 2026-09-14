import { describe, expect, it } from 'vitest';

import { PLATFORM_DEFAULT_TOOL_GRANT, type ToolGrantChainEntry } from '../../policy/tool-grant.types.js';
import {
	CONNECTION_SCOPE_PRESET_ORDER,
	applyConnectionScopePresetToToolGrant,
	connectionScopePresetClampSource,
	connectionScopePresetCoversTool,
	connectionScopePresetDenyPatterns,
	connectionScopePresetManagedPatterns,
	isConnectionScopePresetId,
	isNarrowerConnectionScopePreset,
	normalizeConnectionScopePresets,
	resolveEffectiveConnectionScopePreset,
	storedConnectionScopePreset,
	type ConnectionScopePresetDeclaration
} from '../connection-scope-preset.types.js';

const PRESETS: ConnectionScopePresetDeclaration[] = [
	{ id: 'read', providerScopes: ['read:user'], toolPatterns: ['repo_list*', 'repo_get*'] },
	{
		id: 'write',
		providerScopes: ['read:user', 'repo'],
		toolPatterns: ['repo_list*', 'repo_get*', 'commitToRepo', 'openPullRequest']
	}
];

function matrix(allow: string[], deny: string[]) {
	return { allow, deny };
}

describe('connection scope presets', () => {
	describe('normalizeConnectionScopePresets', () => {
		it('orders least → most access, drops unknown ids and malformed patterns', () => {
			const out = normalizeConnectionScopePresets([
				{ id: 'write', providerScopes: ['a', 'a', ''], toolPatterns: ['ok_*', 'bad pattern', 42] },
				{ id: 'admin', providerScopes: [], toolPatterns: ['*'] },
				{ id: 'read', providerScopes: ['a'], toolPatterns: [] },
				{ id: 'read', providerScopes: ['ignored'], toolPatterns: ['ignored'] },
				null,
				'read'
			]);

			expect(out).toEqual([
				{ id: 'read', providerScopes: ['a'], toolPatterns: [] },
				{ id: 'write', providerScopes: ['a'], toolPatterns: ['ok_*'] }
			]);
		});

		it('returns [] for anything that is not an array', () => {
			expect(normalizeConnectionScopePresets(undefined)).toEqual([]);
			expect(normalizeConnectionScopePresets({ id: 'read' })).toEqual([]);
		});
	});

	it('has exactly two levels', () => {
		expect(CONNECTION_SCOPE_PRESET_ORDER).toEqual(['read', 'write']);
		expect(isConnectionScopePresetId('read')).toBe(true);
		expect(isConnectionScopePresetId('blocked')).toBe(false);
		expect(isNarrowerConnectionScopePreset('read', 'write')).toBe(true);
		expect(isNarrowerConnectionScopePreset('write', 'read')).toBe(false);
	});

	describe('deny patterns', () => {
		it('narrowing to read denies exactly what only write unlocks', () => {
			expect(connectionScopePresetDenyPatterns(PRESETS, 'read')).toEqual(['commitToRepo', 'openPullRequest']);
		});

		it('the widest level denies nothing', () => {
			expect(connectionScopePresetDenyPatterns(PRESETS, 'write')).toEqual([]);
		});

		it('an undeclared level denies nothing', () => {
			expect(connectionScopePresetDenyPatterns([PRESETS[1]], 'read')).toEqual([]);
		});

		it('a write pattern the read level already covers is not denied', () => {
			const presets = normalizeConnectionScopePresets([
				{ id: 'read', providerScopes: [], toolPatterns: ['repo_*'] },
				{ id: 'write', providerScopes: [], toolPatterns: ['repo_get', 'deploy_*'] }
			]);
			expect(connectionScopePresetDenyPatterns(presets, 'read')).toEqual(['deploy_*']);
		});

		it('managed patterns are the narrowest level’s deny set', () => {
			expect(connectionScopePresetManagedPatterns(PRESETS)).toEqual(['commitToRepo', 'openPullRequest']);
			expect(connectionScopePresetManagedPatterns([])).toEqual([]);
		});
	});

	describe('applyConnectionScopePresetToToolGrant', () => {
		it('choosing read adds the deny set and leaves allow and unrelated denies alone', () => {
			const out = applyConnectionScopePresetToToolGrant({ allow: ['*'], deny: ['deploy_*'] }, PRESETS, 'read');
			expect(out).toEqual({ allow: ['*'], deny: ['deploy_*', 'commitToRepo', 'openPullRequest'] });
		});

		it('choosing write removes only the patterns the preset control owns', () => {
			const out = applyConnectionScopePresetToToolGrant(
				{ deny: ['deploy_*', 'COMMITTOREPO', 'openPullRequest'] },
				PRESETS,
				'write'
			);
			expect(out).toEqual({ deny: ['deploy_*'] });
			expect(out.allow).toBeUndefined();
		});

		it('is idempotent', () => {
			const once = applyConnectionScopePresetToToolGrant(null, PRESETS, 'read');
			const twice = applyConnectionScopePresetToToolGrant(once, PRESETS, 'read');
			expect(twice).toEqual(once);
		});

		it('never touches allow — a preset can only narrow', () => {
			const out = applyConnectionScopePresetToToolGrant({ allow: [] }, PRESETS, 'write');
			expect(out.allow).toEqual([]);
		});
	});

	describe('storedConnectionScopePreset', () => {
		it('reads the level a scope’s own row selects', () => {
			expect(storedConnectionScopePreset({ deny: ['commitToRepo', 'openPullRequest'] }, PRESETS)).toBe('read');
			expect(storedConnectionScopePreset({ deny: ['commitToRepo'] }, PRESETS)).toBe('write');
			expect(storedConnectionScopePreset(null, PRESETS)).toBe('write');
			expect(storedConnectionScopePreset(null, [])).toBeNull();
		});

		it('round-trips with apply', () => {
			for (const id of CONNECTION_SCOPE_PRESET_ORDER) {
				const row = applyConnectionScopePresetToToolGrant({ deny: ['x_*'] }, PRESETS, id);
				expect(storedConnectionScopePreset(row, PRESETS)).toBe(id);
			}
		});
	});

	describe('resolveEffectiveConnectionScopePreset', () => {
		it('the permissive default leaves the widest level in effect', () => {
			expect(
				resolveEffectiveConnectionScopePreset(PRESETS, {
					allow: [...PLATFORM_DEFAULT_TOOL_GRANT.allow],
					deny: []
				})
			).toBe('write');
		});

		it('any deny touching a write-only tool drops to read', () => {
			expect(resolveEffectiveConnectionScopePreset(PRESETS, matrix(['*'], ['commitToRepo']))).toBe('read');
			// A broad deny overlaps too.
			expect(resolveEffectiveConnectionScopePreset(PRESETS, matrix(['*'], ['open*']))).toBe('read');
		});

		it('an allow list that does not cover a write tool drops to read', () => {
			expect(resolveEffectiveConnectionScopePreset(PRESETS, matrix(['repo_*'], []))).toBe('read');
		});

		it('returns null when even the narrowest level is unreachable', () => {
			expect(resolveEffectiveConnectionScopePreset(PRESETS, matrix([], []))).toBeNull();
			expect(resolveEffectiveConnectionScopePreset([], matrix(['*'], []))).toBeNull();
		});

		it('a read level with no tools is always reachable', () => {
			const presets = normalizeConnectionScopePresets([
				{ id: 'read', providerScopes: [], toolPatterns: [] },
				{ id: 'write', providerScopes: [], toolPatterns: ['commitToRepo'] }
			]);
			expect(resolveEffectiveConnectionScopePreset(presets, matrix([], []))).toBe('read');
		});
	});

	describe('connectionScopePresetClampSource', () => {
		const chain: ToolGrantChainEntry[] = [
			{ scope: 'default', id: null, allow: ['*'], deny: [], rejected: [] },
			{ scope: 'organization', id: 'o1', allow: [], deny: ['openPullRequest'], rejected: [] },
			{ scope: 'agent', id: 'a1', allow: [], deny: [], rejected: [] }
		];

		it('names the least specific scope whose deny narrowed the requested level', () => {
			expect(connectionScopePresetClampSource(PRESETS, 'write', 'read', { source: 'organization', chain })).toBe(
				'organization'
			);
		});

		it('is null when nothing narrowed', () => {
			expect(
				connectionScopePresetClampSource(PRESETS, 'write', 'write', { source: 'default', chain })
			).toBeNull();
			expect(connectionScopePresetClampSource(PRESETS, 'read', 'read', { source: 'default', chain })).toBeNull();
			expect(connectionScopePresetClampSource(PRESETS, null, 'read', { source: 'default', chain })).toBeNull();
		});

		it('falls back to the contributing scope when an allow list narrowed it', () => {
			expect(connectionScopePresetClampSource(PRESETS, 'write', 'read', { source: 'work', chain: [] })).toBe(
				'work'
			);
		});
	});

	it('connectionScopePresetCoversTool uses the tool-grant matcher', () => {
		expect(connectionScopePresetCoversTool(PRESETS, 'read', 'repo_list_all')).toBe(true);
		expect(connectionScopePresetCoversTool(PRESETS, 'read', 'commitToRepo')).toBe(false);
		expect(connectionScopePresetCoversTool(PRESETS, 'write', 'COMMITTOREPO')).toBe(true);
		expect(connectionScopePresetCoversTool([], 'write', 'commitToRepo')).toBe(false);
	});
});
