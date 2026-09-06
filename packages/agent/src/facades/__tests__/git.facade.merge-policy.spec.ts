import type { MergeDecision, MergePolicy, ResolvedMergePolicy } from '@ever-works/contracts';
import { GitFacadeService, MergePolicyRefusedError } from '../git.facade';
import type { MergePolicyEnforcer } from '../../policy/merge-policy.enforcer';
import type { MergeApprovalVerdict, MergeApprovalVerifier } from '../../policy/merge-approval.port';

/**
 * Merge-policy matrix (Wave 3, D4) + merge approval (self-build slice AE,
 * EW-805) — enforcement at the ONE place a pull request can actually be
 * landed.
 *
 * The load-bearing assertions here are the negative ones: on a refusal
 * the provider plugin must never be called at all. A gate that merges
 * first and complains second is not a gate.
 *
 * These specs drive the REAL `assertAgentMayMerge` through the public
 * `mergePullRequest` entry point. Only the plugin/token resolution is
 * stubbed (it has its own spec) — the policy, the approval verifier and
 * the live provider read are all exercised for real.
 */

const ALLOW: MergeDecision = { allowed: true, source: 'work' };
const REFUSE: MergeDecision = {
    allowed: false,
    code: 'agent-merge-disabled',
    reason: 'Agent merges are disabled by the effective merge policy (from work scope).',
    source: 'work',
};

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER_HEAD = 'ffffffffffffffffffffffffffffffffffffffff';

const NEEDS_APPROVAL: MergePolicy = {
    allowAgentMerge: true,
    requireGreenGate: true,
    requireHumanApproval: true,
    allowedMergeMethods: ['squash'],
    protectedBranches: ['main'],
};

const NO_APPROVAL_NEEDED: MergePolicy = { ...NEEDS_APPROVAL, requireHumanApproval: false };

function resolution(policy: MergePolicy): ResolvedMergePolicy {
    return { policy, source: 'work', chain: [] };
}

const APPROVED: MergeApprovalVerdict = {
    approved: true,
    approvalId: 'proposal-1',
    approvedById: 'human-1',
    approvedAt: new Date(),
};

interface FacadeOpts {
    decision?: MergeDecision;
    policy?: MergePolicy;
    verdict?: MergeApprovalVerdict;
    /** Omit to bind no verifier at all (fail-closed path). */
    bindVerifier?: boolean;
    status?: {
        state: 'open' | 'draft' | 'closed' | 'merged';
        ciState: 'passing' | 'failing' | 'pending' | 'unknown';
        headSha: string | null;
        /** Omitted = "not reported", which is not a warning. */
        checksComplete?: boolean;
    } | null;
    /** Omit `resolve` from the enforcer (a minimal legacy double). */
    resolvable?: boolean;
}

function makeFacade(opts: FacadeOpts = {}) {
    const status =
        opts.status === undefined
            ? { state: 'open' as const, ciState: 'passing' as const, headSha: HEAD }
            : opts.status;
    const plugin = {
        id: 'github',
        state: 'loaded',
        mergePullRequest: jest.fn().mockResolvedValue({ merged: true, sha: 'deadbeef' }),
        getPullRequest: jest.fn().mockResolvedValue({
            number: 7,
            base: 'main',
            head: 'task/x',
            state: 'open',
            title: 't',
            url: 'u',
            createdAt: '',
            updatedAt: '',
        }),
        getPullRequestStatus: jest
            .fn()
            .mockResolvedValue(status ? { number: 7, merged: false, checks: [], ...status } : null),
    };
    const enforcer: MergePolicyEnforcer = {
        canAgentMerge: jest.fn().mockResolvedValue(opts.decision ?? ALLOW),
    };
    if (opts.resolvable !== false) {
        enforcer.resolve = jest.fn().mockResolvedValue(resolution(opts.policy ?? NEEDS_APPROVAL));
    }
    const verifier: MergeApprovalVerifier = {
        verifyMergeApproval: jest.fn().mockResolvedValue(opts.verdict ?? APPROVED),
    };
    const facade = new GitFacadeService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        enforcer,
        opts.bindVerifier === false ? undefined : verifier,
    );
    // The token/plugin resolution path is exercised by git.facade.spec.ts;
    // here we stub it so the test is about the policy decision only.
    (
        facade as unknown as {
            resolvePluginAndToken: () => Promise<{ plugin: unknown; token: string }>;
        }
    ).resolvePluginAndToken = jest.fn().mockResolvedValue({ plugin, token: 'tok' });
    return { facade, plugin, enforcer, verifier };
}

