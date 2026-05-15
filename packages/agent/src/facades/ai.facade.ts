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
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { PluginUsageService } from '../usage/plugin-usage.service';
import { PluginUsageCapability } from '@src/entities/plugin-usage-event.entity';
import { BaseFacadeService, FacadeError } from './base.facade';
import { fetchModelCatalog, matchModelCatalogEntry } from './model-catalog';
import type { ModelCatalogEntry } from './model-catalog';

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
    private modelCatalog: readonly ModelCatalogEntry[] | null = null;
    private modelCatalogCacheTime = 0;

    constructor(
        registry: PluginRegistryService,
        settingsService: PluginSettingsService,
        @Optional() workPluginRepository?: WorkPluginRepository,
        @Optional() private readonly pluginUsageService?: PluginUsageService,
    ) {
        super(registry, settingsService, workPluginRepository);
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
            facadeOptions.workId,
        );

        const settings = await this.getResolvedSettings(plugin.id, {
            userId: facadeOptions.userId,
            workId: facadeOptions.workId,
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

        await this.pluginUsageService?.record({
            workId: facadeOptions.workId,
            userId: facadeOptions.userId,
            pluginId: plugin.id,
            capability: PluginUsageCapability.AI,
            units: response.usage?.totalTokens ?? 1,
            costCents: cost != null ? cost * 100 : 0,
            modelId: response.model,
            metadata: {
                operation: 'askJson',
                promptTokens: response.usage?.promptTokens,
                completionTokens: response.usage?.completionTokens,
            },
        });

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
            const modelInfo = await this.resolveModelMetadataForPlugin(plugin, modelId, settings);
            if (
                typeof modelInfo?.inputCostPer1k !== 'number' ||
                typeof modelInfo?.outputCostPer1k !== 'number'
            ) {
                return null;
            }

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
            facadeOptions.workId,
        );

        const settings = await this.getResolvedSettings(plugin.id, {
            userId: facadeOptions.userId,
            workId: facadeOptions.workId,
        });

        const model = this.resolveModel(plugin, settings, options as unknown as AiRoutingOptions);
        const mergedOptions: ChatCompletionOptions = {
            ...options,
            model: options.model ?? model,
            settings,
        };

        const response = await plugin.createChatCompletion(mergedOptions);

        const cost = await this.calculateCost(plugin, response.model, response.usage, settings);
        await this.pluginUsageService?.record({
            workId: facadeOptions.workId,
            userId: facadeOptions.userId,
            pluginId: plugin.id,
            capability: PluginUsageCapability.AI,
            units: response.usage?.totalTokens ?? 1,
            costCents: cost != null ? cost * 100 : 0,
            modelId: response.model,
            metadata: {
                operation: 'createChatCompletion',
                promptTokens: response.usage?.promptTokens,
                completionTokens: response.usage?.completionTokens,
            },
        });

        return response;
    }

    async *createStreamingChatCompletion(
        options: ChatCompletionOptions,
        facadeOptions: FacadeOptions,
    ): AsyncGenerator<ChatCompletionChunk> {
        const plugin = await this.resolvePlugin<IAiProviderPlugin>(
            facadeOptions.providerOverride,
            facadeOptions.userId,
            facadeOptions.workId,
        );

        const settings = await this.getResolvedSettings(plugin.id, {
            userId: facadeOptions.userId,
            workId: facadeOptions.workId,
        });

        const model = this.resolveModel(plugin, settings, options as unknown as AiRoutingOptions);
        const mergedOptions: ChatCompletionOptions = {
            ...options,
            model: options.model ?? model,
            stream: true,
            settings,
        };

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
                facadeOptions.workId,
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
                facadeOptions.workId,
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
            facadeOptions.workId,
        );

        const settings = await this.getResolvedSettings(plugin.id, {
            userId: facadeOptions.userId,
            workId: facadeOptions.workId,
        });

        const apiKey = this.getSettingTyped<string>(settings, 'apiKey', 'string');

        return {
            providerId: plugin.id,
            providerName: plugin.providerName,
            baseUrl: this.getSettingTyped<string>(settings, 'baseUrl', 'string'),
            apiKey,
            defaultModel: this.getSettingTyped<string>(settings, 'defaultModel', 'string'),
            routing: {
                simpleModel: this.getSettingTyped<string>(settings, 'simpleModel', 'string'),
                mediumModel: this.getSettingTyped<string>(settings, 'mediumModel', 'string'),
                complexModel: this.getSettingTyped<string>(settings, 'complexModel', 'string'),
            },
        };
    }

    async resolveModelMetadata(
        modelId: string,
        facadeOptions: FacadeOptions,
    ): Promise<AiModel | null> {
        try {
            const plugin = await this.resolvePlugin<IAiProviderPlugin>(
                facadeOptions.providerOverride,
                facadeOptions.userId,
                facadeOptions.workId,
            );

            const settings = await this.getResolvedSettings(plugin.id, {
                userId: facadeOptions.userId,
                workId: facadeOptions.workId,
            });

            return this.resolveModelMetadataForPlugin(plugin, modelId, settings);
        } catch {
            const catalogModel = await this.resolveCatalogModel(modelId);
            return catalogModel ? this.buildAiModelFromCatalog(catalogModel) : null;
        }
    }

    async resolveModelContextLength(
        modelId: string,
        facadeOptions: FacadeOptions,
    ): Promise<number> {
        try {
            const resolvedModel = await this.resolveModelMetadata(modelId, facadeOptions);
            const contextLength = resolvedModel?.capabilities.maxContextLength;
            if (typeof contextLength === 'number' && contextLength > 0) {
                this.logger.debug(`Context length for "${modelId}": ${contextLength}`);
                return contextLength;
            }

            return AiFacadeService.DEFAULT_CONTEXT;
        } catch {
            return AiFacadeService.DEFAULT_CONTEXT;
        }
    }

    private async getCachedModelCatalog(): Promise<readonly ModelCatalogEntry[] | null> {
        const now = Date.now();
        if (this.modelCatalog && now - this.modelCatalogCacheTime < AiFacadeService.CACHE_TTL) {
            return this.modelCatalog;
        }

        const fresh = await fetchModelCatalog();
        if (fresh) {
            this.modelCatalog = fresh;
            this.modelCatalogCacheTime = now;
        }

        // Stale-while-revalidate: return cached data if fresh fetch failed
        return this.modelCatalog;
    }

    private async resolveModelMetadataForPlugin(
        plugin: IAiProviderPlugin,
        modelId: string,
        settings?: Record<string, unknown>,
    ): Promise<AiModel | null> {
        const pluginModel = await plugin.getModel(modelId, settings).catch(() => null);
        const catalogModel = await this.resolveCatalogModel(
            modelId,
            this.getProviderHint(plugin, modelId),
        );

        if (pluginModel && catalogModel) {
            return this.mergeAiModelWithCatalog(
                pluginModel,
                catalogModel,
                plugin.getCapabilities(),
            );
        }

        if (pluginModel) {
            return pluginModel;
        }

        if (catalogModel) {
            return this.buildAiModelFromCatalog(catalogModel, plugin.getCapabilities());
        }

        return null;
    }

    private async resolveCatalogModel(
        modelId: string,
        providerHint?: string,
    ): Promise<ModelCatalogEntry | null> {
        const models = await this.getCachedModelCatalog();
        if (!models) return null;

        return matchModelCatalogEntry(modelId, models, providerHint);
    }

    private getProviderHint(plugin: IAiProviderPlugin, modelId: string): string | undefined {
        const providerType = plugin.providerType?.trim().toLowerCase();
        if (!providerType) return undefined;

        if (providerType === 'openrouter') {
            const slashIndex = modelId.indexOf('/');
            return slashIndex > 0 ? modelId.slice(0, slashIndex).toLowerCase() : undefined;
        }

        return providerType;
    }

    private buildAiModelFromCatalog(
        catalogModel: ModelCatalogEntry,
        fallbackCapabilities?: AiModel['capabilities'],
    ): AiModel {
        return {
            id: catalogModel.id,
            name: catalogModel.name ?? catalogModel.modelId,
            capabilities: {
                supportsStructuredOutput: fallbackCapabilities?.supportsStructuredOutput ?? true,
                supportsStreaming: fallbackCapabilities?.supportsStreaming ?? true,
                supportsToolCalling: fallbackCapabilities?.supportsToolCalling ?? true,
                supportsVision: fallbackCapabilities?.supportsVision ?? false,
                maxContextLength:
                    catalogModel.maxContextLength ??
                    fallbackCapabilities?.maxContextLength ??
                    AiFacadeService.DEFAULT_CONTEXT,
                ...(catalogModel.maxOutputTokens || fallbackCapabilities?.maxOutputTokens
                    ? {
                          maxOutputTokens:
                              catalogModel.maxOutputTokens ?? fallbackCapabilities?.maxOutputTokens,
                      }
                    : {}),
            },
            ...(catalogModel.inputCostPer1k !== undefined
                ? { inputCostPer1k: catalogModel.inputCostPer1k }
                : {}),
            ...(catalogModel.outputCostPer1k !== undefined
                ? { outputCostPer1k: catalogModel.outputCostPer1k }
                : {}),
        };
    }

    private mergeAiModelWithCatalog(
        pluginModel: AiModel,
        catalogModel: ModelCatalogEntry,
        fallbackCapabilities?: AiModel['capabilities'],
    ): AiModel {
        const mergedCatalogModel = this.buildAiModelFromCatalog(catalogModel, fallbackCapabilities);

        return {
            ...pluginModel,
            capabilities: {
                ...pluginModel.capabilities,
                maxContextLength:
                    catalogModel.maxContextLength ?? pluginModel.capabilities.maxContextLength,
                ...(catalogModel.maxOutputTokens !== undefined ||
                pluginModel.capabilities.maxOutputTokens !== undefined
                    ? {
                          maxOutputTokens:
                              pluginModel.capabilities.maxOutputTokens ??
                              catalogModel.maxOutputTokens,
                      }
                    : {}),
            },
            ...(pluginModel.inputCostPer1k !== undefined
                ? { inputCostPer1k: pluginModel.inputCostPer1k }
                : mergedCatalogModel.inputCostPer1k !== undefined
                  ? { inputCostPer1k: mergedCatalogModel.inputCostPer1k }
                  : {}),
            ...(pluginModel.outputCostPer1k !== undefined
                ? { outputCostPer1k: pluginModel.outputCostPer1k }
                : mergedCatalogModel.outputCostPer1k !== undefined
                  ? { outputCostPer1k: mergedCatalogModel.outputCostPer1k }
                  : {}),
        };
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
