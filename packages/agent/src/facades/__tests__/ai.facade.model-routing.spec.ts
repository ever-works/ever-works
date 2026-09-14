import { z } from 'zod';
import type { ChatCompletionResponse, IAiProviderPlugin, PluginManifest } from '@ever-works/plugin';
import { AiFacadeService } from '../ai.facade';
import type {
    PluginRegistryService,
    RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import type { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import type { WorkPluginRepository } from '../../plugins/repositories/work-plugin.repository';
import type { PluginUsageService } from '../../usage/plugin-usage.service';
import type { BudgetGuardService } from '../../budgets/budget-guard.service';
import type {
    ModelRoutePlan,
    ModelRoutePlanner,
} from '../../model-routing/model-route-planner.port';

/**
 * Model accounts (AW-16) — the AI facade around the route planner.
 *
 * The properties that matter most: with no planner, or a planner that finds
 * nothing, every call is exactly what it was; an account only ever supplies
 * the plugin's own secret fields; a Work's own key and a Work's own plugin
 * stay in force; the budget gate still runs before the provider is reached;
 * and what answered is recorded on the Run without any credential.
 */

const SECRET = 'sk-account-secret-4242';

function response(model = 'provider-model'): ChatCompletionResponse {
    return {
        id: 'r',
        created: 0,
        model,
        choices: [
            {
                index: 0,
                message: { role: 'assistant', content: '{"name":"x"}' },
                finishReason: 'stop',
            },
        ],
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    } as ChatCompletionResponse;
}

function plugin(id: string): IAiProviderPlugin {
    return {
        id,
        name: id,
        version: '1.0.0',
        category: 'ai-provider',
        capabilities: ['ai-provider'],
        providerType: 'test',
        providerName: `Provider ${id}`,
        settingsSchema: {
            type: 'object',
            properties: {
                apiKey: { type: 'string', 'x-secret': true },
                baseUrl: { type: 'string' },
                defaultModel: { type: 'string' },
            },
        },
        onLoad: jest.fn(),
        onUnload: jest.fn(),
        isAvailable: jest.fn().mockResolvedValue(true),
        createChatCompletion: jest.fn().mockResolvedValue(response()),
        askJson: jest.fn().mockResolvedValue({
            result: { name: 'x' },
            model: 'provider-model',
            usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
        }),
        createStreamingChatCompletion: jest.fn().mockImplementation(async function* () {
            yield {
                id: 'c',
                created: 0,
                model: 'stream-model',
                choices: [{ index: 0, delta: { content: 'hi' } }],
            };
        }),
        listModels: jest.fn().mockResolvedValue([]),
        getModel: jest.fn().mockResolvedValue(null),
        getCapabilities: jest.fn().mockReturnValue({
            supportsStructuredOutput: true,
            supportsStreaming: true,
            supportsToolCalling: true,
            supportsVision: false,
            maxContextLength: 1000,
        }),
    } as unknown as IAiProviderPlugin;
}

function registered(instance: IAiProviderPlugin): RegisteredPlugin {
    return {
        plugin: instance as never,
        manifest: {
            id: instance.id,
            name: instance.id,
            version: '1.0.0',
            category: 'ai-provider',
            description: 'test provider',
            capabilities: ['ai-provider'],
        } as PluginManifest,
        state: 'loaded',
        builtIn: true,
        stateHistory: [],
        registeredAt: 0,
    };
}

const basePlan: ModelRoutePlan = {
    workspaceKey: 'org:o1',
    primarySource: 'default',
    reasoningEffort: 'medium',
    runTimeoutSeconds: 900,
    accountsAvailable: false,
};

describe('AiFacadeService — model accounts', () => {
    let providerA: IAiProviderPlugin;
    let providerB: IAiProviderPlugin;
    let registry: jest.Mocked<
        Pick<PluginRegistryService, 'get' | 'getByCapability' | 'isPluginEnabledForScope'>
    >;
    let settings: { getSettings: jest.Mock; getResolvedSettings: jest.Mock };
    let usage: { record: jest.Mock };
    let budget: { checkBudget: jest.Mock };
    let workPlugins: { findActiveByCapability: jest.Mock };
    let planner: jest.Mocked<ModelRoutePlanner>;

    const build = (withPlanner = true) =>
        new AiFacadeService(
            registry as unknown as PluginRegistryService,
            settings as unknown as PluginSettingsService,
            workPlugins as unknown as WorkPluginRepository,
            usage as unknown as PluginUsageService,
            budget as unknown as BudgetGuardService,
            withPlanner ? planner : undefined,
        );

    beforeEach(() => {
        providerA = plugin('provider-a');
        providerB = plugin('provider-b');
        const table: Record<string, RegisteredPlugin> = {
            'provider-a': registered(providerA),
            'provider-b': registered(providerB),
        };
        registry = {
            get: jest.fn((id: string) => table[id]),
            getByCapability: jest.fn(() => [table['provider-a'], table['provider-b']]),
            isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
        } as never;
        settings = {
            getSettings: jest.fn().mockResolvedValue({
                apiKey: 'sk-platform-key',
                baseUrl: 'https://operator.example/v1',
                defaultModel: 'settings-model',
            }),
            getResolvedSettings: jest.fn().mockResolvedValue({
                apiKey: {
                    key: 'apiKey',
                    value: 'sk-platform-key',
                    source: 'admin',
                    isFallback: false,
                },
            }),
        };
        usage = { record: jest.fn().mockResolvedValue(null) };
        budget = { checkBudget: jest.fn().mockResolvedValue(undefined) };
        workPlugins = { findActiveByCapability: jest.fn().mockResolvedValue(null) };
        planner = {
            plan: jest.fn().mockResolvedValue(null),
            selectAccount: jest.fn().mockResolvedValue(null),
            recordAnswer: jest.fn().mockResolvedValue(undefined),
            reportFailure: jest.fn().mockResolvedValue(undefined),
        };
    });

    const chat = (
        service: AiFacadeService,
        facadeOptions: Record<string, unknown> = {},
        model?: string,
    ) =>
        service.createChatCompletion(
            { model, messages: [{ role: 'user', content: 'hello' }] },
            { userId: 'u1', workId: 'w1', ...facadeOptions },
        );

    it('makes exactly the same provider call with no planner and with a planner that finds nothing', async () => {
        await chat(build(false));
        const withoutPlanner = (providerA.createChatCompletion as jest.Mock).mock.calls[0][0];
        const usageWithout = usage.record.mock.calls[0][0];
        (providerA.createChatCompletion as jest.Mock).mockClear();
        usage.record.mockClear();

        await chat(build(true));
        expect((providerA.createChatCompletion as jest.Mock).mock.calls[0][0]).toEqual(
            withoutPlanner,
        );
        expect(usage.record.mock.calls[0][0]).toEqual(usageWithout);
        expect(planner.selectAccount).not.toHaveBeenCalled();
    });

    it("routes to the ladder's provider and model", async () => {
        planner.plan.mockResolvedValue({
            ...basePlan,
            providerPluginId: 'provider-b',
            modelId: 'schedule-model',
            primarySource: 'schedule',
        });
        await chat(build(), { agentId: 'a1' }, 'agent-model');
        expect(planner.plan).toHaveBeenCalledWith(
            expect.objectContaining({ agentId: 'a1', requestedModelId: 'agent-model' }),
        );
        expect(providerA.createChatCompletion).not.toHaveBeenCalled();
        expect(providerB.createChatCompletion).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'schedule-model' }),
        );
    });

    it("keeps a Work's own selected plugin ahead of the workspace default", async () => {
        workPlugins.findActiveByCapability.mockResolvedValue({ pluginId: 'provider-a' });
        planner.plan.mockResolvedValue({
            ...basePlan,
            providerPluginId: 'provider-b',
            modelId: 'workspace-model',
            primarySource: 'workspace',
        });
        await chat(build(), { agentId: 'a1' });
        expect(providerB.createChatCompletion).not.toHaveBeenCalled();
        expect(providerA.createChatCompletion).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'settings-model' }),
        );
    });

    it("lays only the account's secret fields over the settings, and records the account id — never the key", async () => {
        planner.plan.mockResolvedValue({ ...basePlan, accountsAvailable: true });
        planner.selectAccount.mockResolvedValue({
            accountId: 'acc-1',
            label: 'Company key',
            credentials: { apiKey: SECRET, baseUrl: 'http://attacker.example' },
        });
        await chat(build());
        const call = (providerA.createChatCompletion as jest.Mock).mock.calls[0][0];
        expect(call.settings).toMatchObject({
            apiKey: SECRET,
            baseUrl: 'https://operator.example/v1',
        });
        const recorded = usage.record.mock.calls[0][0];
        expect(recorded.metadata).toMatchObject({ modelAccountId: 'acc-1' });
        expect(JSON.stringify(recorded)).not.toContain(SECRET);
    });

    it("keeps a key the Work itself configured instead of the account's", async () => {
        planner.plan.mockResolvedValue({ ...basePlan, accountsAvailable: true });
        planner.selectAccount.mockResolvedValue({
            accountId: 'acc-1',
            label: 'Company key',
            credentials: { apiKey: SECRET },
        });
        settings.getResolvedSettings.mockResolvedValue({
            apiKey: { key: 'apiKey', value: 'sk-work-key', source: 'work', isFallback: false },
        });
        await chat(build());
        const call = (providerA.createChatCompletion as jest.Mock).mock.calls[0][0];
        expect(call.settings.apiKey).toBe('sk-platform-key');
        expect(usage.record.mock.calls[0][0].metadata.modelAccountId).toBeUndefined();
    });

    it('still stops at the budget gate before any provider call, recording nothing', async () => {
        planner.plan.mockResolvedValue({
            ...basePlan,
            providerPluginId: 'provider-b',
            modelId: 'm',
            primarySource: 'schedule',
        });
        budget.checkBudget.mockRejectedValue(new Error('Budget exceeded'));
        await expect(chat(build(), { runId: 'r1' })).rejects.toThrow('Budget exceeded');
        expect(providerB.createChatCompletion).not.toHaveBeenCalled();
        expect(planner.recordAnswer).not.toHaveBeenCalled();
        expect(planner.reportFailure).not.toHaveBeenCalled();
    });

    it('records what answered on the Run, only when the call belongs to a Run', async () => {
        await chat(build());
        expect(planner.recordAnswer).not.toHaveBeenCalled();

        await chat(build(), { runId: 'r1', agentId: 'a1' });
        expect(planner.recordAnswer).toHaveBeenCalledWith(
            expect.objectContaining({
                runId: 'r1',
                provider: 'provider-a',
                model: 'provider-model',
                account: null,
                plan: null,
            }),
        );
    });

    it('reports a failed call on an account and rethrows the provider error unchanged', async () => {
        planner.plan.mockResolvedValue({ ...basePlan, accountsAvailable: true });
        planner.selectAccount.mockResolvedValue({
            accountId: 'acc-1',
            label: 'Company key',
            credentials: { apiKey: SECRET },
        });
        const refusal = Object.assign(new Error('Unauthorized'), { status: 401 });
        (providerA.createChatCompletion as jest.Mock).mockRejectedValue(refusal);
        await expect(chat(build(), { runId: 'r1' })).rejects.toBe(refusal);
        expect(planner.reportFailure).toHaveBeenCalledWith('acc-1', refusal);
        expect(planner.recordAnswer).not.toHaveBeenCalled();
    });

    it('runs the call exactly as before when the planner itself fails', async () => {
        planner.plan.mockRejectedValue(new Error('model_policies unreachable'));
        await expect(chat(build())).resolves.toMatchObject({ model: 'provider-model' });
        expect(providerA.createChatCompletion).toHaveBeenCalled();
    });

    it("askJson: the ladder's model becomes the override, a complexity tier survives a provider-only route", async () => {
        const schema = z.object({ name: z.string() });
        planner.plan.mockResolvedValueOnce({
            ...basePlan,
            providerPluginId: 'provider-b',
            modelId: 'workspace-model',
            primarySource: 'workspace',
        });
        await build().askJson('p', schema, {}, { userId: 'u1', agentId: 'a1' });
        expect(providerB.askJson).toHaveBeenCalledWith(
            'p',
            expect.objectContaining({ model: 'workspace-model' }),
        );

        settings.getSettings.mockResolvedValue({ simpleModel: 'tier-model' });
        planner.plan.mockResolvedValueOnce({
            ...basePlan,
            providerPluginId: 'provider-b',
            primarySource: 'workspace',
        });
        await build().askJson(
            'p',
            schema,
            { routing: { complexity: 'simple' } },
            { userId: 'u1', agentId: 'a1' },
        );
        expect(planner.plan).toHaveBeenLastCalledWith(
            expect.objectContaining({ hasComplexity: true }),
        );
        expect(providerB.askJson).toHaveBeenLastCalledWith(
            'p',
            expect.objectContaining({ model: 'tier-model' }),
        );
    });

    it('streams on the planned route and records once the stream has produced output', async () => {
        planner.plan.mockResolvedValue({
            ...basePlan,
            providerPluginId: 'provider-b',
            modelId: 'schedule-model',
            primarySource: 'schedule',
        });
        const chunks = [];
        for await (const chunk of build().createStreamingChatCompletion(
            { messages: [{ role: 'user', content: 'hi' }] },
            { userId: 'u1', runId: 'r1' },
        )) {
            chunks.push(chunk);
        }
        expect(chunks).toHaveLength(1);
        expect(planner.plan).toHaveBeenCalledTimes(1);
        expect(providerB.createStreamingChatCompletion).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'schedule-model', stream: true }),
        );
        await new Promise((resolve) => setImmediate(resolve));
        expect(planner.recordAnswer).toHaveBeenCalledWith(
            expect.objectContaining({ runId: 'r1', provider: 'provider-b', model: 'stream-model' }),
        );
    });
});
