import { describe, expect, it } from 'vitest';

import { PLATFORM_DEFAULT_TOOL_GRANT, type ToolGrantChainEntry } from '../../policy/tool-grant.types.js';
import {
	CONNECTION_SCOPE_PRESET_ORDER,
	applyConnectionScopePresetToToolGrant,
	applyConnectionScopePresetWithOwnership,
	connectionScopePresetBlockingDeny,
	connectionScopePresetOperatorDeny,
	normalizeConnectionScopePresetOwnership,
	pruneConnectionScopePresetOwnership,
	storedConnectionScopePresetWithOwnership,
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

	describe('ownership — an operator deny is never removed by a level change', () => {
		/** Apply a sequence of levels, threading the stored row + record through. */
		function run(
			start: { deny?: string[]; allow?: string[] } | null,
			ownership: unknown,
			steps: Array<'read' | 'write'>
		) {
			let grant = start;
			let record: unknown = ownership;
			for (const step of steps) {
				const next = applyConnectionScopePresetWithOwnership(grant, record, 'github', PRESETS, step);
				grant = next.grant;
				record = next.ownership;
			}
			return { grant, record };
		}

		it('an operator deny present before the first level change survives read → read and write → read', () => {
			const afterRead = run({ deny: ['commitToRepo'] }, null, ['read']);
			expect(afterRead.grant?.deny).toEqual(['commitToRepo', 'openPullRequest']);
			// Only the pattern the control added is recorded.
			expect(afterRead.record).toEqual({ github: { preset: 'read', deny: ['openPullRequest'] } });

			const afterWrite = run(afterRead.grant, afterRead.record, ['write']);
			expect(afterWrite.grant?.deny).toEqual(['commitToRepo']);
			expect(afterWrite.record).toEqual({ github: { preset: 'write', deny: [] } });

			const backToRead = run(afterWrite.grant, afterWrite.record, ['read']);
			expect(backToRead.grant?.deny).toEqual(['commitToRepo', 'openPullRequest']);
			expect(backToRead.record).toEqual({ github: { preset: 'read', deny: ['openPullRequest'] } });
		});

		it('an operator who denied every managed name keeps all of them through any sequence', () => {
			const { grant, record } = run({ deny: ['COMMITTOREPO', 'openPullRequest'] }, null, [
				'write',
				'read',
				'write',
				'write'
			]);
			expect(grant?.deny).toEqual(['COMMITTOREPO', 'openPullRequest']);
			expect(record).toEqual({ github: { preset: 'write', deny: [] } });
		});

		it('preset-owned patterns swap cleanly and leave unrelated operator rules and allow alone', () => {
			const read = run({ allow: ['*'], deny: ['deploy_*'] }, null, ['read']);
			expect(read.grant).toEqual({ allow: ['*'], deny: ['deploy_*', 'commitToRepo', 'openPullRequest'] });
			expect(read.record).toEqual({ github: { preset: 'read', deny: ['commitToRepo', 'openPullRequest'] } });

			const write = run(read.grant, read.record, ['write']);
			expect(write.grant).toEqual({ allow: ['*'], deny: ['deploy_*'] });
		});

		it('mixed: one operator-owned and one preset-owned managed pattern', () => {
			const { grant } = run(
				{ deny: ['openPullRequest'] },
				{ github: { preset: 'read', deny: ['commitToRepo'] } },
				['write']
			);
			// commitToRepo is not in the row, so the record is pruned first; openPullRequest was never owned.
			expect(grant?.deny).toEqual(['openPullRequest']);

			const both = run(
				{ deny: ['openPullRequest', 'commitToRepo'] },
				{ github: { preset: 'read', deny: ['commitToRepo'] } },
				['write']
			);
			expect(both.grant?.deny).toEqual(['openPullRequest']);
			expect(both.record).toEqual({ github: { preset: 'write', deny: [] } });
		});

		it('is idempotent', () => {
			const once = run(null, null, ['read']);
			const twice = run(once.grant, once.record, ['read']);
			expect(twice).toEqual(once);
		});

		it('never removes a pattern another provider’s level still owns', () => {
			const { grant, record } = run(
				{ deny: ['commitToRepo', 'openPullRequest'] },
				{
					github: { preset: 'read', deny: ['commitToRepo', 'openPullRequest'] },
					gitlab: { preset: 'read', deny: ['commitToRepo'] }
				},
				['write']
			);
			expect(grant?.deny).toEqual(['commitToRepo']);
			expect(record).toEqual({
				gitlab: { preset: 'read', deny: ['commitToRepo'] },
				github: { preset: 'write', deny: [] }
			});
		});

		it('pruning drops owned patterns an operator removed by hand, so re-adding them later is operator-owned', () => {
			const pruned = pruneConnectionScopePresetOwnership(
				{ github: { preset: 'read', deny: ['commitToRepo', 'openPullRequest'] } },
				['openPullRequest']
			);
			expect(pruned).toEqual({ github: { preset: 'read', deny: ['openPullRequest'] } });

			// The operator re-adds commitToRepo by hand: widening must keep it.
			const { grant } = run({ deny: ['openPullRequest', 'commitToRepo'] }, pruned, ['write']);
			expect(grant?.deny).toEqual(['commitToRepo']);
			expect(pruneConnectionScopePresetOwnership(null, ['x'])).toBeNull();
		});

		it('a malformed record owns nothing — the safe direction is keeping patterns', () => {
			expect(normalizeConnectionScopePresetOwnership('junk')).toBeNull();
			expect(
				normalizeConnectionScopePresetOwnership({
					github: { preset: 'admin', deny: ['commitToRepo'] },
					gitlab: { preset: 'read', deny: ['bad pattern', 'ok_*'] },
					'': { preset: 'read', deny: [] }
				})
			).toEqual({ gitlab: { preset: 'read', deny: ['ok_*'] } });

			const { grant } = run({ deny: ['commitToRepo', 'openPullRequest'] }, { github: { preset: 'nope' } }, [
				'write'
			]);
			expect(grant?.deny).toEqual(['commitToRepo', 'openPullRequest']);
		});

		it('operator deny is every pattern no level owns', () => {
			expect(
				connectionScopePresetOperatorDeny(['deploy_*', 'commitToRepo', 'openPullRequest'], {
					github: { preset: 'read', deny: ['openPullRequest'] }
				})
			).toEqual(['deploy_*', 'commitToRepo']);
			expect(connectionScopePresetOperatorDeny(null, null)).toEqual([]);
		});

		it('the stored level follows the recorded choice while the row still carries it', () => {
			// Operator denies both write tools; the owner chose "Read and write".
			expect(
				storedConnectionScopePresetWithOwnership(
					{ deny: ['commitToRepo', 'openPullRequest'] },
					{ github: { preset: 'write', deny: [] } },
					'github',
					PRESETS
				)
			).toBe('write');
			// A recorded "read" whose patterns were removed by hand no longer holds.
			expect(
				storedConnectionScopePresetWithOwnership(
					{ deny: ['commitToRepo'] },
					{ github: { preset: 'read', deny: ['commitToRepo'] } },
					'github',
					PRESETS
				)
			).toBe('write');
			// No record: the row's patterns alone decide, exactly as before.
			expect(
				storedConnectionScopePresetWithOwnership(
					{ deny: ['commitToRepo', 'openPullRequest'] },
					null,
					'github',
					PRESETS
				)
			).toBe('read');
			expect(storedConnectionScopePresetWithOwnership(null, null, 'github', [])).toBeNull();
		});

		it('reports the operator rules that hold a tool of the chosen level closed', () => {
			const record = { github: { preset: 'write' as const, deny: [] } };
			expect(connectionScopePresetBlockingDeny(PRESETS, 'write', ['commitToRepo', 'deploy_*'], record)).toEqual([
				'commitToRepo'
			]);
			// A broad operator pattern counts too.
			expect(connectionScopePresetBlockingDeny(PRESETS, 'write', ['open*'], record)).toEqual(['open*']);
			// Patterns the control owns are not "existing rules".
			expect(
				connectionScopePresetBlockingDeny(PRESETS, 'read', ['commitToRepo', 'openPullRequest'], {
					github: { preset: 'read', deny: ['commitToRepo', 'openPullRequest'] }
				})
			).toEqual([]);
			expect(connectionScopePresetBlockingDeny(PRESETS, null, ['commitToRepo'], null)).toEqual([]);
		});
	});

	it('connectionScopePresetCoversTool uses the tool-grant matcher', () => {
		expect(connectionScopePresetCoversTool(PRESETS, 'read', 'repo_list_all')).toBe(true);
		expect(connectionScopePresetCoversTool(PRESETS, 'read', 'commitToRepo')).toBe(false);
		expect(connectionScopePresetCoversTool(PRESETS, 'write', 'COMMITTOREPO')).toBe(true);
		expect(connectionScopePresetCoversTool([], 'write', 'commitToRepo')).toBe(false);
	});
});
