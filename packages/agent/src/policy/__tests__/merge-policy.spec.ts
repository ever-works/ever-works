import { PLATFORM_DEFAULT_MERGE_POLICY, type MergePolicy } from '@ever-works/contracts';
import {
    evaluateAgentMerge,
    resolveMergePolicyChain,
    sanitizeMergePolicyOverride,
    type MergePolicyLayer,
} from '../merge-policy';

/**
 * Merge-policy matrix (Wave 3, founder decision D4) — the pure half.
 *
 * These tests are the executable statement of the founder's rule: the
 * platform must NEVER hardcode "agents do not merge". The default is
 * conservative, but every field is overridable at every scope, and the
 * merge is refused only for reasons a user can act on.
 */

const layer = (
    scope: MergePolicyLayer['scope'],
    policy: MergePolicyLayer['policy'],
): MergePolicyLayer => ({ scope, id: `${scope}-1`, policy });

describe('resolveMergePolicyChain — precedence', () => {
    it('returns the platform default when there are no layers at all', () => {
        const resolved = resolveMergePolicyChain([]);
        expect(resolved.policy).toEqual(PLATFORM_DEFAULT_MERGE_POLICY);
        expect(resolved.source).toBe('default');
    });

    it('returns the platform default when every scope stores null (NULL = inherit)', () => {
        const resolved = resolveMergePolicyChain([
            layer('tenant', null),
            layer('organization', null),
            layer('work', null),
            layer('agent', null),
        ]);
        expect(resolved.policy).toEqual(PLATFORM_DEFAULT_MERGE_POLICY);
        expect(resolved.source).toBe('default');
        // The chain still lists the scopes it walked — with no contributions.
        expect(resolved.chain.map((c) => c.scope)).toEqual([
            'default',
            'tenant',
            'organization',
            'work',
            'agent',
        ]);
    });

    it('tenant overrides the platform default', () => {
        const resolved = resolveMergePolicyChain([layer('tenant', { allowAgentMerge: true })]);
        expect(resolved.policy.allowAgentMerge).toBe(true);
        expect(resolved.source).toBe('tenant');
    });

    it('organization overrides tenant', () => {
        const resolved = resolveMergePolicyChain([
            layer('tenant', { allowAgentMerge: true }),
            layer('organization', { allowAgentMerge: false }),
        ]);
        expect(resolved.policy.allowAgentMerge).toBe(false);
        expect(resolved.source).toBe('organization');
    });

    it('Work overrides organization', () => {
        const resolved = resolveMergePolicyChain([
            layer('organization', { requireHumanApproval: true }),
            layer('work', { requireHumanApproval: false }),
        ]);
        expect(resolved.policy.requireHumanApproval).toBe(false);
        expect(resolved.source).toBe('work');
    });

    it('Agent overrides Work — the most specific scope wins', () => {
        const resolved = resolveMergePolicyChain([
            layer('work', { allowAgentMerge: false }),
            layer('agent', { allowAgentMerge: true }),
        ]);
        expect(resolved.policy.allowAgentMerge).toBe(true);
        expect(resolved.source).toBe('agent');
    });

    it('sorts layers into the documented precedence regardless of input order', () => {
        const resolved = resolveMergePolicyChain([
            layer('agent', { allowAgentMerge: true }),
            layer('tenant', { allowAgentMerge: false }),
            layer('work', { allowAgentMerge: false }),
        ]);
        // Agent still wins even though it was passed first.
        expect(resolved.policy.allowAgentMerge).toBe(true);
        expect(resolved.chain.map((c) => c.scope)).toEqual(['default', 'tenant', 'work', 'agent']);
    });
});

