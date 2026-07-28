import {
    PLATFORM_DEFAULT_TOOL_GRANT,
    matchesToolPattern,
    toolPatternCovers,
} from '@ever-works/contracts';
import {
    decideToolGrant,
    narrowAllowPatterns,
    partitionToolsByGrant,
    resolveToolGrantChain,
    type ToolGrantLayer,
} from '../tool-grant';

/**
 * Tool-grant matrix (audit item G4) — the pure resolution + decision core.
 *
 * The security-critical assertion in this file is the "no upward
 * widening" block: an Agent-level grant must never reach past what its
 * Work / organization / tenant granted. Everything else is a supporting
 * cast.
 */

const layer = (
    scope: ToolGrantLayer['scope'],
    grant: ToolGrantLayer['grant'],
    id = `${scope}-1`,
): ToolGrantLayer => ({ scope, id, grant });

/** Last chain entry — `Array.prototype.at` is ES2022; this package targets ES2021. */
const lastEntry = <T>(rows: T[]): T => rows[rows.length - 1];

describe('matchesToolPattern', () => {
    it('matches everything on `*`', () => {
        expect(matchesToolPattern('*', 'anything')).toBe(true);
    });

    it('matches a prefix glob', () => {
        expect(matchesToolPattern('git_*', 'git_commit')).toBe(true);
        expect(matchesToolPattern('git_*', 'deploy_work')).toBe(false);
    });

    it('matches an exact name, case-insensitively', () => {
        expect(matchesToolPattern('commitToRepo', 'committorepo')).toBe(true);
        expect(matchesToolPattern('commitToRepo', 'commitToRepoNow')).toBe(false);
    });

    it('never matches on empty input', () => {
        expect(matchesToolPattern('', 'x')).toBe(false);
        expect(matchesToolPattern('*', '')).toBe(false);
    });
});

describe('toolPatternCovers', () => {
    it('`*` covers every pattern including other wildcards', () => {
        expect(toolPatternCovers('*', 'git_*')).toBe(true);
        expect(toolPatternCovers('*', 'commitToRepo')).toBe(true);
    });

    it('a prefix glob covers narrower patterns under the same prefix', () => {
        expect(toolPatternCovers('git_*', 'git_commit')).toBe(true);
        expect(toolPatternCovers('git_*', 'git_*')).toBe(true);
    });

    it('a narrower pattern does NOT cover a broader one', () => {
        expect(toolPatternCovers('git_commit', 'git_*')).toBe(false);
        expect(toolPatternCovers('git_*', '*')).toBe(false);
    });
});

describe('resolveToolGrantChain', () => {
    it('resolves to the permissive platform default when no layer speaks', () => {
        const resolved = resolveToolGrantChain([]);
        expect(resolved.matrix).toEqual({
            allow: [...PLATFORM_DEFAULT_TOOL_GRANT.allow],
            deny: [...PLATFORM_DEFAULT_TOOL_GRANT.deny],
        });
        expect(resolved.source).toBe('default');
    });

    it('preserves the platform default for layers that store nothing', () => {
        const resolved = resolveToolGrantChain([
            layer('tenant', null),
            layer('work', {}),
            layer('agent', undefined),
        ]);
        expect(resolved.matrix.allow).toEqual(['*']);
        expect(resolved.source).toBe('default');
    });

    it('narrows down the chain — each layer intersects its ancestors', () => {
        const resolved = resolveToolGrantChain([
            layer('tenant', { allow: ['git_*', 'deploy_*'] }),
            layer('work', { allow: ['git_*'] }),
            layer('agent', { allow: ['git_commit'] }),
        ]);
        expect(resolved.matrix.allow).toEqual(['git_commit']);
        expect(resolved.source).toBe('agent');
    });

    it('sorts layers into precedence order regardless of input order', () => {
        const resolved = resolveToolGrantChain([
            layer('agent', { allow: ['git_commit'] }),
            layer('tenant', { allow: ['git_*'] }),
        ]);
        expect(resolved.matrix.allow).toEqual(['git_commit']);
        expect(resolved.chain.map((entry) => entry.scope)).toEqual(['default', 'tenant', 'agent']);
    });

    it('unions denies and keeps them permanent down the chain', () => {
        const resolved = resolveToolGrantChain([
            layer('organization', { deny: ['deploy_*'] }),
            // The Agent tries to allow exactly what the org denied.
            layer('agent', { allow: ['*'], deny: [] }),
        ]);
        expect(resolved.matrix.deny).toEqual(['deploy_*']);
        expect(
            decideToolGrant({ matrix: resolved.matrix, chain: resolved.chain }, 'deploy_work')
                .allowed,
        ).toBe(false);
    });

    it('treats a declared EMPTY allow as "this scope grants nothing"', () => {
        const resolved = resolveToolGrantChain([layer('work', { allow: [] })]);
        expect(resolved.matrix.allow).toEqual([]);
        expect(decideToolGrant({ matrix: resolved.matrix }, 'anything').allowed).toBe(false);
    });

    it('reports each layer’s contribution in the chain, least specific first', () => {
        const resolved = resolveToolGrantChain([
            layer('tenant', { allow: ['git_*', 'deploy_*'] }),
            layer('work', { deny: ['deploy_work'] }),
        ]);
        expect(resolved.chain).toEqual([
            { scope: 'default', id: null, allow: ['*'], deny: [], rejected: [] },
            {
                scope: 'tenant',
                id: 'tenant-1',
                allow: ['git_*', 'deploy_*'],
                deny: [],
                rejected: [],
            },
            { scope: 'work', id: 'work-1', allow: [], deny: ['deploy_work'], rejected: [] },
        ]);
    });
});

