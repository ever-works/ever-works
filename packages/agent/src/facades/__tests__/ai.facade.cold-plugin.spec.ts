import { Logger } from '@nestjs/common';
import type { ChatCompletionResponse } from '@ever-works/plugin';
import { AiFacadeService } from '../ai.facade';
import type { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import type { WorkPluginRepository } from '../../plugins/repositories/work-plugin.repository';
import type { PluginUsageService } from '../../usage/plugin-usage.service';
import type { BudgetGuardService } from '../../budgets/budget-guard.service';
import type { ModelRoutePlanner } from '../../model-routing/model-route-planner.port';
import {
    createRegistry,
    registerColdPlugin,
    requiredSecretSchema,
} from '../../plugins/__tests__/cold-plugin.fixture';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

const SECRET = 'sk-account-secret-cold';

function response(): ChatCompletionResponse {
    return {
        id: 'r',
        created: 0,
        model: 'provider-model',
        choices: [
            {
                index: 0,
                message: { role: 'assistant', content: 'hi' },
                finishReason: 'stop',
            },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    } as ChatCompletionResponse;
}

/**
 * Model accounts (AW-16) lay an account's credentials over exactly the
 * settings the provider's schema marks `x-secret` (`secretSettingKeys` in
 * ai.facade.ts). For an AI provider the registry still holds as a COLD lazy
 * proxy, that schema is `{}` until the plugin loads: the facade must read it
 * from the loaded plugin, or the account's key is silently dropped.
 */
describe('AiFacadeService — model account over a cold lazy AI provider', () => {
    it("lays the account's key over the cold provider's x-secret setting", async () => {
        const registry = createRegistry();
        const createChatCompletion = jest.fn().mockResolvedValue(response());
        registerColdPlugin(registry, {
            id: 'cold-ai',
            category: 'ai-provider',
            capabilities: ['ai-provider'],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
            members: {
                providerName: 'Cold AI',
                isAvailable: async () => true,
                createChatCompletion,
                getCapabilities: () => ({
                    supportsStructuredOutput: true,
                    supportsStreaming: true,
                    supportsToolCalling: true,
                    supportsVision: false,
                    maxContextLength: 1000,
                }),
            },
        });
        const planner = {
            plan: jest.fn().mockResolvedValue({
                workspaceKey: 'org:o1',
                primarySource: 'default',
                reasoningEffort: 'medium',
                runTimeoutSeconds: 900,
                accountsAvailable: true,
            }),
            selectAccount: jest.fn().mockResolvedValue({
                accountId: 'acc-1',
                label: 'Company key',
                credentials: { apiKey: SECRET },
            }),
            recordAnswer: jest.fn().mockResolvedValue(undefined),
            reportFailure: jest.fn().mockResolvedValue(undefined),
        } as unknown as ModelRoutePlanner;
        const settings = {
            getSettings: jest.fn().mockResolvedValue({ apiKey: 'sk-platform-key' }),
            getResolvedSettings: jest.fn().mockResolvedValue({}),
        };
        const facade = new AiFacadeService(
            registry,
            settings as unknown as PluginSettingsService,
            {
                findActiveByCapability: jest.fn().mockResolvedValue(null),
            } as unknown as WorkPluginRepository,
            { record: jest.fn().mockResolvedValue(null) } as unknown as PluginUsageService,
            {
                checkBudget: jest.fn().mockResolvedValue(undefined),
            } as unknown as BudgetGuardService,
            planner,
        );

        await facade.createChatCompletion(
            { messages: [{ role: 'user', content: 'hello' }] },
            { userId: 'user-1' },
        );

        expect(createChatCompletion).toHaveBeenCalledTimes(1);
        expect(createChatCompletion.mock.calls[0][0].settings).toMatchObject({ apiKey: SECRET });
    });
});
