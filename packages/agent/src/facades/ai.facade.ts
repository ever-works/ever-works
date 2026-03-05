import { Injectable, Logger, Optional } from '@nestjs/common';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
    AskJsonOptions,
    AskJsonResponse,
    IAiProviderPlugin,
    ChatCompletionOptions,
    ChatCompletionResponse,
    ChatCompletionChunk,
    AiRoutingOptions,
    AiModel,
    AiProviderConfig,
    IAiFacade,
    FacadeOptions,
    AskJsonCompletionResponse,
    TaskComplexity,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES, substituteVariables } from '@ever-works/plugin';
import { jsonrepair } from '@ever-works/plugin/ai';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { DirectoryPluginRepository } from '../plugins/repositories/directory-plugin.repository';
import { BaseFacadeService, FacadeError } from './base.facade';
import { fetchOpenRouterModels, fuzzyMatchModel } from './openrouter-model-lookup';
import type { OpenRouterModelEntry } from './openrouter-model-lookup';

export class AiFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'AiFacadeError';
    }
}

@Injectable()
export class AiFacadeService extends BaseFacadeService implements IAiFacade {
    protected readonly logger = new Logger(AiFacadeService.name);
    protected readonly CAPABILITY = PLUGIN_CAPABILITIES.AI_PROVIDER;

    private static readonly CACHE_TTL = 3_600_000; // 1 hour
    private static readonly DEFAULT_CONTEXT = 128_000;
    private openRouterModels: readonly OpenRouterModelEntry[] | null = null;
    private openRouterCacheTime = 0;

    constructor(
        registry: PluginRegistryService,
        settingsService: PluginSettingsService,
        @Optional() directoryPluginRepository?: DirectoryPluginRepository,
    ) {
        super(registry, settingsService, directoryPluginRepository);
    }

