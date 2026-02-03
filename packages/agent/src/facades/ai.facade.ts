import { Injectable, Logger, Optional } from '@nestjs/common';
import { z } from 'zod';
import type {
    IAiFacade,
    AskJsonOptions,
    AskJsonResponse,
    IAiProviderPlugin,
    ChatCompletionOptions,
    AiRoutingOptions,
    AiModel,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { DirectoryPluginRepository } from '../plugins/repositories/directory-plugin.repository';
import {
    BaseFacadeService,
    FacadeError,
    NoProviderError,
    ProviderNotFoundError,
} from './base.facade';

export class AiFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'AiFacadeError';
    }
}

export class NoAiProviderError extends NoProviderError {
    constructor() {
        super('AI');
        this.name = 'NoAiProviderError';
    }
}

export class AiProviderNotFoundError extends ProviderNotFoundError {
    constructor(providerId: string) {
        super(providerId, 'AI');
        this.name = 'AiProviderNotFoundError';
    }
}

export interface AiFacadeOptions {
    userId?: string;
    directoryId?: string;
    providerOverride?: string;
}

@Injectable()
export class AiFacadeService extends BaseFacadeService implements IAiFacade {
    protected readonly logger = new Logger(AiFacadeService.name);
    protected readonly CAPABILITY = PLUGIN_CAPABILITIES.AI_PROVIDER;

    constructor(
        registry: PluginRegistryService,
        settingsService: PluginSettingsService,
        @Optional() directoryPluginRepository?: DirectoryPluginRepository,
    ) {
        super(registry, settingsService, directoryPluginRepository);
    }

    async askJson<T>(
        promptTemplate: string,
        schema: z.ZodSchema<T>,
        options?: AskJsonOptions,
        facadeOptions?: AiFacadeOptions,
    ): Promise<AskJsonResponse<T>> {
        const plugin = await this.resolvePlugin(
            options?.routing?.providerOverride,
            facadeOptions?.userId,
            facadeOptions?.directoryId,
        );

        const settings = await this.getResolvedSettings(plugin.id, {
            userId: facadeOptions?.userId,
            directoryId: facadeOptions?.directoryId,
        });

        const model = this.resolveModel(plugin, settings, options?.routing);
        const prompt = this.renderTemplate(promptTemplate, options?.variables);

        const completionOptions: ChatCompletionOptions = {
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: options?.temperature ?? 0.7,
            responseFormat: { type: 'json_object' },
            jsonSchema: this.zodToJsonSchema(schema),
            settings,
        };

        const response = await plugin.createChatCompletion(completionOptions);
        const content = response.choices[0]?.message?.content;
        if (!content || typeof content !== 'string') {
            throw new AiFacadeError('No content in AI response', 'askJson', plugin.id);
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(content);
        } catch {
            throw new AiFacadeError('Failed to parse AI response as JSON', 'askJson', plugin.id);
        }

        const validated = schema.safeParse(parsed);
        if (!validated.success) {
            throw new AiFacadeError(
                `AI response validation failed: ${validated.error.message}`,
                'askJson',
                plugin.id,
            );
        }

        const cost = await this.calculateCost(plugin, response.model, response.usage);

        return {
            result: validated.data,
            usage: response.usage
                ? {
                      inputTokens: response.usage.promptTokens,
                      outputTokens: response.usage.completionTokens,
                      totalTokens: response.usage.totalTokens,
                  }
                : null,
            cost,
            provider: plugin.id,
            model: response.model,
        };
    }

    private async calculateCost(
        plugin: IAiProviderPlugin,
        modelId: string,
        usage?: { promptTokens: number; completionTokens: number; totalTokens: number },
    ): Promise<number | null> {
        if (!usage) return null;

        try {
            const modelInfo = await plugin.getModel(modelId);
            if (!modelInfo?.inputCostPer1k || !modelInfo?.outputCostPer1k) return null;

            const inputCost = (usage.promptTokens * modelInfo.inputCostPer1k) / 1000;
            const outputCost = (usage.completionTokens * modelInfo.outputCostPer1k) / 1000;
            return inputCost + outputCost;
        } catch {
            return null;
        }
    }

