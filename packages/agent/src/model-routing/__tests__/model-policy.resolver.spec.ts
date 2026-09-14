import type { ModelPolicyRepository } from '../../database/repositories/model-policy.repository';
import type { ModelPolicy } from '../../entities/model-policy.entity';
import { ModelPolicyResolver } from '../model-policy.resolver';

function row(overrides: Partial<ModelPolicy>): ModelPolicy {
    return {
        id: 'p',
        userId: 'u1',
        workspaceKey: 'org:o1',
        scopeKey: 'workspace',
        scopeType: 'workspace',
        primaryModel: null,
        fallbackModels: null,
        reasoningEffort: null,
        runTimeoutSeconds: null,
        attemptTimeoutSeconds: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    } as ModelPolicy;
}

describe('ModelPolicyResolver', () => {
    let rows: ModelPolicy[];
    let findByScopes: jest.Mock;
    let resolver: ModelPolicyResolver;

    beforeEach(() => {
        rows = [];
        findByScopes = jest.fn(async (_workspaceKey: string, keys: string[]) =>
            rows.filter((candidate) => keys.includes(candidate.scopeKey)),
        );
        resolver = new ModelPolicyResolver({ findByScopes } as unknown as ModelPolicyRepository);
    });

    it('reads every applicable scope in one query', async () => {
        await resolver.resolve({
            workspaceKey: 'org:o1',
            agent: { id: 'a1' },
            schedule: { source: 'agent_heartbeat', ownerId: 'a1' },
        });
        expect(findByScopes).toHaveBeenCalledTimes(1);
        expect(findByScopes).toHaveBeenCalledWith('org:o1', [
            'workspace',
            'agent:a1',
            'schedule:agent_heartbeat:a1',
        ]);
    });

    it('resolves to defaults for a workspace with no policy', async () => {
        const resolved = await resolver.resolve({ workspaceKey: 'org:o1' });
        expect(resolved.primaryModel).toEqual({ value: null, source: 'default' });
        expect(resolved.reasoningEffort.value).toBe('medium');
        expect(resolved.runTimeoutSeconds.value).toBe(900);
    });

    it("reads the Agent's primary from the Agent row, never from its policy row", async () => {
        rows = [
            row({ scopeKey: 'workspace', primaryModel: { providerPluginId: 'a', modelId: 'big' } }),
            row({
                scopeKey: 'agent:a1',
                scopeType: 'agent',
                // A stray primary on an Agent row is ignored.
                primaryModel: { providerPluginId: 'x', modelId: 'stray' },
                reasoningEffort: 'high',
            }),
        ];
        const withPair = await resolver.resolve({
            workspaceKey: 'org:o1',
            agent: { id: 'a1', aiProviderId: 'a', modelId: 'fast' },
        });
        expect(withPair.primaryModel).toEqual({
            value: { providerPluginId: 'a', modelId: 'fast' },
            source: 'agent',
        });
        expect(withPair.reasoningEffort).toEqual({ value: 'high', source: 'agent' });

        const withoutPair = await resolver.resolve({
            workspaceKey: 'org:o1',
            agent: { id: 'a1', aiProviderId: null, modelId: null },
        });
        expect(withoutPair.primaryModel.source).toBe('workspace');
    });

    it('lets a schedule set only the model and inherit the rest', async () => {
        rows = [
            row({ scopeKey: 'workspace', reasoningEffort: 'low', runTimeoutSeconds: 600 }),
            row({
                scopeKey: 'schedule:agent_heartbeat:a1',
                scopeType: 'schedule',
                primaryModel: { providerPluginId: 'b', modelId: 'cheap' },
            }),
        ];
        const resolved = await resolver.resolve({
            workspaceKey: 'org:o1',
            agent: { id: 'a1', aiProviderId: 'a', modelId: 'big' },
            schedule: { source: 'agent_heartbeat', ownerId: 'a1' },
        });
        expect(resolved.primaryModel.source).toBe('schedule');
        expect(resolved.reasoningEffort).toEqual({ value: 'low', source: 'workspace' });
        expect(resolved.runTimeoutSeconds).toEqual({ value: 600, source: 'workspace' });
    });
});
