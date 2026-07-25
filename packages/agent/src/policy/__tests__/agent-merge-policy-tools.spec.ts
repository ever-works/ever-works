import { PLATFORM_DEFAULT_MERGE_POLICY } from '@ever-works/contracts';
import { buildMergePolicyTools } from '../agent-merge-policy-tools';

/**
 * Merge-policy matrix (Wave 3, D4) — the `resolve_merge_policy` chat
 * tool. Read-only and owner-scoped: an agent asking about a scope its
 * user cannot reach gets a flat "not found", never a policy leak.
 */
describe('buildMergePolicyTools', () => {
    const resolved = {
        policy: PLATFORM_DEFAULT_MERGE_POLICY,
        source: 'default' as const,
        chain: [],
    };

    it('exposes exactly the resolve_merge_policy read tool', () => {
        const tools = buildMergePolicyTools({
            userId: 'user-1',
            service: { resolve: jest.fn() },
            authorize: jest.fn(),
        });
        expect(tools).toHaveLength(1);
        expect(tools[0].name).toBe('resolve_merge_policy');
        expect(tools[0].parameters.required).toEqual([]);
        expect(Object.keys(tools[0].parameters.properties).sort()).toEqual(['agentId', 'workId']);
    });

    it('refuses a call with neither workId nor agentId', async () => {
        const resolve = jest.fn();
        const [tool] = buildMergePolicyTools({
            userId: 'user-1',
            service: { resolve },
            authorize: jest.fn(),
        });
        await expect(tool.invoke({})).resolves.toEqual({
            error: 'Provide workId or agentId to resolve a merge policy.',
        });
        expect(resolve).not.toHaveBeenCalled();
    });

    it('never resolves a scope the authorizer rejects (owner scoping)', async () => {
        const resolve = jest.fn();
        const [tool] = buildMergePolicyTools({
            userId: 'user-1',
            service: { resolve },
            authorize: jest.fn().mockResolvedValue(null),
        });
        await expect(tool.invoke({ workId: 'someone-elses-work' })).resolves.toEqual({
            error: 'Not found or not accessible to the current user.',
        });
        expect(resolve).not.toHaveBeenCalled();
    });

    it('resolves the authorized scope tuple and returns policy + source + chain', async () => {
        const resolve = jest.fn().mockResolvedValue(resolved);
        const [tool] = buildMergePolicyTools({
            userId: 'user-1',
            service: { resolve },
            authorize: jest.fn().mockResolvedValue({ workId: 'work-1', agentId: 'agent-1' }),
        });
        await expect(tool.invoke({ workId: 'work-1', agentId: 'agent-1' })).resolves.toEqual(
            resolved,
        );
        expect(resolve).toHaveBeenCalledWith({ workId: 'work-1', agentId: 'agent-1' });
    });

    it('reports a resolution failure as a tool error instead of throwing', async () => {
        const [tool] = buildMergePolicyTools({
            userId: 'user-1',
            service: { resolve: jest.fn().mockRejectedValue(new Error('boom')) },
            authorize: jest.fn().mockResolvedValue({ workId: 'work-1' }),
        });
        await expect(tool.invoke({ workId: 'work-1' })).resolves.toEqual({ error: 'boom' });
    });
});
