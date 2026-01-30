import { Injectable, Logger } from '@nestjs/common';
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
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';

/**
 * AI Facade Error Base
 */
export class AiFacadeError extends Error {
    constructor(
        message: string,
        public readonly operation: string,
        public readonly provider?: string,
        public readonly cause?: Error,
    ) {
        super(message);
        this.name = 'AiFacadeError';
    }
}

/**
 * No AI provider configured error
 */
export class NoAiProviderError extends AiFacadeError {
    constructor() {
        super('No AI provider configured or available', 'getPlugin');
        this.name = 'NoAiProviderError';
    }
}

/**
 * AI provider not found error
 */
export class AiProviderNotFoundError extends AiFacadeError {
    constructor(providerId: string) {
        super(`AI provider not found: ${providerId}`, 'getPlugin', providerId);
        this.name = 'AiProviderNotFoundError';
    }
}

/**
 * Facade options for provider resolution
 */
export interface AiFacadeOptions {
    /** User ID for settings resolution */
    userId?: string;
    /** Directory ID for settings resolution */
    directoryId?: string;
    /** Override provider (plugin ID) */
    providerOverride?: string;
}

/**
 * AI Facade service for pipeline steps.
 *
 * Uses the plugin registry to dynamically resolve AI providers.
 * Supports 4-level settings resolution hierarchy:
 * 1. Directory settings
 * 2. User settings
 * 3. Admin settings
 * 4. Plugin defaults
 */