const OPTIONS = { providerId: 'github', userId: 'user-1', workId: 'work-1' } as const;
const ACTOR = { agentId: 'agent-1', taskId: 'task-1', targetBranch: 'feature/x' } as const;

describe('GitFacadeService.mergePullRequest — merge policy', () => {
    afterEach(() => {
        delete process.env.AGENT_MERGE_POLICY_ENFORCEMENT;
    });

    // CONTRACT REVERSAL (merge approval, slice AE). This file used to
    // assert "does NOT consult the policy for a human-driven merge (no
    // agent actor)" — i.e. omitting the sixth argument merged with no
    // policy at all. That test encoded a real hole rather than a real
    // requirement: the gate was opt-in, and any future caller that forgot
    // the argument would silently merge unchecked, with the compiler
    // saying nothing. `agentActor` is now REQUIRED, there was exactly one
    // production caller and it always passed one, so nothing that worked
    // stopped working. The replacement assertion is that the gate cannot
    // be skipped.
    it('runs the gate for EVERY caller — the actor is not optional any more', async () => {
        const { facade, plugin, enforcer } = makeFacade();
        await facade.mergePullRequest('o', 'r', 7, { mergeMethod: 'squash' }, OPTIONS, ACTOR);
        expect(enforcer.canAgentMerge).toHaveBeenCalledTimes(1);
        expect(plugin.mergePullRequest).toHaveBeenCalledTimes(1);
    });

    it('consults the policy for an agent-driven merge and proceeds when allowed', async () => {
        const { facade, plugin, enforcer } = makeFacade({ decision: ALLOW });
        const result = await facade.mergePullRequest(
            'o',
            'r',
            7,
            { mergeMethod: 'squash' },
            OPTIONS,
            { ...ACTOR, gateStatus: 'green' },
        );
        expect(enforcer.canAgentMerge).toHaveBeenCalledWith(
            expect.objectContaining({
                agentId: 'agent-1',
                workId: 'work-1',
                gateStatus: 'green',
                humanApproved: true,
                targetBranch: 'feature/x',
                mergeMethod: 'squash',
            }),
        );
        expect(plugin.mergePullRequest).toHaveBeenCalledTimes(1);
        expect(result.merged).toBe(true);
    });

    it('REFUSES with the policy reason and never calls the provider', async () => {
        const { facade, plugin } = makeFacade({ decision: REFUSE });
        await expect(
            facade.mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR),
        ).rejects.toMatchObject({
            name: 'MergePolicyRefusedError',
            message: REFUSE.reason,
        });
        expect(plugin.mergePullRequest).not.toHaveBeenCalled();
    });

    it('carries the refusal code + policy source on the thrown error (403 mapping input)', async () => {
        const { facade } = makeFacade({ decision: REFUSE });
        const error = await facade
            .mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR)
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MergePolicyRefusedError);
        expect((error as MergePolicyRefusedError).code).toBe('agent-merge-disabled');
        expect((error as MergePolicyRefusedError).policySource).toBe('work');
    });

    it('looks the base branch up through the provider when the caller did not supply it', async () => {
        const { facade, plugin, enforcer } = makeFacade({ decision: ALLOW });
        await facade.mergePullRequest('o', 'r', 7, undefined, OPTIONS, {
            agentId: 'agent-1',
            taskId: 'task-1',
        });
        expect(plugin.getPullRequest).toHaveBeenCalledWith('o', 'r', 7, 'tok');
        expect(enforcer.canAgentMerge).toHaveBeenCalledWith(
            expect.objectContaining({ targetBranch: 'main' }),
        );
    });

    it('fails CLOSED when the enforcer is not bound at all', async () => {
        const facade = new GitFacadeService(
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
        );
        const plugin = { mergePullRequest: jest.fn() };
        (
            facade as unknown as {
                resolvePluginAndToken: () => Promise<{ plugin: unknown; token: string }>;
            }
        ).resolvePluginAndToken = jest.fn().mockResolvedValue({ plugin, token: 'tok' });

        await expect(
            facade.mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR),
        ).rejects.toBeInstanceOf(MergePolicyRefusedError);
        expect(plugin.mergePullRequest).not.toHaveBeenCalled();
    });

    // CONTRACT REVERSAL (merge approval, slice AE). This used to assert
    // that `AGENT_MERGE_POLICY_ENFORCEMENT=off` skipped EVERYTHING and
    // merged. It now skips the branch / method / gate MATRIX only — the
    // approval requirement still applies. The old contract made one
    // environment variable the difference between a merge a human
    // authorised and one nobody did, which is the exact failure this
    // slice exists to prevent; and it waives nothing real, because before
    // this slice the approval could never be satisfied anyway.
    //
    // An operator who wants agents to land green work unattended sets
    // `requireHumanApproval: false` on the merge policy — scoped,
    // auditable, and visible in the resolved-policy UI.
    it('kill-switch skips the policy MATRIX but still requires the approval', async () => {
        process.env.AGENT_MERGE_POLICY_ENFORCEMENT = 'off';
        const { facade, plugin, enforcer } = makeFacade({ decision: REFUSE });
        await facade.mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR);
        expect(enforcer.canAgentMerge).not.toHaveBeenCalled();
        expect(plugin.mergePullRequest).toHaveBeenCalledTimes(1);
    });

    it('kill-switch does NOT waive a missing approval', async () => {
        process.env.AGENT_MERGE_POLICY_ENFORCEMENT = 'off';
        const { facade, plugin } = makeFacade({
            verdict: {
                approved: false,
                code: 'approval-missing',
                reason: 'No human approval is on record.',
            },
        });
        await expect(
            facade.mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR),
        ).rejects.toMatchObject({ code: 'approval-missing' });
        expect(plugin.mergePullRequest).not.toHaveBeenCalled();
    });
});

