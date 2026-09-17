import type { Repository } from 'typeorm';
import type { ModelPolicyRepository } from '../../database/repositories/model-policy.repository';
import type { AgentRun } from '../../entities/agent-run.entity';
import type { Agent } from '../../entities/agent.entity';
import type { ModelPolicy } from '../../entities/model-policy.entity';
import type { Work } from '../../entities/work.entity';
import type { ModelAccountHealthService } from '../model-account-health.service';
import { ModelPolicyResolver } from '../model-policy.resolver';
import { ModelRoutePlannerService } from '../model-route-planner.service';
import { InMemoryModelAccounts } from './model-routing.fakes';

const SECRET = 'sk-live-routing-secret-9f8e7d';

function policy(overrides: Partial<ModelPolicy>): ModelPolicy {
    return {
        id: `p-${overrides.scopeKey}`,
        userId: 'u1',
        workspaceKey: 'org:o1',
        scopeKey: 'workspace',
        scopeType: 'workspace',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    } as ModelPolicy;
}

describe('ModelRoutePlannerService', () => {
    let accounts: InMemoryModelAccounts;
    let policies: ModelPolicy[];
    let runs: Record<string, Partial<AgentRun>>;
    let agents: Record<string, Partial<Agent>>;
    let works: Record<string, Partial<Work>>;
    let runUpdate: jest.Mock;
    let applyLiveRejection: jest.Mock;
    let planner: ModelRoutePlannerService;

    beforeEach(() => {
        accounts = new InMemoryModelAccounts();
        policies = [];
        runs = {};
        agents = {};
        works = {};
        runUpdate = jest.fn(async (where: { id: string }, patch: Partial<AgentRun>) => {
            Object.assign(runs[where.id] ?? {}, patch);
        });
        applyLiveRejection = jest.fn().mockResolvedValue(undefined);
        const policyRepository = {
            anyExist: async () => policies.length > 0,
            findByScopes: async (workspaceKey: string, keys: string[]) =>
                policies.filter(
                    (row) => row.workspaceKey === workspaceKey && keys.includes(row.scopeKey),
                ),
        } as unknown as ModelPolicyRepository;
        const byId = <T>(table: () => Record<string, Partial<T>>) =>
            ({
                findOne: jest.fn(async (options: { where: { id: string } }) => {
                    const row = table()[options.where.id];
                    return row ? { ...row } : null;
                }),
                update: runUpdate,
            }) as unknown as Repository<T>;
        planner = new ModelRoutePlannerService(
            accounts.asRepository(),
            policyRepository,
            new ModelPolicyResolver(policyRepository),
            byId<AgentRun>(() => runs),
            byId<Agent>(() => agents),
            byId<Work>(() => works),
            { applyLiveRejection } as unknown as ModelAccountHealthService,
        );
    });

    it('returns nothing when no account and no policy exists anywhere', async () => {
        agents.a1 = { id: 'a1', userId: 'u1', organizationId: 'o1' };
        await expect(
            planner.plan({ userId: 'u1', agentId: 'a1', runId: 'r1' }),
        ).resolves.toBeNull();
    });

    it('applies the workspace default to an Agent with no model of its own', async () => {
        policies.push(
            policy({
                primaryModel: { providerPluginId: 'provider-b', modelId: 'big' },
                reasoningEffort: 'high',
            }),
        );
        agents.a1 = {
            id: 'a1',
            userId: 'u1',
            organizationId: 'o1',
            aiProviderId: null,
            modelId: null,
        };
        const plan = await planner.plan({ userId: 'u1', agentId: 'a1' });
        expect(plan).toEqual({
            workspaceKey: 'org:o1',
            providerPluginId: 'provider-b',
            modelId: 'big',
            primarySource: 'workspace',
            reasoningEffort: 'high',
            runTimeoutSeconds: 900,
            accountsAvailable: false,
        });
    });

    it('leaves a call that is not for an Agent alone when its workspace has no account', async () => {
        policies.push(policy({ primaryModel: { providerPluginId: 'provider-b', modelId: 'big' } }));
        works.w1 = { id: 'w1', userId: 'u1', organizationId: 'o1' };
        await expect(planner.plan({ userId: 'u1', workId: 'w1' })).resolves.toBeNull();
    });

    it("lets a heartbeat run's schedule override the Agent's own pair, recognised from the Run", async () => {
        agents.a1 = {
            id: 'a1',
            userId: 'u1',
            organizationId: 'o1',
            aiProviderId: 'provider-a',
            modelId: 'big',
        };
        runs.r1 = {
            id: 'r1',
            agentId: 'a1',
            userId: 'u1',
            organizationId: 'o1',
            triggerKind: 'heartbeat',
        };
        runs.r2 = {
            id: 'r2',
            agentId: 'a1',
            userId: 'u1',
            organizationId: 'o1',
            triggerKind: 'manual',
        };
        policies.push(
            policy({
                scopeKey: 'schedule:agent_heartbeat:a1',
                scopeType: 'schedule',
                primaryModel: { providerPluginId: 'provider-a', modelId: 'fast' },
            }),
        );
        const heartbeat = await planner.plan({
            userId: 'u1',
            agentId: 'a1',
            runId: 'r1',
            requestedProviderId: 'provider-a',
            requestedModelId: 'big',
        });
        expect(heartbeat).toMatchObject({ modelId: 'fast', primarySource: 'schedule' });

        const manual = await planner.plan({
            userId: 'u1',
            agentId: 'a1',
            runId: 'r2',
            requestedProviderId: 'provider-a',
            requestedModelId: 'big',
        });
        expect(manual).toMatchObject({ primarySource: 'agent' });
        expect(manual?.modelId).toBeUndefined();
    });

    it('keeps the routing a Run started with after the policy changes', async () => {
        agents.a1 = { id: 'a1', userId: 'u1', organizationId: 'o1' };
        runs.r1 = {
            id: 'r1',
            agentId: 'a1',
            userId: 'u1',
            organizationId: 'o1',
            triggerKind: 'task',
            modelRouting: {
                provider: 'provider-b',
                model: 'big-2026-01',
                resolvedModel: 'big',
                effort: 'high',
                runTimeoutSeconds: 1800,
                outcome: 'answered',
                attempts: [],
                primarySource: 'workspace',
            },
        };
        policies.push(
            policy({
                primaryModel: { providerPluginId: 'provider-c', modelId: 'new' },
                reasoningEffort: 'low',
            }),
        );
        const plan = await planner.plan({ userId: 'u1', runId: 'r1' });
        expect(plan).toMatchObject({
            providerPluginId: 'provider-b',
            modelId: 'big',
            reasoningEffort: 'high',
            runTimeoutSeconds: 1800,
        });
    });

    describe('selectAccount', () => {
        const plan = {
            workspaceKey: 'org:o1',
            primarySource: 'default' as const,
            reasoningEffort: 'medium' as const,
            runTimeoutSeconds: 900,
            accountsAvailable: true,
        };

        it('picks the first usable account by position, skipping paused, rejected, expired and cooling-down ones', async () => {
            accounts.seed({ label: 'paused', position: 1, enabled: false });
            accounts.seed({ label: 'rejected', position: 2, health: 'invalid' });
            accounts.seed({
                label: 'expired',
                position: 3,
                credentialExpiresAt: new Date(Date.now() - 1000),
            });
            accounts.seed({
                label: 'cooling',
                position: 4,
                cooldownUntil: new Date(Date.now() + 60_000),
            });
            accounts.seed({ label: 'empty', position: 5, credentials: { apiKey: '' } });
            accounts.seed({ label: 'usable', position: 6, credentials: { apiKey: SECRET } });
            accounts.seed({ label: 'later', position: 7 });
            await expect(planner.selectAccount(plan, 'provider-a')).resolves.toMatchObject({
                label: 'usable',
                credentials: { apiKey: SECRET },
            });
        });

        it('never reaches into another workspace or provider', async () => {
            accounts.seed({ workspaceKey: 'org:other', label: 'foreign' });
            accounts.seed({ providerPluginId: 'provider-b', label: 'other provider' });
            await expect(planner.selectAccount(plan, 'provider-a')).resolves.toBeNull();
            await expect(
                planner.selectAccount({ ...plan, accountsAvailable: false }, 'provider-b'),
            ).resolves.toBeNull();
        });
    });

    describe('recordAnswer', () => {
        it('records what answered, never a credential, and writes only when it changes', async () => {
            runs.r1 = { id: 'r1' };
            const account = accounts.seed({
                label: 'Company key',
                credentials: { apiKey: SECRET },
            });
            const record = {
                runId: 'r1',
                plan: {
                    workspaceKey: 'org:o1',
                    providerPluginId: 'provider-a',
                    modelId: 'big',
                    primarySource: 'workspace' as const,
                    reasoningEffort: 'high' as const,
                    runTimeoutSeconds: 1200,
                    accountsAvailable: true,
                },
                provider: 'provider-a',
                model: 'big-2026-01',
                account: { accountId: account.id, label: 'Company key' },
                durationMs: 812.4,
            };
            await planner.recordAnswer(record);
            await planner.recordAnswer(record);

            expect(runUpdate).toHaveBeenCalledTimes(1);
            const routing = runUpdate.mock.calls[0][1].modelRouting;
            expect(routing).toMatchObject({
                provider: 'provider-a',
                model: 'big-2026-01',
                resolvedModel: 'big',
                accountId: account.id,
                accountLabel: 'Company key',
                effort: 'high',
                effortApplied: false,
                runTimeoutSeconds: 1200,
                outcome: 'answered',
                primarySource: 'workspace',
                attempts: [
                    {
                        provider: 'provider-a',
                        model: 'big-2026-01',
                        accountLabel: 'Company key',
                        result: 'ok',
                        ms: 812,
                    },
                ],
            });
            const serialised = JSON.stringify(routing);
            expect(serialised).not.toContain(SECRET);
            for (let start = 0; start + 8 <= SECRET.length; start += 1) {
                expect(serialised).not.toContain(SECRET.slice(start, start + 8));
            }
            expect(accounts.rows[0].lastUsedAt).toBeInstanceOf(Date);
        });

        it('records defaults for a Run in a workspace with nothing configured', async () => {
            await planner.recordAnswer({
                runId: 'r9',
                plan: null,
                provider: 'provider-a',
                model: 'm',
                account: null,
                durationMs: 5,
            });
            expect(runUpdate.mock.calls[0][1].modelRouting).toMatchObject({
                accountId: null,
                effort: 'medium',
                runTimeoutSeconds: 900,
                primarySource: 'default',
            });
        });

        it('never throws when the write fails', async () => {
            runUpdate.mockRejectedValueOnce(new Error('db down'));
            await expect(
                planner.recordAnswer({
                    runId: 'r1',
                    plan: null,
                    provider: 'p',
                    model: 'm',
                    account: null,
                    durationMs: 1,
                }),
            ).resolves.toBeUndefined();
        });
    });

    it('marks an account invalid only for a credential rejection', async () => {
        await planner.reportFailure('acc-1', { status: 429 });
        expect(applyLiveRejection).not.toHaveBeenCalled();
        await planner.reportFailure('acc-1', { status: 401 });
        expect(applyLiveRejection).toHaveBeenCalledWith('acc-1');
    });
});