@Injectable()
export class AiFacadeService implements IAiFacade {
    private readonly logger = new Logger(AiFacadeService.name);
    private readonly CAPABILITY = 'ai-provider';

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly settingsService: PluginSettingsService,
    ) {}

    /**
     * Send a prompt and get a structured JSON response.
     * Uses the plugin registry to resolve the AI provider.
     *
     * Model routing resolution order:
     * 1. Explicit modelOverride in routing options
     * 2. Complexity-based model from settings (simpleModel, mediumModel, complexModel)
     * 3. Default model from settings
     * 4. Plugin's default model (undefined - plugin decides)
     */
    async askJson<T>(
        promptTemplate: string,
        schema: z.ZodSchema<T>,
        options?: AskJsonOptions,
        facadeOptions?: AiFacadeOptions,
    ): Promise<AskJsonResponse<T>> {
        // Resolve which plugin to use
        const plugin = await this.resolvePlugin(
            options?.routing?.providerOverride,
            facadeOptions?.userId,
            facadeOptions?.directoryId,
        );

        // Get resolved settings for the plugin (includes model routing config)
        const settings = await this.settingsService.getSettings(plugin.id, {
            userId: facadeOptions?.userId,
            directoryId: facadeOptions?.directoryId,
            includeSecrets: true,
        });

        // Resolve model based on complexity or override
        const model = this.resolveModel(plugin, settings, options?.routing);

        // Render template variables
        const prompt = this.renderTemplate(promptTemplate, options?.variables);

        // Build completion options with settings for plugin to use
        const completionOptions: ChatCompletionOptions = {
            model, // Pass resolved model to plugin
            messages: [{ role: 'user', content: prompt }],
            temperature: options?.temperature ?? 0.7,
            responseFormat: { type: 'json_object' },
            jsonSchema: this.zodToJsonSchema(schema),
            settings, // Pass resolved settings to plugin
        };

        // Call the AI provider plugin
        const response = await plugin.createChatCompletion(completionOptions);

        // Parse response
        const content = response.choices[0]?.message?.content;
        if (!content || typeof content !== 'string') {
            throw new AiFacadeError('No content in AI response', 'askJson', plugin.id);
        }

        // Parse and validate JSON response
        let parsed: unknown;
        try {
            parsed = JSON.parse(content);
        } catch (e) {
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

        // Calculate cost based on model pricing
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

    /**
     * Calculate cost based on model pricing and token usage.
     * Returns null if pricing info is not available.
     */
    private async calculateCost(
        plugin: IAiProviderPlugin,
        modelId: string,
        usage?: { promptTokens: number; completionTokens: number; totalTokens: number },
    ): Promise<number | null> {
        if (!usage) {
            return null;
        }

        try {
            const modelInfo = await plugin.getModel(modelId);
            if (!modelInfo || !modelInfo.inputCostPer1k || !modelInfo.outputCostPer1k) {
                return null;
            }

            const inputCost = (usage.promptTokens * modelInfo.inputCostPer1k) / 1000;
            const outputCost = (usage.completionTokens * modelInfo.outputCostPer1k) / 1000;

            return inputCost + outputCost;
        } catch {
            // Model info not available, return null
            return null;
        }
    }

    /**
     * Check if any AI provider plugin is configured and available.
     */
    isConfigured(): boolean {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.length > 0 && plugins.some((p) => p.state === 'enabled');
    }

    /**
     * Test the AI provider connection.
     */
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

    /**
     * Get all available AI provider plugins.
     */
    getAvailableProviders(): Array<{
        id: string;
        name: string;
        enabled: boolean;
    }> {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => ({
            id: p.plugin.id,
            name: (p.plugin as IAiProviderPlugin).providerName,
            enabled: p.state === 'enabled',
        }));
    }

    /**
     * Resolve which AI provider plugin to use.
     *
     * Resolution order:
     * 1. providerOverride (explicit request)
     * 2. Directory default provider (if directoryId provided)
     * 3. User default provider (if userId provided)
     * 4. First enabled AI provider
     */
    private async resolvePlugin(
        providerOverride?: string,
        userId?: string,
        directoryId?: string,
    ): Promise<IAiProviderPlugin> {
        // If explicit override, use it
        if (providerOverride) {
            const registered = this.registry.get(providerOverride);
            if (
                registered &&
                registered.manifest.capabilities.includes(this.CAPABILITY) &&
                registered.state === 'enabled'
            ) {
                return registered.plugin as IAiProviderPlugin;
            }
            throw new AiProviderNotFoundError(providerOverride);
        }

        // Check directory-level default provider from settings
        if (directoryId) {
            const directoryProvider = await this.getDefaultProviderFromSettings(
                directoryId,
                userId,
                'directory',
            );
            if (directoryProvider) {
                return directoryProvider;
            }
        }

        // Check user-level default provider from settings
        if (userId) {
            const userProvider = await this.getDefaultProviderFromSettings(
                undefined,
                userId,
                'user',
            );
            if (userProvider) {
                return userProvider;
            }
        }

        // Fall back to first enabled AI provider
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        const enabled = plugins.find((p) => p.state === 'enabled');

        if (enabled) {
            return enabled.plugin as IAiProviderPlugin;
        }

        throw new NoAiProviderError();
    }

    /**
     * Get default AI provider from settings at a specific scope.
     * The 'defaultAiProvider' setting can be set at directory or user level.
     */
    private async getDefaultProviderFromSettings(
        directoryId?: string,
        userId?: string,
        scope?: 'directory' | 'user',
    ): Promise<IAiProviderPlugin | null> {
        // Get all enabled AI providers
        const aiProviders = this.registry.getByCapability(this.CAPABILITY);
        const enabledProviders = aiProviders.filter((p) => p.state === 'enabled');

        if (enabledProviders.length === 0) {
            return null;
        }

        // Check each provider's settings for the scope-specific default
        for (const registered of enabledProviders) {
            try {
                const settings = await this.settingsService.getSettings(registered.plugin.id, {
                    userId,
                    directoryId,
                    includeSecrets: false,
                });

                // Check if this provider is marked as default at the requested scope
                const isDefault = settings['isDefault'] as boolean | undefined;
                if (isDefault) {
                    this.logger.debug(
                        `Using ${scope}-level default AI provider: ${registered.plugin.id}`,
                    );
                    return registered.plugin as IAiProviderPlugin;
                }
            } catch {
                // Continue checking other providers
            }
        }

        // Also check for a global 'defaultAiProvider' setting that specifies provider ID
        // This is stored at platform settings level (scope: admin/user/directory)
        try {
            // Try to get platform-level AI settings (provider ID stored directly)
            // We check if any provider matches the stored defaultAiProvider setting
            const firstProvider = enabledProviders[0];
            const settings = await this.settingsService.getSettings(firstProvider.plugin.id, {
                userId,
                directoryId,
                includeSecrets: false,
            });

            const defaultProviderId = settings['defaultAiProvider'] as string | undefined;
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
            // No default provider configured at this scope
        }

        return null;
    }

    /**
     * Get available models from the configured AI provider.
     * Used by UI to populate model selection dropdowns for routing configuration.
     */
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

    /**
     * Resolve which model to use based on routing options and settings.
     *
     * Resolution order:
     * 1. Explicit modelOverride in routing options
     * 2. Complexity-based model from settings (simpleModel, mediumModel, complexModel)
     * 3. Default model from settings
     * 4. Plugin's default model (returns undefined, plugin uses its default)
     */
    private resolveModel(
        plugin: IAiProviderPlugin,
        settings: Record<string, unknown>,
        routing?: AiRoutingOptions,
    ): string | undefined {
        // 1. Explicit model override
        if (routing?.modelOverride) {
            this.logger.debug(`Using model override: ${routing.modelOverride}`);
            return routing.modelOverride;
        }

        // 2. Complexity-based routing from settings
        if (routing?.complexity) {
            const complexityModelKey = `${routing.complexity}Model`; // e.g., 'simpleModel'
            const complexityModel = settings[complexityModelKey] as string | undefined;
            if (complexityModel) {
                this.logger.debug(
                    `Using ${routing.complexity} model for plugin ${plugin.id}: ${complexityModel}`,
                );
                return complexityModel;
            }
        }

        // 3. Default model from settings
        const defaultModel = settings['defaultModel'] as string | undefined;
        if (defaultModel) {
            this.logger.debug(`Using default model from settings: ${defaultModel}`);
            return defaultModel;
        }

        // 4. Let plugin decide (returns undefined, plugin uses its default)
        this.logger.debug(`No model routing configured, plugin ${plugin.id} will use default`);
        return undefined;
    }

    /**
     * Render template with variables.
     */
    private renderTemplate(template: string, variables?: Record<string, string>): string {
        if (!variables) {
            return template;
        }
        return template.replace(/\{(\w+)\}/g, (match, key) => {
            const value = variables[key];
            return value !== undefined ? value : match;
        });
    }

    /**
     * Convert Zod schema to JSON Schema for structured output.
     */
    private zodToJsonSchema(schema: z.ZodSchema): Record<string, unknown> {
        // Use zod-to-json-schema or manual conversion
        // For now, return a simplified version
        try {
            // Try to use zod's built-in JSON schema generation
            const zodToJsonSchema = require('zod-to-json-schema').zodToJsonSchema;
            return zodToJsonSchema(schema);
        } catch {
            // Fallback: return empty schema
            return { type: 'object' };
        }
    }
}
