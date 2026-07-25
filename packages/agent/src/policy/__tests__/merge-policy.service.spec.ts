import { PLATFORM_DEFAULT_MERGE_POLICY } from '@ever-works/contracts';
import { MergePolicyService } from '../merge-policy.service';
import type { MergePolicyScopeRepository, MergePolicyScopeRow } from '../merge-policy.repository';

/**
 * Merge-policy matrix (Wave 3, D4) — the I/O half: scope discovery,
 * the chain it hands the pure resolver, and the fail-safe posture.
 */

interface Fixture {
    agents?: Record<string, MergePolicyScopeRow>;
    works?: Record<string, MergePolicyScopeRow>;
    organizations?: Record<string, MergePolicyScopeRow>;
    tenants?: Record<string, MergePolicyScopeRow>;
}

function makeService(fixture: Fixture): {
    service: MergePolicyService;
    repo: jest.Mocked<MergePolicyScopeRepository>;
} {
    const repo = {
        findAgent: jest.fn(async (id: string) => fixture.agents?.[id] ?? null),
        findWork: jest.fn(async (id: string) => fixture.works?.[id] ?? null),
        findOrganization: jest.fn(async (id: string) => fixture.organizations?.[id] ?? null),
        findTenant: jest.fn(async (id: string) => fixture.tenants?.[id] ?? null),
    } as unknown as jest.Mocked<MergePolicyScopeRepository>;
    return { service: new MergePolicyService(repo), repo };
}

describe('MergePolicyService.resolve', () => {
    it('discovers Work, organization and tenant from the Agent row', async () => {
        const { service, repo } = makeService({
            agents: {
                'agent-1': {
                    id: 'agent-1',
                    mergePolicy: { requireHumanApproval: false },
                    workId: 'work-1',
                    organizationId: null,
                    tenantId: null,
                },
            },
            works: {
                'work-1': {
                    id: 'work-1',
                    mergePolicy: { allowAgentMerge: true },
                    organizationId: 'org-1',
                    tenantId: null,
                },
            },
            organizations: {
                'org-1': {
                    id: 'org-1',
                    mergePolicy: { allowedMergeMethods: ['merge'] },
                    tenantId: 'tenant-1',
                },
            },
            tenants: {
                'tenant-1': { id: 'tenant-1', mergePolicy: { protectedBranches: ['trunk'] } },
            },
        });

        const resolved = await service.resolve({ agentId: 'agent-1' });

        expect(resolved.policy).toEqual({
            allowAgentMerge: true,
            requireGreenGate: true,
            requireHumanApproval: false,
            allowedMergeMethods: ['merge'],
            protectedBranches: ['trunk'],
        });
        expect(resolved.source).toBe('agent');
        expect(resolved.chain.map((c) => c.scope)).toEqual([
            'default',
            'tenant',
            'organization',
            'work',
            'agent',
        ]);
        expect(repo.findTenant).toHaveBeenCalledWith('tenant-1');
    });

    it('lets an explicit id win over the one discovered from the Agent row', async () => {
        const { service, repo } = makeService({
            agents: {
                'agent-1': { id: 'agent-1', mergePolicy: null, workId: 'work-own' },
            },
            works: {
                'work-other': { id: 'work-other', mergePolicy: { allowAgentMerge: true } },
            },
        });

        const resolved = await service.resolve({ agentId: 'agent-1', workId: 'work-other' });

        expect(repo.findWork).toHaveBeenCalledWith('work-other');
        expect(repo.findWork).not.toHaveBeenCalledWith('work-own');
        expect(resolved.policy.allowAgentMerge).toBe(true);
        expect(resolved.source).toBe('work');
    });

    it('resolves to the platform default when nothing in the chain declares anything', async () => {
        const { service } = makeService({
            works: { 'work-1': { id: 'work-1', mergePolicy: null } },
        });
        const resolved = await service.resolve({ workId: 'work-1' });
        expect(resolved.policy).toEqual(PLATFORM_DEFAULT_MERGE_POLICY);
        expect(resolved.source).toBe('default');
    });

    it('skips scopes whose row no longer exists instead of throwing', async () => {
        const { service } = makeService({});
        const resolved = await service.resolve({ agentId: 'ghost', workId: 'ghost' });
        expect(resolved.policy).toEqual(PLATFORM_DEFAULT_MERGE_POLICY);
        expect(resolved.chain.map((c) => c.scope)).toEqual(['default']);
    });

    it('falls back to the platform default (never to a permissive policy) when a lookup throws', async () => {
        const repo = {
            findAgent: jest.fn().mockRejectedValue(new Error('db down')),
            findWork: jest.fn(),
            findOrganization: jest.fn(),
            findTenant: jest.fn(),
        } as unknown as jest.Mocked<MergePolicyScopeRepository>;
        const service = new MergePolicyService(repo);

        const resolved = await service.resolve({ agentId: 'agent-1' });

        expect(resolved.policy).toEqual(PLATFORM_DEFAULT_MERGE_POLICY);
        expect(resolved.policy.allowAgentMerge).toBe(false);
        expect(resolved.source).toBe('default');
    });
});

describe('MergePolicyService.canAgentMerge', () => {
    it('refuses under the platform default and names the reason', async () => {
        const { service } = makeService({
            works: { 'work-1': { id: 'work-1', mergePolicy: null } },
        });
        const decision = await service.canAgentMerge({
            workId: 'work-1',
            gateStatus: 'green',
            humanApproved: true,
            targetBranch: 'feature/x',
            mergeMethod: 'squash',
        });
        expect(decision.allowed).toBe(false);
        expect(decision.code).toBe('agent-merge-disabled');
    });

    it('allows once a scope opts in and every condition is met', async () => {
        const { service } = makeService({
            works: {
                'work-1': {
                    id: 'work-1',
                    mergePolicy: { allowAgentMerge: true, requireHumanApproval: false },
                },
            },
        });
        const decision = await service.canAgentMerge({
            workId: 'work-1',
            gateStatus: 'green',
            targetBranch: 'feature/x',
            mergeMethod: 'squash',
        });
        expect(decision.allowed).toBe(true);
        expect(decision.source).toBe('work');
    });

    it('treats missing decision inputs conservatively (no gate status, no approval)', async () => {
        const { service } = makeService({
            works: { 'work-1': { id: 'work-1', mergePolicy: { allowAgentMerge: true } } },
        });
        const decision = await service.canAgentMerge({
            workId: 'work-1',
            targetBranch: 'feature/x',
            mergeMethod: 'squash',
        });
        expect(decision.allowed).toBe(false);
        expect(decision.code).toBe('gate-not-green');
    });
});
