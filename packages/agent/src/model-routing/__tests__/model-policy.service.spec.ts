import type { Repository } from 'typeorm';
import type { ActivityLogService } from '../../activity-log/activity-log.service';
import type { ModelPolicyRepository } from '../../database/repositories/model-policy.repository';
import type { Agent } from '../../entities/agent.entity';
import type { ModelPolicy } from '../../entities/model-policy.entity';
import type { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import { ModelPolicyResolver } from '../model-policy.resolver';
import { ModelPolicyService } from '../model-policy.service';
import type { ModelProviderCatalogService } from '../model-provider-catalog.service';
import { providerDescriptor } from './model-routing.fakes';

const ORG = { userId: 'u1', tenantId: 't1', organizationId: 'o1' };

describe('ModelPolicyService', () => {
    let rows: ModelPolicy[];
    let agents: Array<Partial<Agent>>;
    let agentUpdate: jest.Mock;
    let log: jest.Mock;
    let service: ModelPolicyService;

    beforeEach(() => {
        rows = [];
        agents = [
            {
                id: 'a1',
                userId: 'u1',
                tenantId: 't1',
                organizationId: 'o1',
                aiProviderId: null,
                modelId: null,
            },
        ];
        const policies = {
            findByScope: jest.fn(
                async (workspaceKey: string, scopeKey: string) =>
                    rows.find(
                        (row) => row.workspaceKey === workspaceKey && row.scopeKey === scopeKey,
                    ) ?? null,
            ),
            findByScopes: jest.fn(async (workspaceKey: string, keys: string[]) =>
                rows.filter(
                    (row) => row.workspaceKey === workspaceKey && keys.includes(row.scopeKey),
                ),
            ),
            create: (entry: Partial<ModelPolicy>) => ({ ...entry }) as ModelPolicy,
            save: jest.fn(async (row: ModelPolicy) => {
                const stored = {
                    ...row,
                    id: row.id ?? `p${rows.length + 1}`,
                    updatedAt: new Date(),
                };
                rows = rows.filter((candidate) => candidate.id !== stored.id).concat(stored);
                return stored;
            }),
            deleteByScope: jest.fn(async (workspaceKey: string, scopeKey: string) => {
                rows = rows.filter(
                    (row) => !(row.workspaceKey === workspaceKey && row.scopeKey === scopeKey),
                );
                return true;
            }),
        } as unknown as ModelPolicyRepository;
        const catalogued = providerDescriptor('provider-a', {
            listModels: jest.fn().mockResolvedValue([{ id: 'big' }, { id: 'fast' }]),
        });
        const gateway = providerDescriptor('gateway', {
            listModels: jest.fn().mockRejectedValue(new Error('needs a key')),
        });
        const providers = {
            getProvider: jest.fn(async (id: string) =>
                id === 'provider-a' ? catalogued : id === 'gateway' ? gateway : null,
            ),
        } as unknown as ModelProviderCatalogService;
        agentUpdate = jest.fn(async (where: { id: string }, patch: Partial<Agent>) => {
            Object.assign(agents.find((agent) => agent.id === where.id)!, patch);
        });
        const agentRepository = {
            findOne: jest.fn(async (options: { where: Array<Record<string, unknown>> }) => {
                const branch = options.where[0];
                return (
                    agents.find(
                        (agent) =>
                            agent.id === branch.id &&
                            agent.userId === branch.userId &&
                            agent.organizationId === branch.organizationId,
                    ) ?? null
                );
            }),
            update: agentUpdate,
        } as unknown as Repository<Agent>;
        log = jest.fn().mockResolvedValue(undefined);
        service = new ModelPolicyService(
            policies,
            new ModelPolicyResolver(policies),
            providers,
            agentRepository,
            { getSettings: jest.fn().mockResolvedValue({}) } as unknown as PluginSettingsService,
            { log } as unknown as ActivityLogService,
        );
    });

    it('stores a workspace default and marks a model id the catalogue does not list', async () => {
        const known = await service.put(
            ORG,
            { type: 'workspace' },
            {
                primaryModel: { providerPluginId: 'provider-a', modelId: 'big' },
            },
        );
        expect(known.policy.primaryModel).toEqual({
            providerPluginId: 'provider-a',
            modelId: 'big',
        });

        const typo = await service.put(
            ORG,
            { type: 'workspace' },
            {
                primaryModel: { providerPluginId: 'provider-a', modelId: 'bgi' },
            },
        );
        expect(typo.policy.primaryModel).toEqual({
            providerPluginId: 'provider-a',
            modelId: 'bgi',
            unverified: true,
        });

        // A catalogue that cannot be fetched still accepts a typed id, unverified.
        const gateway = await service.put(
            ORG,
            { type: 'workspace' },
            {
                fallbackModels: [{ providerPluginId: 'gateway', modelId: 'org/model-x' }],
            },
        );
        expect(gateway.policy.fallbackModels).toEqual([
            { providerPluginId: 'gateway', modelId: 'org/model-x', unverified: true },
        ]);
    });

    it('refuses a chain containing the primary, a repeat, a fourth entry and an unknown provider', async () => {
        const primary = { providerPluginId: 'provider-a', modelId: 'big' };
        await expect(
            service.put(
                ORG,
                { type: 'workspace' },
                { primaryModel: primary, fallbackModels: [primary] },
            ),
        ).rejects.toMatchObject({ response: { code: 'invalid_policy' } });
        await expect(
            service.put(
                ORG,
                { type: 'workspace' },
                {
                    fallbackModels: [
                        { providerPluginId: 'provider-a', modelId: 'fast' },
                        { providerPluginId: 'provider-a', modelId: 'fast' },
                    ],
                },
            ),
        ).rejects.toMatchObject({ response: { code: 'invalid_policy' } });
        await expect(
            service.put(
                ORG,
                { type: 'workspace' },
                {
                    fallbackModels: ['1', '2', '3', '4'].map((modelId) => ({
                        providerPluginId: 'provider-a',
                        modelId,
                    })),
                },
            ),
        ).rejects.toMatchObject({ response: { code: 'invalid_policy' } });
        await expect(
            service.put(
                ORG,
                { type: 'workspace' },
                {
                    primaryModel: { providerPluginId: 'missing', modelId: 'm' },
                },
            ),
        ).rejects.toMatchObject({ response: { code: 'unknown_provider' } });
        expect(rows).toHaveLength(0);
    });

    it('removes the new primary from the chain and says so', async () => {
        await service.put(
            ORG,
            { type: 'workspace' },
            {
                primaryModel: { providerPluginId: 'provider-a', modelId: 'big' },
                fallbackModels: [
                    { providerPluginId: 'provider-a', modelId: 'fast' },
                    { providerPluginId: 'gateway', modelId: 'other' },
                ],
            },
        );
        const changed = await service.put(
            ORG,
            { type: 'workspace' },
            {
                primaryModel: { providerPluginId: 'provider-a', modelId: 'fast' },
            },
        );
        expect(changed.removedFromFallbacks).toEqual([
            { providerPluginId: 'provider-a', modelId: 'fast' },
        ]);
        expect(changed.policy.fallbackModels).toEqual([
            { providerPluginId: 'gateway', modelId: 'other', unverified: true },
        ]);
    });

    it('enforces the effort vocabulary and both timeout bounds', async () => {
        for (const input of [
            { reasoningEffort: 'extreme' as never },
            { runTimeoutSeconds: 30 },
            { runTimeoutSeconds: 3 * 3600 },
            { attemptTimeoutSeconds: 5 },
            { attemptTimeoutSeconds: 601 },
        ]) {
            await expect(service.put(ORG, { type: 'workspace' }, input)).rejects.toMatchObject({
                response: { code: 'invalid_policy' },
            });
        }
        await expect(
            service.put(ORG, { type: 'agent', agentId: 'a1' }, { runTimeoutSeconds: 900 }),
        ).rejects.toMatchObject({ response: { code: 'invalid_policy' } });
        const saved = await service.put(
            ORG,
            { type: 'workspace' },
            {
                reasoningEffort: 'high',
                runTimeoutSeconds: 60,
                attemptTimeoutSeconds: 600,
            },
        );
        expect(saved.policy).toMatchObject({
            reasoningEffort: 'high',
            runTimeoutSeconds: 60,
            attemptTimeoutSeconds: 600,
        });
    });

    it("writes an Agent's model through to the Agent's own columns — one place, no copy", async () => {
        const result = await service.put(
            ORG,
            { type: 'agent', agentId: 'a1' },
            {
                primaryModel: { providerPluginId: 'provider-a', modelId: 'fast' },
            },
        );
        expect(agentUpdate).toHaveBeenCalledWith(
            { id: 'a1' },
            { aiProviderId: 'provider-a', modelId: 'fast' },
        );
        expect(result.policy.primaryModel).toEqual({
            providerPluginId: 'provider-a',
            modelId: 'fast',
        });
        // Nothing but the primary changed, so no policy row was needed.
        expect(rows).toHaveLength(0);

        await service.put(ORG, { type: 'agent', agentId: 'a1' }, { reasoningEffort: 'high' });
        expect(rows).toHaveLength(1);
        expect(rows[0].primaryModel ?? null).toBeNull();

        const resolved = await service.resolve(ORG, { agentId: 'a1' });
        expect(resolved.primaryModel).toEqual({
            value: { providerPluginId: 'provider-a', modelId: 'fast' },
            source: 'agent',
        });
        expect(resolved.reasoningEffort).toEqual({ value: 'high', source: 'agent' });

        await service.remove(ORG, { type: 'agent', agentId: 'a1' });
        expect(agents[0]).toMatchObject({ aiProviderId: null, modelId: null });
        expect(rows).toHaveLength(0);
    });

    it("keeps an Agent pair's either-half flexibility", async () => {
        const providerOnly = await service.put(
            ORG,
            { type: 'agent', agentId: 'a1' },
            {
                primaryModel: { providerPluginId: 'provider-a', modelId: null },
            },
        );
        expect(providerOnly.policy.primaryModel).toEqual({
            providerPluginId: 'provider-a',
            modelId: null,
        });
    });

    it('answers 404 for an Agent outside the workspace', async () => {
        await expect(
            service.get({ ...ORG, organizationId: 'other-org' }, { type: 'agent', agentId: 'a1' }),
        ).rejects.toMatchObject({ response: { code: 'not_found' } });
    });

    it('resolves a schedule over the Agent over the workspace, field by field', async () => {
        agents[0].aiProviderId = 'provider-a';
        agents[0].modelId = 'big';
        await service.put(
            ORG,
            { type: 'workspace' },
            { runTimeoutSeconds: 1200, reasoningEffort: 'low' },
        );
        await service.put(
            ORG,
            { type: 'schedule', source: 'agent_heartbeat', ownerId: 'a1' },
            { primaryModel: { providerPluginId: 'provider-a', modelId: 'fast' } },
        );
        const resolved = await service.resolve(ORG, {
            agentId: 'a1',
            scheduleId: 'agent_heartbeat:a1',
        });
        expect(resolved.primaryModel.source).toBe('schedule');
        expect(resolved.runTimeoutSeconds).toEqual({ value: 1200, source: 'workspace' });
        expect(resolved.reasoningEffort).toEqual({ value: 'low', source: 'workspace' });
        await expect(service.resolve(ORG, { scheduleId: 'bogus:x' })).rejects.toMatchObject({
            response: { code: 'invalid_policy' },
        });
    });

    it('logs which fields changed and never a value', async () => {
        await service.put(
            ORG,
            { type: 'workspace' },
            {
                primaryModel: { providerPluginId: 'provider-a', modelId: 'big' },
                reasoningEffort: 'medium',
            },
        );
        expect(log).toHaveBeenCalledWith(
            expect.objectContaining({
                actionType: 'model_policy_updated',
                details: expect.objectContaining({
                    scopeKey: 'workspace',
                    fields: ['primaryModel', 'reasoningEffort'],
                }),
            }),
        );
    });
});
