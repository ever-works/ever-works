import type { MergeDecision } from '@ever-works/contracts';
import { GitFacadeService, MergePolicyRefusedError } from '../git.facade';
import type { MergePolicyEnforcer } from '../../policy/merge-policy.enforcer';

/**
 * Merge-policy matrix (Wave 3, D4) — enforcement at the ONE place a
 * pull request can actually be landed.
 *
 * The load-bearing assertions here are the negative ones: on a refusal
 * the provider plugin must never be called at all. A gate that merges
 * first and complains second is not a gate.
 */

const ALLOW: MergeDecision = { allowed: true, source: 'work' };
const REFUSE: MergeDecision = {
    allowed: false,
    code: 'agent-merge-disabled',
    reason: 'Agent merges are disabled by the effective merge policy (from work scope).',
    source: 'work',
};

function makeFacade(decision?: MergeDecision) {
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
    };
    const enforcer: MergePolicyEnforcer = {
        canAgentMerge: jest.fn().mockResolvedValue(decision ?? ALLOW),
    };
    const facade = new GitFacadeService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        enforcer,
    );
    // The token/plugin resolution path is exercised by git.facade.spec.ts;
    // here we stub it so the test is about the policy decision only.
    (
        facade as unknown as {
            resolvePluginAndToken: () => Promise<{ plugin: unknown; token: string }>;
        }
    ).resolvePluginAndToken = jest.fn().mockResolvedValue({ plugin, token: 'tok' });
    return { facade, plugin, enforcer };
}

const OPTIONS = { providerId: 'github', userId: 'user-1', workId: 'work-1' } as const;

describe('GitFacadeService.mergePullRequest — merge policy', () => {
    afterEach(() => {
        delete process.env.AGENT_MERGE_POLICY_ENFORCEMENT;
    });

    it('does NOT consult the policy for a human-driven merge (no agent actor)', async () => {
        const { facade, plugin, enforcer } = makeFacade();
        await facade.mergePullRequest('o', 'r', 7, { mergeMethod: 'squash' }, OPTIONS);
        expect(enforcer.canAgentMerge).not.toHaveBeenCalled();
        expect(plugin.mergePullRequest).toHaveBeenCalledTimes(1);
    });

    it('consults the policy for an agent-driven merge and proceeds when allowed', async () => {
        const { facade, plugin, enforcer } = makeFacade(ALLOW);
        const result = await facade.mergePullRequest(
            'o',
            'r',
            7,
            { mergeMethod: 'squash' },
            OPTIONS,
            {
                agentId: 'agent-1',
                gateStatus: 'green',
                humanApproved: true,
                targetBranch: 'feature/x',
            },
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
        const { facade, plugin } = makeFacade(REFUSE);
        await expect(
            facade.mergePullRequest('o', 'r', 7, undefined, OPTIONS, { agentId: 'agent-1' }),
        ).rejects.toMatchObject({
            name: 'MergePolicyRefusedError',
            message: REFUSE.reason,
        });
        expect(plugin.mergePullRequest).not.toHaveBeenCalled();
    });

    it('carries the refusal code + policy source on the thrown error (403 mapping input)', async () => {
        const { facade } = makeFacade(REFUSE);
        const error = await facade
            .mergePullRequest('o', 'r', 7, undefined, OPTIONS, { agentId: 'agent-1' })
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MergePolicyRefusedError);
        expect((error as MergePolicyRefusedError).code).toBe('agent-merge-disabled');
        expect((error as MergePolicyRefusedError).policySource).toBe('work');
    });

    it('looks the base branch up through the provider when the caller did not supply it', async () => {
        const { facade, plugin, enforcer } = makeFacade(ALLOW);
        await facade.mergePullRequest('o', 'r', 7, undefined, OPTIONS, { agentId: 'agent-1' });
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
            facade.mergePullRequest('o', 'r', 7, undefined, OPTIONS, { agentId: 'agent-1' }),
        ).rejects.toBeInstanceOf(MergePolicyRefusedError);
        expect(plugin.mergePullRequest).not.toHaveBeenCalled();
    });

    it('honours the operator kill-switch (AGENT_MERGE_POLICY_ENFORCEMENT=off)', async () => {
        process.env.AGENT_MERGE_POLICY_ENFORCEMENT = 'off';
        const { facade, plugin, enforcer } = makeFacade(REFUSE);
        await facade.mergePullRequest('o', 'r', 7, undefined, OPTIONS, { agentId: 'agent-1' });
        expect(enforcer.canAgentMerge).not.toHaveBeenCalled();
        expect(plugin.mergePullRequest).toHaveBeenCalledTimes(1);
    });
});