describe('SECURITY — a grant never widens scope upward', () => {
    it('drops an Agent grant its Work never granted, and reports the rejection', () => {
        const resolved = resolveToolGrantChain([
            layer('tenant', { allow: ['git_*', 'deploy_*'] }),
            layer('work', { allow: ['git_*'] }),
            // The Agent asks for a tool its Work does not grant.
            layer('agent', { allow: ['git_commit', 'deploy_work'] }),
        ]);

        expect(resolved.matrix.allow).toEqual(['git_commit']);
        const agentEntry = resolved.chain.find((entry) => entry.scope === 'agent');
        expect(agentEntry?.rejected).toEqual(['deploy_work']);

        const decision = decideToolGrant(
            { matrix: resolved.matrix, chain: resolved.chain },
            'deploy_work',
        );
        expect(decision.allowed).toBe(false);
        expect(decision.code).toBe('tool-not-granted');
    });

    it('an Agent asking for `*` cannot escape a narrower tenant', () => {
        const resolved = resolveToolGrantChain([
            layer('tenant', { allow: ['git_*'] }),
            layer('agent', { allow: ['*'] }),
        ]);
        // `*` is broader than `git_*`, so it is rejected outright rather
        // than silently promoting the Agent to everything.
        expect(resolved.matrix.allow).toEqual([]);
        expect(lastEntry(resolved.chain).rejected).toEqual(['*']);
        expect(decideToolGrant({ matrix: resolved.matrix }, 'git_commit').allowed).toBe(false);
    });

    it('an Agent cannot un-deny what an ancestor denied', () => {
        const resolved = resolveToolGrantChain([
            layer('organization', { deny: ['commitToRepo'] }),
            layer('work', { allow: ['*'] }),
            layer('agent', { allow: ['commitToRepo'] }),
        ]);
        const decision = decideToolGrant(
            { matrix: resolved.matrix, chain: resolved.chain },
            'commitToRepo',
        );
        expect(decision.allowed).toBe(false);
        expect(decision.code).toBe('tool-denied');
        expect(decision.source).toBe('organization');
    });

    it('a Work cannot widen past its organization either (the rule is not agent-specific)', () => {
        const resolved = resolveToolGrantChain([
            layer('organization', { allow: ['git_commit'] }),
            layer('work', { allow: ['git_*'] }),
        ]);
        expect(resolved.matrix.allow).toEqual([]);
        expect(lastEntry(resolved.chain).rejected).toEqual(['git_*']);
    });

    it('narrowAllowPatterns splits kept from rejected and dedupes', () => {
        expect(narrowAllowPatterns(['git_*'], ['git_commit', 'git_commit', 'deploy_x'])).toEqual({
            kept: ['git_commit'],
            rejected: ['deploy_x'],
        });
    });
});

describe('decideToolGrant', () => {
    const resolved = resolveToolGrantChain([
        layer('tenant', { allow: ['git_*', 'searchWeb'] }),
        layer('work', { deny: ['git_push'] }),
    ]);
    const ctx = { matrix: resolved.matrix, chain: resolved.chain };

    it('allows a granted tool and attributes it to the deciding scope', () => {
        const decision = decideToolGrant(ctx, 'git_commit');
        expect(decision.allowed).toBe(true);
        expect(decision.source).toBe('tenant');
    });

    it('deny beats allow', () => {
        const decision = decideToolGrant(ctx, 'git_push');
        expect(decision.allowed).toBe(false);
        expect(decision.code).toBe('tool-denied');
        expect(decision.source).toBe('work');
    });

    it('refuses an ungranted tool with an actionable reason', () => {
        const decision = decideToolGrant(ctx, 'deploy_work');
        expect(decision.allowed).toBe(false);
        expect(decision.code).toBe('tool-not-granted');
        expect(decision.reason).toContain('deploy_work');
        expect(decision.reason).toContain('git_*');
    });

    it('rejects an empty tool name rather than guessing', () => {
        expect(decideToolGrant(ctx, '   ').code).toBe('tool-name-invalid');
    });
});

describe('partitionToolsByGrant', () => {
    it('splits a tool list into granted and refused', () => {
        const resolved = resolveToolGrantChain([layer('tenant', { allow: ['git_*'] })]);
        const { granted, refused } = partitionToolsByGrant(resolved, ['git_commit', 'deploy_work']);
        expect(granted).toEqual(['git_commit']);
        expect(refused.map((decision) => decision.toolName)).toEqual(['deploy_work']);
    });
});