    async testConnection(facadeOptions?: AiFacadeOptions): Promise<{
        success: boolean;
        provider: string;
        model: string;
        responseTime: number;
        error?: string;
    }> {
        const startTime = Date.now();

        try {
            const plugin = await this.resolvePlugin(
                facadeOptions?.providerOverride,
                facadeOptions?.userId,
                facadeOptions?.directoryId,
            );

            const isAvailable = await plugin.isAvailable();

            return {
                success: isAvailable,
                provider: plugin.id,
                model: plugin.providerName,
                responseTime: Date.now() - startTime,
                error: isAvailable ? undefined : 'Provider not available',
            };
        } catch (error) {
            return {
                success: false,
                provider: 'unknown',
                model: 'unknown',
                responseTime: Date.now() - startTime,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    override getAvailableProviders(): Array<{ id: string; name: string; enabled: boolean }> {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => ({
            id: p.plugin.id,
            name: (p.plugin as IAiProviderPlugin).providerName,
            enabled: p.state === 'enabled',
        }));
    }

    // Resolve AI provider: providerOverride > directory default > user default > first enabled
    private async resolvePlugin(
        providerOverride?: string,
        userId?: string,
        directoryId?: string,
    ): Promise<IAiProviderPlugin> {
        if (providerOverride) {
            const registered = this.registry.get(providerOverride);
            if (
                registered &&
                registered.manifest.capabilities.includes(this.CAPABILITY) &&
                registered.state === 'enabled'
            ) {
                const isEnabled = await this.isPluginEnabled(providerOverride, directoryId, userId);
                if (isEnabled) return registered.plugin as IAiProviderPlugin;
            }
            throw new AiProviderNotFoundError(providerOverride);
        }

        if (directoryId) {
            const directoryProvider = await this.getDefaultProviderFromSettings(
                directoryId,
                userId,
                'directory',
            );
            if (directoryProvider) return directoryProvider;
        }

        if (userId) {
            const userProvider = await this.getDefaultProviderFromSettings(
                undefined,
                userId,
                'user',
            );
            if (userProvider) return userProvider;
        }

        const plugins = this.registry.getByCapability(this.CAPABILITY);
        for (const registered of plugins) {
            if (registered.state !== 'enabled') continue;
            const isEnabled = await this.isPluginEnabled(registered.plugin.id, directoryId, userId);
            if (isEnabled) return registered.plugin as IAiProviderPlugin;
        }

        throw new NoAiProviderError();
    }

    private async getDefaultProviderFromSettings(
        directoryId?: string,
        userId?: string,
        scope?: 'directory' | 'user',
    ): Promise<IAiProviderPlugin | null> {
        const aiProviders = this.registry.getByCapability(this.CAPABILITY);
        const enabledProviders = aiProviders.filter((p) => p.state === 'enabled');

        if (enabledProviders.length === 0) return null;

        // Check for isDefault setting on each provider
        for (const registered of enabledProviders) {
            try {
                const settings = await this.getResolvedSettings(registered.plugin.id, {
                    userId,
                    directoryId,
                });

                const isDefault = this.getSettingTyped<boolean>(settings, 'isDefault', 'boolean');
                if (isDefault) {
                    this.logger.debug(
                        `Using ${scope}-level default AI provider: ${registered.plugin.id}`,
                    );
                    return registered.plugin as IAiProviderPlugin;
                }
            } catch {
                // Continue
            }
        }

        // Check for defaultAiProvider setting
        try {
            const firstProvider = enabledProviders[0];
            const settings = await this.getResolvedSettings(firstProvider.plugin.id, {
                userId,
                directoryId,
            });

            const defaultProviderId = this.getSettingTyped<string>(
                settings,
                'defaultAiProvider',
                'string',
            );
            if (defaultProviderId) {
                const defaultProvider = enabledProviders.find(
                    (p) => p.plugin.id === defaultProviderId,
                );
                if (defaultProvider) {
                    this.logger.debug(
                        `Using ${scope}-level defaultAiProvider setting: ${defaultProviderId}`,
                    );
                    return defaultProvider.plugin as IAiProviderPlugin;
                }
            }
        } catch {
            // Continue
        }

        return null;
    }

    async getAvailableModels(facadeOptions?: AiFacadeOptions): Promise<readonly AiModel[]> {
        try {
            const plugin = await this.resolvePlugin(
                facadeOptions?.providerOverride,
                facadeOptions?.userId,
                facadeOptions?.directoryId,
            );
            return await plugin.listModels();
        } catch (error) {
            this.logger.warn(`Failed to get available models: ${(error as Error).message}`);
            return [];
        }
    }

    // Resolve model: modelOverride > complexity-based > defaultModel > plugin default
    private resolveModel(
        plugin: IAiProviderPlugin,
        settings: Record<string, unknown>,
        routing?: AiRoutingOptions,
    ): string | undefined {
        if (routing?.modelOverride) {
            this.logger.debug(`Using model override: ${routing.modelOverride}`);
            return routing.modelOverride;
        }

        if (routing?.complexity) {
            const complexityModelKey = `${routing.complexity}Model`;
            const complexityModel = this.getSettingTyped<string>(
                settings,
                complexityModelKey,
                'string',
            );
            if (complexityModel) {
                this.logger.debug(
                    `Using ${routing.complexity} model for plugin ${plugin.id}: ${complexityModel}`,
                );
                return complexityModel;
            }
        }

        const defaultModel = this.getSettingTyped<string>(settings, 'defaultModel', 'string');
        if (defaultModel) {
            this.logger.debug(`Using default model from settings: ${defaultModel}`);
            return defaultModel;
        }

        this.logger.debug(`No model routing configured, plugin ${plugin.id} will use default`);
        return undefined;
    }

    private renderTemplate(template: string, variables?: Record<string, string>): string {
        if (!variables) return template;
        return template.replace(/\{(\w+)\}/g, (match, key) => {
            const value = variables[key];
            return value !== undefined ? value : match;
        });
    }

    private zodToJsonSchema(schema: z.ZodSchema): Record<string, unknown> {
        try {
            const zodToJsonSchema = require('zod-to-json-schema').zodToJsonSchema;
            return zodToJsonSchema(schema);
        } catch {
            return { type: 'object' };
        }
    }
}