describe('resolveMergePolicyChain — field-level deep merge', () => {
    it('lets a Work override ONE field and inherit the other four', () => {
        const resolved = resolveMergePolicyChain([
            layer('tenant', {
                allowedMergeMethods: ['merge', 'squash'],
                protectedBranches: ['main'],
            }),
            layer('work', { allowAgentMerge: true }),
        ]);
        expect(resolved.policy).toEqual({
            allowAgentMerge: true, // from Work
            requireGreenGate: true, // platform default
            requireHumanApproval: true, // platform default
            allowedMergeMethods: ['merge', 'squash'], // from tenant
            protectedBranches: ['main'], // from tenant
        } satisfies MergePolicy);
    });

    it('reports which scope contributed which field in the chain', () => {
        const resolved = resolveMergePolicyChain([
            layer('tenant', { requireGreenGate: false }),
            layer('work', { allowAgentMerge: true }),
            layer('agent', { requireHumanApproval: false }),
        ]);
        const byScope = Object.fromEntries(resolved.chain.map((c) => [c.scope, c.fields]));
        expect(byScope.tenant).toEqual(['requireGreenGate']);
        expect(byScope.work).toEqual(['allowAgentMerge']);
        expect(byScope.agent).toEqual(['requireHumanApproval']);
        // The two fields nobody claimed still come from the platform default.
        expect(byScope.default).toEqual(['allowedMergeMethods', 'protectedBranches']);
    });

    it('marks a fully-shadowed layer as contributing nothing', () => {
        const resolved = resolveMergePolicyChain([
            layer('organization', { allowAgentMerge: false }),
            layer('agent', { allowAgentMerge: true }),
        ]);
        const org = resolved.chain.find((c) => c.scope === 'organization');
        expect(org?.fields).toEqual([]);
        expect(resolved.source).toBe('agent');
    });

    it('never mutates the frozen platform default', () => {
        const resolved = resolveMergePolicyChain([layer('work', { protectedBranches: ['trunk'] })]);
        resolved.policy.protectedBranches.push('sneaky');
        expect(PLATFORM_DEFAULT_MERGE_POLICY.protectedBranches).toEqual([
            'main',
            'master',
            'develop',
            'stage',
        ]);
    });
});

describe('sanitizeMergePolicyOverride', () => {
    it('drops non-boolean flags instead of coercing them', () => {
        const out = sanitizeMergePolicyOverride({
            allowAgentMerge: 'yes',
            requireGreenGate: 1,
        } as never);
        expect(out).toEqual({});
    });

    it('drops unknown merge methods but keeps the valid ones', () => {
        const out = sanitizeMergePolicyOverride({
            allowedMergeMethods: ['squash', 'fast-forward', 'rebase'],
        } as never);
        expect(out.allowedMergeMethods).toEqual(['squash', 'rebase']);
    });

    it('keeps an explicitly EMPTY list (it means "none allowed", not "inherit")', () => {
        expect(
            sanitizeMergePolicyOverride({ allowedMergeMethods: [] }).allowedMergeMethods,
        ).toEqual([]);
        expect(sanitizeMergePolicyOverride({ protectedBranches: [] }).protectedBranches).toEqual(
            [],
        );
    });

    it('trims, de-dupes and drops blank protected branches', () => {
        const out = sanitizeMergePolicyOverride({
            protectedBranches: ['  main ', 'main', '', '   ', 'release'],
        });
        expect(out.protectedBranches).toEqual(['main', 'release']);
    });
});