describe('GitFacadeService.mergePullRequest — merge approval gate (slice AE)', () => {
    afterEach(() => {
        delete process.env.AGENT_MERGE_POLICY_ENFORCEMENT;
    });

    it('verifies the approval against the LIVE head, not against anything the caller said', async () => {
        const { facade, verifier, plugin } = makeFacade();
        await facade.mergePullRequest('o', 'r', 7, { mergeMethod: 'squash' }, OPTIONS, ACTOR);
        expect(verifier.verifyMergeApproval).toHaveBeenCalledWith({
            taskId: 'task-1',
            prNumber: 7,
            headSha: HEAD,
        });
        expect(plugin.getPullRequestStatus).toHaveBeenCalledWith('o', 'r', 7, 'tok');
    });

    it('PINS the merge to the head it verified', async () => {
        const { facade, plugin } = makeFacade();
        await facade.mergePullRequest('o', 'r', 7, { mergeMethod: 'squash' }, OPTIONS, ACTOR);
        expect(plugin.mergePullRequest).toHaveBeenCalledWith(
            'o',
            'r',
            7,
            { mergeMethod: 'squash', expectedHeadSha: HEAD },
            'tok',
        );
    });

    it('reports humanApproved:false to the matrix when it verified nothing', async () => {
        // The resolve-only read said "no approval needed", so none was
        // verified. `canAgentMerge` resolves the policy a SECOND time; if
        // an operator flipped `requireHumanApproval` on in between,
        // claiming approval here would merge under the policy that was in
        // force a millisecond ago. Reporting what was actually verified
        // makes that race refuse.
        const { facade, enforcer } = makeFacade({ policy: NO_APPROVAL_NEEDED });
        await facade.mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR);
        expect(enforcer.canAgentMerge).toHaveBeenCalledWith(
            expect.objectContaining({ humanApproved: false }),
        );
    });

    it('refuses when the policy gains an approval requirement between the two reads', async () => {
        const { facade, plugin, enforcer } = makeFacade({
            policy: NO_APPROVAL_NEEDED,
            decision: {
                allowed: false,
                code: 'human-approval-required',
                reason: 'The effective merge policy requires a human approval before an agent may merge.',
                source: 'work',
            },
        });
        await expect(
            facade.mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR),
        ).rejects.toMatchObject({ code: 'human-approval-required' });
        expect(enforcer.canAgentMerge).toHaveBeenCalledWith(
            expect.objectContaining({ humanApproved: false }),
        );
        expect(plugin.mergePullRequest).not.toHaveBeenCalled();
    });

    it('pins the head even when the policy requires NO approval', async () => {
        const { facade, plugin, verifier } = makeFacade({ policy: NO_APPROVAL_NEEDED });
        await facade.mergePullRequest('o', 'r', 7, { mergeMethod: 'squash' }, OPTIONS, ACTOR);
        expect(verifier.verifyMergeApproval).not.toHaveBeenCalled();
        expect(plugin.mergePullRequest).toHaveBeenCalledWith(
            'o',
            'r',
            7,
            { mergeMethod: 'squash', expectedHeadSha: HEAD },
            'tok',
        );
    });

    // CONTRACT EXTENSION (AE review). The live read, the "is it open?"
    // check and the "is it green?" check used to sit INSIDE the
    // `requiresApproval` branch, so an operator with
    // `requireHumanApproval: false` got a facade that merged whatever was
    // there — no state check, no CI check — while
    // `TaskMergeGateService`, on the identical policy, waited for green.
    // They opted out of a human, not out of CI. Both policies now take the
    // same two checks; only the approval lookup is skipped.
    describe('state + CI apply to EVERY policy, not just approval-required ones', () => {
        it.each([
            ['closed', 'pull-request-not-open'],
            ['draft', 'pull-request-not-open'],
            ['merged', 'pull-request-not-open'],
        ] as const)('refuses a %s pull request with no approval required', async (state, code) => {
            const { facade, plugin } = makeFacade({
                policy: NO_APPROVAL_NEEDED,
                status: { state, ciState: 'passing', headSha: HEAD },
            });
            await expect(
                facade.mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR),
            ).rejects.toMatchObject({ code });
            expect(plugin.mergePullRequest).not.toHaveBeenCalled();
        });

        it.each(['failing', 'pending', 'unknown'] as const)(
            'refuses %s CI with no approval required',
            async (ciState) => {
                // `unknown` is the state a pull request is in seconds after
                // it is opened — which is exactly when the old code path
                // reached here — so this is the case that used to merge
                // before a single check had started.
                const { facade, plugin } = makeFacade({
                    policy: NO_APPROVAL_NEEDED,
                    status: { state: 'open', ciState, headSha: HEAD },
                });
                await expect(
                    facade.mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR),
                ).rejects.toMatchObject({ code: 'pull-request-not-green' });
                expect(plugin.mergePullRequest).not.toHaveBeenCalled();
            },
        );

        it('refuses an unreadable pull request with no approval required', async () => {
            const { facade, plugin } = makeFacade({ policy: NO_APPROVAL_NEEDED, status: null });
            await expect(
                facade.mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR),
            ).rejects.toMatchObject({ code: 'head-sha-unknown' });
            expect(plugin.mergePullRequest).not.toHaveBeenCalled();
        });
    });

    // An INCOMPLETE check read is not green. `ciState` is documented as
    // the roll-up for the whole head commit while `checks` is a bounded
    // display sample; a provider that says it could not read the full set
    // is handing back a verdict over a SUBSET, and a failure may sit in
    // the part nobody read. Authorising a merge on a sample is the same
    // defect as authorising one on a truncated list.
    describe('checksComplete', () => {
        it.each([true, false] as const)(
            'requires an approval regardless — completeness is %s',
            async (checksComplete) => {
                const { facade } = makeFacade({
                    status: { state: 'open', ciState: 'passing', headSha: HEAD, checksComplete },
                    verdict: { approved: false, code: 'approval-missing', reason: 'none' },
                });
                await expect(
                    facade.mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR),
                ).rejects.toBeInstanceOf(MergePolicyRefusedError);
            },
        );

        it('refuses a "passing" verdict the provider says it could not read in full', async () => {
            const { facade, plugin, verifier } = makeFacade({
                status: { state: 'open', ciState: 'passing', headSha: HEAD, checksComplete: false },
            });
            const error = await facade
                .mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR)
                .catch((e: unknown) => e);
            expect((error as MergePolicyRefusedError).code).toBe('pull-request-not-green');
            expect((error as MergePolicyRefusedError).message).toContain(
                'could not be read in full',
            );
            // It never even asks whether somebody approved: there is
            // nothing an approval could be an approval OF.
            expect(verifier.verifyMergeApproval).not.toHaveBeenCalled();
            expect(plugin.mergePullRequest).not.toHaveBeenCalled();
        });

        it('refuses it with no approval required, too', async () => {
            const { facade, plugin } = makeFacade({
                policy: NO_APPROVAL_NEEDED,
                status: { state: 'open', ciState: 'passing', headSha: HEAD, checksComplete: false },
            });
            await expect(
                facade.mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR),
            ).rejects.toMatchObject({ code: 'pull-request-not-green' });
            expect(plugin.mergePullRequest).not.toHaveBeenCalled();
        });

        it('merges when the provider explicitly says the read WAS complete', async () => {
            const { facade, plugin } = makeFacade({
                status: { state: 'open', ciState: 'passing', headSha: HEAD, checksComplete: true },
            });
            await facade.mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR);
            expect(plugin.mergePullRequest).toHaveBeenCalled();
        });
    });

    it('normalises a shouted head SHA before pinning and verifying', async () => {
        const { facade, plugin, verifier } = makeFacade({
            status: { state: 'open', ciState: 'passing', headSha: HEAD.toUpperCase() },
        });
        await facade.mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR);
        expect(verifier.verifyMergeApproval).toHaveBeenCalledWith(
            expect.objectContaining({ headSha: HEAD }),
        );
        expect(plugin.mergePullRequest.mock.calls[0][3]).toEqual({ expectedHeadSha: HEAD });
    });

    it.each([
        ['approval-missing', 'Nobody approved this.'],
        ['approval-stale', 'Approved at an earlier commit.'],
        ['approval-expired', 'That approval is 40h old.'],
        ['approval-not-human', 'A guardrail decided it.'],
        ['approver-not-entitled', 'Not a member of that Tenant.'],
    ] as const)('refuses with %s and never calls the provider', async (code, reason) => {
        const { facade, plugin } = makeFacade({ verdict: { approved: false, code, reason } });
        const error = await facade
            .mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR)
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MergePolicyRefusedError);
        expect((error as MergePolicyRefusedError).code).toBe(code);
        expect((error as MergePolicyRefusedError).message).toContain(reason);
        expect(plugin.mergePullRequest).not.toHaveBeenCalled();
    });

    it('refuses when green at approval time is not green at MERGE time', async () => {
        const { facade, plugin, verifier } = makeFacade({
            status: { state: 'open', ciState: 'failing', headSha: HEAD },
        });
        const error = await facade
            .mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR)
            .catch((e: unknown) => e);
        expect((error as MergePolicyRefusedError).code).toBe('pull-request-not-green');
        // The approval is not even consulted — a red pull request cannot
        // be merged whatever anyone approved.
        expect(verifier.verifyMergeApproval).not.toHaveBeenCalled();
        expect(plugin.mergePullRequest).not.toHaveBeenCalled();
    });

    it.each(['pending', 'unknown'] as const)(
        'treats a %s CI verdict as not-green (fail closed)',
        async (ciState) => {
            const { facade, plugin } = makeFacade({
                status: { state: 'open', ciState, headSha: HEAD },
            });
            const error = await facade
                .mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR)
                .catch((e: unknown) => e);
            expect((error as MergePolicyRefusedError).code).toBe('pull-request-not-green');
            expect(plugin.mergePullRequest).not.toHaveBeenCalled();
        },
    );

    it.each(['draft', 'closed', 'merged'] as const)('refuses a %s pull request', async (state) => {
        const { facade, plugin } = makeFacade({
            status: { state, ciState: 'passing', headSha: HEAD },
        });
        const error = await facade
            .mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR)
            .catch((e: unknown) => e);
        expect((error as MergePolicyRefusedError).code).toBe('pull-request-not-open');
        expect(plugin.mergePullRequest).not.toHaveBeenCalled();
    });

    it('refuses when the provider cannot be read at all', async () => {
        const { facade, plugin } = makeFacade({ status: null });
        const error = await facade
            .mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR)
            .catch((e: unknown) => e);
        expect((error as MergePolicyRefusedError).code).toBe('head-sha-unknown');
        expect(plugin.mergePullRequest).not.toHaveBeenCalled();
    });

    it('refuses when the provider reports no head commit', async () => {
        const { facade, plugin } = makeFacade({
            status: { state: 'open', ciState: 'passing', headSha: null },
        });
        const error = await facade
            .mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR)
            .catch((e: unknown) => e);
        expect((error as MergePolicyRefusedError).code).toBe('head-sha-unknown');
        expect(plugin.mergePullRequest).not.toHaveBeenCalled();
    });

    it('refuses when no approval VERIFIER is bound — unbound is not "approved"', async () => {
        const { facade, plugin } = makeFacade({ bindVerifier: false });
        const error = await facade
            .mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR)
            .catch((e: unknown) => e);
        expect((error as MergePolicyRefusedError).code).toBe('approval-missing');
        expect(plugin.mergePullRequest).not.toHaveBeenCalled();
    });

    it('treats a THROWN verifier as a refusal, never as an approval', async () => {
        const { facade, plugin, verifier } = makeFacade();
        (verifier.verifyMergeApproval as jest.Mock).mockRejectedValue(new Error('db down'));
        const error = await facade
            .mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR)
            .catch((e: unknown) => e);
        expect((error as MergePolicyRefusedError).code).toBe('approval-missing');
        expect(plugin.mergePullRequest).not.toHaveBeenCalled();
    });

    it('refuses a merge that names no Task — an approval must be bound to something', async () => {
        const { facade, plugin, verifier } = makeFacade({
            verdict: {
                approved: false,
                code: 'approval-missing',
                reason: 'This merge is not attached to a Task.',
            },
        });
        await expect(
            facade.mergePullRequest('o', 'r', 7, undefined, OPTIONS, { agentId: 'agent-1' }),
        ).rejects.toBeInstanceOf(MergePolicyRefusedError);
        expect(verifier.verifyMergeApproval).toHaveBeenCalledWith(
            expect.objectContaining({ taskId: '' }),
        );
        expect(plugin.mergePullRequest).not.toHaveBeenCalled();
    });

    it('assumes an approval is required when the enforcer cannot resolve a policy', async () => {
        // A minimal enforcer (no `resolve`) is the fail-closed reading:
        // an unevaluated policy is never a satisfied policy.
        const { facade, verifier } = makeFacade({ resolvable: false });
        await facade.mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR);
        expect(verifier.verifyMergeApproval).toHaveBeenCalledTimes(1);
    });

    it('assumes an approval is required when the policy READ throws', async () => {
        const { facade, enforcer, verifier } = makeFacade();
        (enforcer.resolve as jest.Mock).mockRejectedValue(new Error('db down'));
        await facade.mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR);
        expect(verifier.verifyMergeApproval).toHaveBeenCalledTimes(1);
    });

    it('a head that moved between approval and merge produces a different lookup', async () => {
        // The verifier is asked about the head the provider reports NOW.
        // The stale-approval refusal itself lives in MergeApprovalService;
        // what this pins is that the facade never asks about a remembered
        // head.
        const { facade, verifier } = makeFacade({
            status: { state: 'open', ciState: 'passing', headSha: OTHER_HEAD },
        });
        await facade.mergePullRequest('o', 'r', 7, undefined, OPTIONS, ACTOR);
        expect(verifier.verifyMergeApproval).toHaveBeenCalledWith(
            expect.objectContaining({ headSha: OTHER_HEAD }),
        );
    });
});