    async askJson<T, Template extends string = string>(
        promptTemplate: Template,
        schema: z.ZodSchema<T>,
        options: AskJsonOptions<Template> | undefined,
        facadeOptions: FacadeOptions,
    ): Promise<AskJsonResponse<T>> {
        const plugin = await this.resolvePlugin<IAiProviderPlugin>(
            options?.routing?.providerOverride ?? facadeOptions.providerOverride,
            facadeOptions.userId,
            facadeOptions.directoryId,
        );

        const settings = await this.getResolvedSettings(plugin.id, {
            userId: facadeOptions.userId,
            directoryId: facadeOptions.directoryId,
        });

        const model = this.resolveModel(plugin, settings, options?.routing);
        const prompt = substituteVariables(promptTemplate, options?.variables);

        const call = (callModel?: string) =>
            this.callAskJson(plugin, prompt, schema, {
                model: callModel ?? model,
                temperature: options?.temperature ?? 0.7,
                settings,
            });

        const response = await this.withEscalation(call, settings, model, options?.routing);

        const validated = schema.safeParse(response.result);
        if (!validated.success) {
            throw new AiFacadeError(
                `AI response validation failed: ${validated.error.message}`,
                'askJson',
                plugin.id,
            );
        }

        const cost = await this.calculateCost(plugin, response.model, response.usage, settings);

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

    /** Use plugin.askJson (efficient) or fall back to createChatCompletion + JSON parse */
    private async callAskJson(
        plugin: IAiProviderPlugin,
        prompt: string,
        schema: z.ZodSchema,
        opts: { model?: string; temperature: number; settings: Record<string, unknown> },
    ): Promise<AskJsonCompletionResponse> {
        if (plugin.askJson) {
            return plugin.askJson(prompt, {
                model: opts.model,
                temperature: opts.temperature,
                schema,
                settings: opts.settings,
            });
        }

        // Fallback for plugins without askJson
        const jsonSchema = JSON.stringify(zodToJsonSchema(schema));
        const response = await plugin.createChatCompletion({
            model: opts.model,
            messages: [
                {
                    role: 'system',
                    content: `Respond with valid JSON matching this schema: ${jsonSchema}`,
                },
                { role: 'user', content: prompt },
            ],
            temperature: opts.temperature,
            responseFormat: { type: 'json_object' },
            settings: opts.settings,
        });

        const content = response.choices[0]?.message?.content;
        if (!content || typeof content !== 'string') {
            throw new AiFacadeError('No content in AI response', 'askJson', plugin.id);
        }

        try {
            const parsed = JSON.parse(jsonrepair(content));
            return {
                result: schema.parse(parsed),
                model: response.model,
                usage: response.usage,
            };
        } catch (error) {
            throw new AiFacadeError(
                `Failed to parse AI response as JSON: ${error instanceof Error ? error.message : error}`,
                'askJson',
                plugin.id,
            );
        }
    }

    /** Retry with a higher-complexity model on failure when autoEscalate is enabled */
    private async withEscalation(
        call: (model?: string) => Promise<AskJsonCompletionResponse>,
        settings: Record<string, unknown>,
        currentModel: string | undefined,
        routing?: AiRoutingOptions,
    ): Promise<AskJsonCompletionResponse> {
        try {
            return await call();
        } catch (error) {
            if (routing?.autoEscalate !== false && routing?.complexity) {
                const escalated = this.escalateModel(settings, routing.complexity);
                if (escalated && escalated !== currentModel) {
                    this.logger.warn(
                        `Escalating from ${currentModel ?? 'default'} to ${escalated}`,
                    );
                    return call(escalated);
                }
            }
            throw error;
        }
    }

    /** Find the next higher-complexity model from settings */
    private escalateModel(
        settings: Record<string, unknown>,
        currentComplexity: TaskComplexity,
    ): string | undefined {
        const tiers: TaskComplexity[] = ['simple', 'medium', 'complex'];
        const currentIndex = tiers.indexOf(currentComplexity);

        for (let i = currentIndex + 1; i < tiers.length; i++) {
            const model = this.getSettingTyped<string>(settings, `${tiers[i]}Model`, 'string');
            if (model) return model;
        }
        return undefined;
    }

    private async calculateCost(
        plugin: IAiProviderPlugin,
        modelId: string,
        usage?: { promptTokens: number; completionTokens: number; totalTokens: number },
        settings?: Record<string, unknown>,
    ): Promise<number | null> {
        if (!usage) return null;

        try {
            const modelInfo = await plugin.getModel(modelId, settings);
            if (!modelInfo?.inputCostPer1k || !modelInfo?.outputCostPer1k) return null;

            const inputCost = (usage.promptTokens * modelInfo.inputCostPer1k) / 1000;
            const outputCost = (usage.completionTokens * modelInfo.outputCostPer1k) / 1000;
            return inputCost + outputCost;
        } catch {
            return null;
        }
    }

    async createChatCompletion(
        options: ChatCompletionOptions,
        facadeOptions: FacadeOptions,
    ): Promise<ChatCompletionResponse> {
        const plugin = await this.resolvePlugin<IAiProviderPlugin>(
            facadeOptions.providerOverride,
            facadeOptions.userId,
            facadeOptions.directoryId,
        );

        const settings = await this.getResolvedSettings(plugin.id, {
            userId: facadeOptions.userId,
            directoryId: facadeOptions.directoryId,
        });

        const model = this.resolveModel(plugin, settings, options as unknown as AiRoutingOptions);
        const mergedOptions: ChatCompletionOptions = {
            ...options,
            model: options.model ?? model,
            settings,
        };

        return plugin.createChatCompletion(mergedOptions);
    }

    async *createStreamingChatCompletion(
        options: ChatCompletionOptions,
        facadeOptions: FacadeOptions,
    ): AsyncGenerator<ChatCompletionChunk> {
        const plugin = await this.resolvePlugin<IAiProviderPlugin>(
            facadeOptions.providerOverride,
            facadeOptions.userId,
            facadeOptions.directoryId,
        );

        const settings = await this.getResolvedSettings(plugin.id, {
            userId: facadeOptions.userId,
            directoryId: facadeOptions.directoryId,
        });

        const model = this.resolveModel(plugin, settings, options as unknown as AiRoutingOptions);
        const mergedOptions: ChatCompletionOptions = {
            ...options,
            model: options.model ?? model,
            stream: true,
            settings,
        };

        if (!plugin.createStreamingChatCompletion) {
            throw new AiFacadeError(
                `Provider ${plugin.id} does not support streaming`,
                'createStreamingChatCompletion',
                plugin.id,
            );
        }

        yield* plugin.createStreamingChatCompletion(mergedOptions);
    }

    async testConnection(facadeOptions: FacadeOptions): Promise<{
        success: boolean;
        provider: string;
        model: string;
        responseTime: number;
        error?: string;
    }> {
        const startTime = Date.now();

        try {
            const plugin = await this.resolvePlugin<IAiProviderPlugin>(
                facadeOptions.providerOverride,
                facadeOptions.userId,
                facadeOptions.directoryId,
            );

            const settings = await this.getResolvedSettings(plugin.id, facadeOptions);
            const isAvailable = await plugin.isAvailable(settings);

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

    async getAvailableModels(facadeOptions: FacadeOptions): Promise<readonly AiModel[]> {
        try {
            const plugin = await this.resolvePlugin<IAiProviderPlugin>(
                facadeOptions.providerOverride,
                facadeOptions.userId,
                facadeOptions.directoryId,
            );
            const settings = await this.getResolvedSettings(plugin.id, facadeOptions);
            return await plugin.listModels(settings);
        } catch (error) {
            this.logger.warn(`Failed to get available models: ${(error as Error).message}`);
            return [];
        }
    }

    async getProviderConfig(facadeOptions: FacadeOptions): Promise<AiProviderConfig> {
        const plugin = await this.resolvePlugin<IAiProviderPlugin>(
            facadeOptions.providerOverride,
            facadeOptions.userId,
            facadeOptions.directoryId,
        );

        const settings = await this.getResolvedSettings(plugin.id, {
            userId: facadeOptions.userId,
            directoryId: facadeOptions.directoryId,
        });

        return {
            providerId: plugin.id,
            providerName: plugin.providerName,
            baseUrl: this.getSettingTyped<string>(settings, 'baseUrl', 'string'),
            apiKey: this.getSettingTyped<string>(settings, 'apiKey', 'string'),
            defaultModel: this.getSettingTyped<string>(settings, 'defaultModel', 'string'),
            routing: {
                simpleModel: this.getSettingTyped<string>(settings, 'simpleModel', 'string'),
                mediumModel: this.getSettingTyped<string>(settings, 'mediumModel', 'string'),
                complexModel: this.getSettingTyped<string>(settings, 'complexModel', 'string'),
            },
        };
    }

    async resolveModelContextLength(
        modelId: string,
        _facadeOptions: FacadeOptions,
    ): Promise<number> {
        try {
            const models = await this.getCachedOpenRouterModels();
            if (!models) return AiFacadeService.DEFAULT_CONTEXT;

            const match = fuzzyMatchModel(modelId, models);
            if (match?.context_length && match.context_length > 0) {
                this.logger.debug(
                    `Context length for "${modelId}": ${match.context_length} (matched "${match.id}")`,
                );
                return match.context_length;
            }

            return AiFacadeService.DEFAULT_CONTEXT;
        } catch {
            return AiFacadeService.DEFAULT_CONTEXT;
        }
    }

    private async getCachedOpenRouterModels(): Promise<readonly OpenRouterModelEntry[] | null> {
        const now = Date.now();
        if (this.openRouterModels && now - this.openRouterCacheTime < AiFacadeService.CACHE_TTL) {
            return this.openRouterModels;
        }

        const fresh = await fetchOpenRouterModels();
        if (fresh) {
            this.openRouterModels = fresh;
            this.openRouterCacheTime = now;
        }

        // Stale-while-revalidate: return cached data if fresh fetch failed
        return this.openRouterModels;
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
}