describe('evaluateAgentMerge — the single decision point', () => {
    /** Everything satisfied, so each test can flip exactly one thing. */
    const permissive: MergePolicy = {
        allowAgentMerge: true,
        requireGreenGate: true,
        requireHumanApproval: true,
        allowedMergeMethods: ['squash'],
        protectedBranches: ['main'],
    };
    const okCtx = {
        policy: permissive,
        gateStatus: 'green' as const,
        humanApproved: true,
        targetBranch: 'feature/x',
        mergeMethod: 'squash' as const,
    };

    it('allows when every condition is satisfied', () => {
        expect(evaluateAgentMerge(okCtx)).toEqual({ allowed: true, source: undefined });
    });

    it('refuses when allowAgentMerge is false (the platform default posture)', () => {
        const decision = evaluateAgentMerge({
            ...okCtx,
            policy: { ...permissive, allowAgentMerge: false },
            source: 'organization',
        });
        expect(decision.allowed).toBe(false);
        expect(decision.code).toBe('agent-merge-disabled');
        // The refusal names WHERE the policy came from, so the user knows
        // which scope to change.
        expect(decision.reason).toContain('organization');
        expect(decision.source).toBe('organization');
    });

    it('refuses a red gate when requireGreenGate is on', () => {
        const decision = evaluateAgentMerge({ ...okCtx, gateStatus: 'red' });
        expect(decision.allowed).toBe(false);
        expect(decision.code).toBe('gate-not-green');
        expect(decision.reason).toContain('red');
    });

    it('allows a red gate when requireGreenGate is configured off', () => {
        const decision = evaluateAgentMerge({
            ...okCtx,
            policy: { ...permissive, requireGreenGate: false },
            gateStatus: 'red',
        });
        expect(decision.allowed).toBe(true);
    });

    it('refuses a protected target branch, case-insensitively and through refs/heads/', () => {
        for (const target of ['main', 'MAIN', 'refs/heads/main']) {
            const decision = evaluateAgentMerge({ ...okCtx, targetBranch: target });
            expect(decision.allowed).toBe(false);
            expect(decision.code).toBe('protected-branch');
            expect(decision.reason).toContain('main');
        }
    });

    it('fails CLOSED when the target branch is unknown and branches are protected', () => {
        const decision = evaluateAgentMerge({ ...okCtx, targetBranch: null });
        expect(decision.allowed).toBe(false);
        expect(decision.code).toBe('target-branch-unknown');
    });

    it('allows an unknown target branch when the policy protects nothing', () => {
        const decision = evaluateAgentMerge({
            ...okCtx,
            policy: { ...permissive, protectedBranches: [] },
            targetBranch: null,
        });
        expect(decision.allowed).toBe(true);
    });

    // ── The protected-branch FLOOR (works-security lane 3a) ─────────────
    //
    // `main` / `master` / `develop` / `stage`: a scope may unprotect them, but
    // an agent merge into one needs a recorded human approval whatever
    // `requireHumanApproval` resolved to — so a Work-level policy that emptied
    // `protectedBranches` and dropped the approval cannot land an agent's pull
    // request on the default branch unattended.
    const unattended: MergePolicy = {
        ...permissive,
        requireHumanApproval: false,
        protectedBranches: [],
    };

    it.each([['main'], ['master'], ['develop'], ['stage'], ['refs/heads/Develop']])(
        'refuses an unattended merge into the floor branch %s even when nothing is protected',
        (target) => {
            const decision = evaluateAgentMerge({
                ...okCtx,
                policy: unattended,
                humanApproved: false,
                targetBranch: target,
            });
            expect(decision.allowed).toBe(false);
            expect(decision.code).toBe('human-approval-required');
            expect(decision.reason).toContain('protected-branch floor');
        },
    );

    it('refuses an unattended merge into an UNKNOWN target, since it may be a floor branch', () => {
        const decision = evaluateAgentMerge({
            ...okCtx,
            policy: unattended,
            humanApproved: false,
            targetBranch: null,
        });
        expect(decision.allowed).toBe(false);
        expect(decision.code).toBe('target-branch-unknown');
    });

    it('allows a floor branch the scope unprotected once a human approved the merge', () => {
        const decision = evaluateAgentMerge({
            ...okCtx,
            policy: unattended,
            humanApproved: true,
            targetBranch: 'main',
        });
        expect(decision.allowed).toBe(true);
    });

    it('lets a human-set tenant / organization waiver lift develop and stage, never main or master', () => {
        for (const target of ['develop', 'stage']) {
            expect(
                evaluateAgentMerge({
                    ...okCtx,
                    policy: unattended,
                    humanApproved: false,
                    humanScopeWaivesApproval: true,
                    targetBranch: target,
                }).allowed,
            ).toBe(true);
        }
        for (const target of ['main', 'master']) {
            const decision = evaluateAgentMerge({
                ...okCtx,
                policy: unattended,
                humanApproved: false,
                humanScopeWaivesApproval: true,
                targetBranch: target,
            });
            expect(decision.allowed).toBe(false);
            expect(decision.code).toBe('human-approval-required');
        }
    });

    it('leaves every other branch to the resolved policy (no approval needed)', () => {
        const decision = evaluateAgentMerge({
            ...okCtx,
            policy: unattended,
            humanApproved: false,
            targetBranch: 'feature/x',
        });
        expect(decision.allowed).toBe(true);
    });

    it('still refuses a floor branch the policy keeps protected, approval or not', () => {
        const decision = evaluateAgentMerge({
            ...okCtx,
            policy: { ...permissive, protectedBranches: ['develop'] },
            humanApproved: true,
            targetBranch: 'develop',
        });
        expect(decision.code).toBe('protected-branch');
    });

    it('refuses a merge method the policy does not allow', () => {
        const decision = evaluateAgentMerge({ ...okCtx, mergeMethod: 'rebase' });
        expect(decision.allowed).toBe(false);
        expect(decision.code).toBe('merge-method-not-allowed');
        expect(decision.reason).toContain('rebase');
        expect(decision.reason).toContain('squash');
    });

    it('evaluates an unspecified method as the provider default (merge), never as a bypass', () => {
        const decision = evaluateAgentMerge({ ...okCtx, mergeMethod: null });
        expect(decision.allowed).toBe(false);
        expect(decision.code).toBe('merge-method-not-allowed');
        expect(decision.reason).toContain("'merge'");
    });

    it('refuses when human approval is required and absent', () => {
        const decision = evaluateAgentMerge({ ...okCtx, humanApproved: false });
        expect(decision.allowed).toBe(false);
        expect(decision.code).toBe('human-approval-required');
    });

    it('allows without approval once the policy stops requiring it', () => {
        const decision = evaluateAgentMerge({
            ...okCtx,
            policy: { ...permissive, requireHumanApproval: false },
            humanApproved: false,
        });
        expect(decision.allowed).toBe(true);
    });

    it('refuses everything when the policy allows no merge method at all', () => {
        const decision = evaluateAgentMerge({
            ...okCtx,
            policy: { ...permissive, allowedMergeMethods: [] },
        });
        expect(decision.allowed).toBe(false);
        expect(decision.code).toBe('merge-method-not-allowed');
        expect(decision.reason).toContain('none');
    });

    it('resolves + decides end-to-end: an org that opts agents into merging green work', () => {
        const resolved = resolveMergePolicyChain([
            layer('organization', {
                allowAgentMerge: true,
                requireHumanApproval: false,
            }),
            layer('work', { allowedMergeMethods: ['squash', 'rebase'] }),
        ]);
        const decision = evaluateAgentMerge({
            policy: resolved.policy,
            source: resolved.source,
            gateStatus: 'green',
            humanApproved: false,
            targetBranch: 'feature/agent-work',
            mergeMethod: 'rebase',
        });
        expect(decision.allowed).toBe(true);
        // …and the same setup still refuses a merge into a protected branch.
        expect(
            evaluateAgentMerge({
                policy: resolved.policy,
                gateStatus: 'green',
                humanApproved: false,
                targetBranch: 'develop',
                mergeMethod: 'rebase',
            }).code,
        ).toBe('protected-branch');
    });
});

describe('resolveMergePolicyChain — the human-scope floor waiver (works-security lane 3a)', () => {
    const off = { requireHumanApproval: false };
    const on = { requireHumanApproval: true };

    it('is set when a tenant or organization policy turned approval off and nothing re-enabled it', () => {
        expect(
            resolveMergePolicyChain([{ scope: 'tenant', id: 't', policy: off }])
                .humanScopeWaivesApproval,
        ).toBe(true);
        expect(
            resolveMergePolicyChain([{ scope: 'organization', id: 'o', policy: off }])
                .humanScopeWaivesApproval,
        ).toBe(true);
    });

    it('is never set by a Work- or Agent-level loosening (the scopes a machine could write)', () => {
        for (const scope of ['work', 'agent'] as const) {
            const resolved = resolveMergePolicyChain([{ scope, id: 'x', policy: off }]);
            expect(resolved.policy.requireHumanApproval).toBe(false);
            expect(resolved.humanScopeWaivesApproval).toBe(false);
        }
    });

    it('follows the most specific human scope that declares it, and needs the effective policy to agree', () => {
        // Organization re-enables what the tenant turned off.
        expect(
            resolveMergePolicyChain([
                { scope: 'tenant', id: 't', policy: off },
                { scope: 'organization', id: 'o', policy: on },
                { scope: 'work', id: 'w', policy: off },
            ]).humanScopeWaivesApproval,
        ).toBe(false);
        // A Work re-enables approval: the effective policy wants one anyway.
        expect(
            resolveMergePolicyChain([
                { scope: 'organization', id: 'o', policy: off },
                { scope: 'work', id: 'w', policy: on },
            ]).humanScopeWaivesApproval,
        ).toBe(false);
        // Silent chain: the platform default requires approval.
        expect(resolveMergePolicyChain([]).humanScopeWaivesApproval).toBe(false);
    });
});
