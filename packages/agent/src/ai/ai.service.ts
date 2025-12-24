import { Injectable, Logger, Optional } from '@nestjs/common';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';

// AI Providers
import { ChatOpenAI, ChatOpenAIFields, OpenAIEmbeddings } from '@langchain/openai';
import { Embeddings } from '@langchain/core/embeddings';
import {
    AiProviderType,
    AiProviderConfig,
    AiServiceConfig,
    AI_PROVIDER_CAPABILITIES,
    BaseChatModel,
} from './ai-provider.interface';
import { config } from '@src/config';
import { TokenUsage, TokenUsageTracker } from './token-usage.tracker';
import { ModelRouterService, RoutingOptions, RoutingDecision } from './model-router';

// Cache TTL for provider health checks (5 minutes)
const HEALTH_CHECK_CACHE_TTL_MS = 5 * 60 * 1000;

type HealthCheckResult = {
    success: boolean;
    provider: string;
    model: string;
    responseTime: number;
    error?: string;
    response?: string;
};

type ExtractVariableNames<T extends string> = T extends `${string}{${infer Var}}${infer Rest}`
    ? Var | ExtractVariableNames<Rest>
    : never;

type AskJsonOptions<Template extends string> =
    ExtractVariableNames<Template> extends never
        ? { temperature?: number; variables?: Record<string, string>; routing?: RoutingOptions }
        : {
              temperature?: number;
              variables: { [K in ExtractVariableNames<Template>]: string };
              routing?: RoutingOptions;
          };

@Injectable()
export class AiService {
    private readonly logger = new Logger(AiService.name);
    private readonly config: AiServiceConfig;
    private readonly providers: Map<AiProviderType, BaseChatModel> = new Map();
    private readonly isConfigured: boolean;
    private readonly isCLI: boolean;
    private readonly modelRouter: ModelRouterService;

    // In-memory cache for health check results
    private healthCheckCache: { result: HealthCheckResult; timestamp: number } | null = null;

    constructor(@Optional() modelRouter?: ModelRouterService) {
        this.isCLI = config.isCli();
        this.modelRouter = modelRouter ?? new ModelRouterService();

        this.config = this.loadConfiguration();
        this.isConfigured = this.initializeProviders();

        // Inform the model router about available providers
        this.modelRouter.setAvailableProviders(this.getAvailableProviders());

        if (!this.isConfigured) {
            this.logger.warn('No AI providers configured. AI features will be limited.');
        } else {
            this.logger.log(
                `AI Service initialized with ${this.providers.size} provider(s). Default: ${this.config.defaultProvider}`,
            );
        }
    }

    async askJson<T, Template extends string = string>(
        promptTemplate: Template,
        schema: z.ZodSchema<T>,
        ...args: ExtractVariableNames<Template> extends never
            ? [options?: AskJsonOptions<Template>]
            : [options: AskJsonOptions<Template>]
    ): Promise<{
        result: T;
        usage: TokenUsage | null;
        cost: number | null;
        provider: AiProviderType;
        model: string;
        routingDecision?: RoutingDecision;
    }> {
        const options = args[0];
        const resolvedPrompt = this.renderTemplate(promptTemplate, options?.variables);

        // Check if model routing is enabled and routing options are provided
        const useRouting = this.modelRouter.isEnabled() && options?.routing?.complexity;

        if (!useRouting) {
            const providerType = this.config.defaultProvider;
            const modelName = this.getProviderConfig(providerType)?.modelName || 'unknown';

            const llm = this.createLlmWithCriteria({
                providerType,
                temperature: options?.temperature,
            });

            return this.invokeStructuredLlm(llm, schema, resolvedPrompt, providerType, modelName);
        }

        // Routing path: use model router to select provider/model based on task complexity
        const defaultModel =
            this.getProviderConfig(this.config.defaultProvider)?.modelName || 'unknown';

        const routingDecision = this.modelRouter.route(
            options?.routing ?? {},
            this.config.defaultProvider,
            defaultModel,
        );

        const providerType = routingDecision.selectedConfig.provider;
        const modelName = routingDecision.selectedConfig.model;

        const llm = this.createLlmForRouting(providerType, modelName, options?.temperature);

        try {
            const result = await this.invokeStructuredLlm(
                llm,
                schema,
                resolvedPrompt,
                providerType,
                modelName,
            );
            return { ...result, routingDecision };
        } catch (error) {
            // Try auto-escalation if enabled
            if (options?.routing?.autoEscalate !== false) {
                const escalatedDecision = this.modelRouter.escalate(
                    routingDecision,
                    this.config.defaultProvider,
                    defaultModel,
                );

                if (escalatedDecision) {
                    this.logger.warn(
                        `Escalating from ${providerType}/${modelName} to ${escalatedDecision.selectedConfig.provider}/${escalatedDecision.selectedConfig.model}`,
                    );

                    const escalatedLlm = this.createLlmForRouting(
                        escalatedDecision.selectedConfig.provider,
                        escalatedDecision.selectedConfig.model,
                        options?.temperature,
                    );

                    const result = await this.invokeStructuredLlm(
                        escalatedLlm,
                        schema,
                        resolvedPrompt,
                        escalatedDecision.selectedConfig.provider,
                        escalatedDecision.selectedConfig.model,
                    );
                    return { ...result, routingDecision: escalatedDecision };
                }
            }

            throw error;
        }
    }

    /**
     * Helper method to invoke LLM with structured output and track usage/cost
     */
    private async invokeStructuredLlm<T>(
        llm: BaseChatModel,
        schema: z.ZodSchema<T>,
        prompt: string,
        providerType: AiProviderType,
        modelName: string,
    ): Promise<{
        result: T;
        usage: TokenUsage | null;
        cost: number | null;
        provider: AiProviderType;
        model: string;
    }> {
        const tracker = new TokenUsageTracker();

        try {
            const result = (await llm
                .withStructuredOutput(schema)
                .invoke([new HumanMessage(prompt)], {
                    callbacks: [tracker],
                })) as T;

            const usage = tracker.usage.totalTokens > 0 ? tracker.usage : null;
            const cost = usage ? this.calculateCost(providerType, usage, modelName) : null;

            return { result, usage, cost, provider: providerType, model: modelName };
        } catch (error) {
            this.logger.error(
                `askJson failed (${providerType}/${modelName}): ${this.getErrorMessage(error)}`,
            );
            throw error;
        }
    }

    private createLlmForRouting(
        providerType: AiProviderType,
        modelName: string,
        temperature?: number,
    ): BaseChatModel {
        const providerConfig = this.config.providers[providerType];

        if (!providerConfig || !providerConfig.enabled) {
            // Fallback to default provider if the routed provider is not available
            this.logger.warn(
                `Provider ${providerType} not available for routing, using default provider`,
            );
            return this.createLlmWithCriteria({
                temperature,
            });
        }

        // Create a temporary config with the routed model
        const routedConfig: AiProviderConfig = {
            ...providerConfig,
            modelName,
            temperature: temperature ?? providerConfig.temperature,
        };

        const provider = this.createProvider(routedConfig);
        if (!provider) {
            this.logger.warn(`Failed to create provider ${providerType}, using default`);
            return this.createLlmWithCriteria({ temperature });
        }

        return provider;
    }

    private calculateCost(
        provider: AiProviderType,
        usage: TokenUsage,
        model?: string,
    ): number | null {
        const providerConfig = this.config.providers[provider];
        const modelName = model || providerConfig?.modelName || 'unknown';

        const estimate = this.modelRouter.estimateCost(
            provider,
            modelName,
            usage.inputTokens,
            usage.outputTokens,
        );

        return estimate.estimatedCostUsd > 0 ? estimate.estimatedCostUsd : null;
    }

    private renderTemplate(template: string, variables?: Record<string, any>): string {
        if (!variables) {
            return template;
        }

        return template.replace(/\{(\w+)\}/g, (match, key) => {
            const value = variables[key];
            return value !== undefined ? String(value) : match;
        });
    }

    private loadConfiguration(): AiServiceConfig {
        const defaultProvider = config.ai.getDefaultProvider();

        const providers: Record<AiProviderType, AiProviderConfig> = {
            openai: {
                type: 'openai',
                apiKey: config.ai.openAi.getKey(),
                modelName: config.ai.openAi.getModel(),
                embeddingModelName: config.ai.openAi.getEmbeddingModel(),
                temperature: config.ai.openAi.getTemperature(),
                enabled: !!config.ai.openAi.getKey(),
                maxTokens: config.ai.openAi.getMaxTokens(),
                baseURL: config.ai.openAi.getBaseUrl(),
            },
            openrouter: {
                type: 'openrouter',
                apiKey: config.ai.openRouter.getKey(),
                modelName: config.ai.openRouter.getModel(),
                embeddingModelName: config.ai.openRouter.getEmbeddingModel(),
                temperature: config.ai.openRouter.getTemperature(),
                enabled: !!config.ai.openRouter.getKey(),
                maxTokens: config.ai.openRouter.getMaxTokens(),
                baseURL: config.ai.openRouter.getBaseUrl(),
            },
            ollama: {
                type: 'ollama',
                apiKey: config.ai.ollama.getKey(),
                modelName: config.ai.ollama.getModel(),
                embeddingModelName: config.ai.ollama.getEmbeddingModel(),
                temperature: config.ai.ollama.getTemperature(),
                enabled: !!config.ai.ollama.getBaseUrl(),
                baseURL: config.ai.ollama.getBaseUrl(),
                maxTokens: config.ai.ollama.getMaxTokens(),
            },
            google: {
                type: 'google',
                apiKey: config.ai.google.getKey(),
                modelName: config.ai.google.getModel(),
                embeddingModelName: config.ai.google.getEmbeddingModel(),
                temperature: config.ai.google.getTemperature(),
                enabled: !!config.ai.google.getKey(),
                maxTokens: config.ai.google.getMaxTokens(),
                baseURL: config.ai.google.getBaseUrl(),
            },
            anthropic: {
                type: 'anthropic',
                apiKey: config.ai.anthropic.getKey(),
                modelName: config.ai.anthropic.getModel(),
                embeddingModelName: config.ai.anthropic.getEmbeddingModel(),
                temperature: config.ai.anthropic.getTemperature(),
                enabled: !!config.ai.anthropic.getKey(),
                maxTokens: config.ai.anthropic.getMaxTokens(),
                baseURL: config.ai.anthropic.getBaseUrl(),
            },
            groq: {
                type: 'groq',
                apiKey: config.ai.groq.getKey(),
                modelName: config.ai.groq.getModel(),
                temperature: config.ai.groq.getTemperature(),
                enabled: !!config.ai.groq.getKey(),
                maxTokens: config.ai.groq.getMaxTokens(),
                baseURL: config.ai.groq.getBaseUrl(),
            },
            custom: {
                type: 'custom',
                apiKey: config.ai.custom.getKey(),
                modelName: config.ai.custom.getModel(),
                temperature: config.ai.custom.getTemperature(),
                enabled: !!config.ai.custom.getBaseUrl(),
                maxTokens: config.ai.custom.getMaxTokens(),
                baseURL: config.ai.custom.getBaseUrl(),
            },
        };

        const fallbackProviders =
            config.ai
                .getFallbackProviders()
                ?.split(',')
                .map((p) => p.trim() as AiProviderType) || [];

        return {
            defaultProvider,
            providers,
            fallbackProviders,
        };
    }

    private initializeProviders(): boolean {
        let hasConfiguredProvider = false;

        for (const [providerType, config] of Object.entries(this.config.providers)) {
            if (!config.enabled) {
                continue;
            }

            try {
                const provider = this.createProvider(config);
                if (provider) {
                    this.providers.set(providerType as AiProviderType, provider);
                    hasConfiguredProvider = true;
                    this.logger.log(
                        `Initialized ${providerType} provider with model: ${config.modelName}`,
                    );
                }
            } catch (error) {
                this.logger.error(
                    `Failed to initialize ${providerType} provider: ${this.getErrorMessage(error)}`,
                );
            }
        }

        return hasConfiguredProvider;
    }

    private createProvider(config: AiProviderConfig): BaseChatModel | null {
        const defaultConfig = this.getProviderConfig(config.type);

        config.apiKey = config.apiKey || defaultConfig?.apiKey;
        config.modelName = config.modelName || defaultConfig?.modelName;
        config.temperature = config.temperature ?? defaultConfig?.temperature ?? 0.7;
        config.maxTokens = config.maxTokens || defaultConfig?.maxTokens || 4096;
        config.baseURL = config.baseURL || defaultConfig?.baseURL || '';

        const commonOptions: ChatOpenAIFields = {
            apiKey: config.apiKey,
            temperature: config.temperature,
            maxTokens: config.maxTokens,
            reasoning: {
                effort: 'low',
            },
        };

        switch (config.type) {
            case 'openai':
                return new ChatOpenAI({
                    ...commonOptions,
                    model: config.modelName,
                });

            case 'openrouter':
                return new ChatOpenAI({
                    ...commonOptions,
                    model: config.modelName,
                    configuration: {
                        baseURL: config.baseURL,
                    },
                });

            case 'ollama':
                return new ChatOpenAI({
                    ...commonOptions,
                    model: config.modelName,
                    configuration: {
                        baseURL: config.baseURL,
                    },
                });

            case 'google':
                return new ChatOpenAI({
                    ...commonOptions,
                    model: config.modelName,
                    configuration: {
                        baseURL: config.baseURL,
                        extra_body: {
                            google: {
                                thinking_config: {
                                    thinking_budget: 0,
                                    include_thoughts: false,
                                },
                            },
                        },
                    } as any,
                });

            case 'anthropic':
                return new ChatOpenAI({
                    ...commonOptions,
                    model: config.modelName,
                    configuration: {
                        baseURL: config.baseURL,
                    },
                });

            case 'groq':
                return new ChatOpenAI({
                    ...commonOptions,
                    model: config.modelName,
                    configuration: {
                        baseURL: config.baseURL,
                    },
                });

            case 'custom':
                return new ChatOpenAI({
                    ...commonOptions,
                    model: config.modelName,
                    configuration: {
                        baseURL: config.baseURL,
                    },
                });

            default:
                this.logger.warn(`Unknown provider type: ${config.type}`);
                return null;
        }
    }

    private createDefaultProvider(): BaseChatModel {
        return new ChatOpenAI();
    }

    isAiConfigured(): boolean {
        return this.isConfigured;
    }

    getLlm(): BaseChatModel {
        return this.getLlmByProvider(this.config.defaultProvider);
    }

    getLlmByProvider(providerType: AiProviderType): BaseChatModel {
        const provider = this.providers.get(providerType);
        if (!provider) {
            // Try fallback providers
            for (const fallbackProvider of this.config.fallbackProviders || []) {
                const fallback = this.providers.get(fallbackProvider);
                if (fallback) {
                    this.logger.warn(
                        `Provider ${providerType} not available, using fallback: ${fallbackProvider}`,
                    );
                    return fallback;
                }
            }

            // Use any available provider as last resort
            const anyProvider = this.providers.values().next().value;
            if (anyProvider) {
                this.logger.warn(
                    `Provider ${providerType} not available, using first available provider`,
                );
                return anyProvider;
            }

            if (this.isCLI) {
                this.logger.warn(
                    `No AI providers available. Provider ${providerType} not found and no fallbacks configured. Using default provider.`,
                );
                return this.createDefaultProvider();
            }

            throw new Error(
                `No AI providers available. Provider ${providerType} not found and no fallbacks configured.`,
            );
        }
        return provider;
    }

    createLlmWithTemperature(temperature: number, providerType?: AiProviderType): BaseChatModel {
        const targetProvider = providerType || this.config.defaultProvider;
        const config = this.config.providers[targetProvider];

        if (!config || !config.enabled) {
            this.logger.warn(
                `Provider ${targetProvider} not available, using default provider for temperature override.`,
            );
            return this.createDefaultProvider();
        }

        const tempConfig = { ...config, temperature };
        const provider = this.createProvider(tempConfig);

        if (!provider) {
            if (this.isCLI) {
                this.logger.warn(
                    `Failed to create temporary provider for ${targetProvider}, using default provider.`,
                );
                return this.createDefaultProvider();
            }

            throw new Error(`Failed to create temporary provider for ${targetProvider}`);
        }

        return provider;
    }

    getAvailableProviders(): AiProviderType[] {
        return Array.from(this.providers.keys());
    }

    getProviderConfig(providerType: AiProviderType): AiProviderConfig | undefined {
        return this.config.providers[providerType];
    }

    getServiceConfig(): AiServiceConfig {
        return { ...this.config };
    }

    isProviderAvailable(providerType: AiProviderType): boolean {
        return this.providers.has(providerType);
    }

    private getCostEffectiveProvider(): AiProviderType {
        const availableProviders = this.getAvailableProviders();

        const sortedByCost = availableProviders.sort((a, b) => {
            const configA = this.config.providers[a];
            const configB = this.config.providers[b];
            const pricingA = this.modelRouter.getPricing(a, configA?.modelName || '');
            const pricingB = this.modelRouter.getPricing(b, configB?.modelName || '');
            const costA = pricingA?.inputPricePerMillion || Infinity;
            const costB = pricingB?.inputPricePerMillion || Infinity;
            return costA - costB;
        });

        return sortedByCost[0] || this.config.defaultProvider;
    }

    private getFastestProvider(): AiProviderType {
        if (this.isProviderAvailable('groq')) {
            return 'groq';
        }
        return this.config.defaultProvider;
    }

    private getMostCapableProvider(): AiProviderType {
        const availableProviders = this.getAvailableProviders();

        const sortedByContext = availableProviders.sort((a, b) => {
            const contextA = AI_PROVIDER_CAPABILITIES[a].maxContextLength;
            const contextB = AI_PROVIDER_CAPABILITIES[b].maxContextLength;
            return contextB - contextA;
        });

        return sortedByContext[0] || this.config.defaultProvider;
    }

    private createLlmWithCriteria(criteria: {
        preferCostEffective?: boolean;
        preferFast?: boolean;
        preferHighContext?: boolean;
        temperature?: number;
        providerType?: AiProviderType;
    }): BaseChatModel {
        let selectedProvider: AiProviderType;

        if (criteria.providerType && this.isProviderAvailable(criteria.providerType)) {
            selectedProvider = criteria.providerType;
        } else if (criteria.preferCostEffective) {
            selectedProvider = this.getCostEffectiveProvider();
        } else if (criteria.preferFast) {
            selectedProvider = this.getFastestProvider();
        } else if (criteria.preferHighContext) {
            selectedProvider = this.getMostCapableProvider();
        } else {
            selectedProvider = this.config.defaultProvider;
        }

        if (criteria.temperature !== undefined) {
            return this.createLlmWithTemperature(criteria.temperature, selectedProvider);
        }

        return this.getLlmByProvider(selectedProvider);
    }

    getEmbeddings(providerType?: AiProviderType): Embeddings {
        const targetProvider = this.getEffectiveEmbeddingProvider(providerType);
        const config = this.config.providers[targetProvider];

        if (!config) {
            throw new Error(`Provider ${targetProvider} not available for embeddings.`);
        }

        return this.createEmbeddingProvider(config);
    }

    getEffectiveEmbeddingProvider(providerType?: AiProviderType): AiProviderType {
        const targetProvider = providerType || this.config.defaultProvider;
        const config = this.config.providers[targetProvider];

        if (config && config.enabled && this.supportsEmbeddings(targetProvider)) {
            return targetProvider;
        }

        if (this.config.providers['openai']?.enabled) {
            return 'openai';
        }

        throw new Error(`No embedding provider available. Requested: ${targetProvider}`);
    }

    private supportsEmbeddings(providerType: AiProviderType): boolean {
        return ['openai', 'openrouter', 'ollama', 'google', 'anthropic'].includes(providerType);
    }

    private createEmbeddingProvider(config: AiProviderConfig): Embeddings | null {
        switch (config.type) {
            case 'openai':
                return new OpenAIEmbeddings({
                    apiKey: config.apiKey,
                    model: config.embeddingModelName,
                });

            case 'openrouter':
                return new OpenAIEmbeddings({
                    apiKey: config.apiKey,
                    model: config.embeddingModelName,
                    configuration: {
                        baseURL: config.baseURL,
                    },
                });

            case 'ollama':
                return new OpenAIEmbeddings({
                    apiKey: config.apiKey || 'ollama',
                    model: config.embeddingModelName,
                    configuration: {
                        baseURL: config.baseURL,
                    },
                });

            case 'anthropic':
                return new OpenAIEmbeddings({
                    apiKey: config.apiKey,
                    model: config.embeddingModelName,
                    configuration: {
                        baseURL: config.baseURL,
                    },
                });

            case 'google':
                return new OpenAIEmbeddings({
                    apiKey: config.apiKey,
                    model: config.embeddingModelName,
                    configuration: {
                        baseURL: config.baseURL,
                    },
                });

            default:
                return null;
        }
    }

    async testDefaultProvider(forceRetest = false): Promise<HealthCheckResult> {
        if (!forceRetest && this.healthCheckCache) {
            const { result, timestamp } = this.healthCheckCache;
            if (Date.now() - timestamp < HEALTH_CHECK_CACHE_TTL_MS) {
                return result;
            }
        }

        const defaultProvider = this.config.defaultProvider;
        const providerConfig = this.config.providers[defaultProvider];

        const result = await this.testProvider({
            type: defaultProvider,
            apiKey: providerConfig.apiKey,
            modelName: providerConfig.modelName,
            temperature: providerConfig.temperature || 0.7,
            maxTokens: providerConfig.maxTokens || 100,
            baseURL: providerConfig.baseURL,
        });

        // Cache successful results in memory
        if (result.success) {
            this.healthCheckCache = { result, timestamp: Date.now() };
        }

        return result;
    }

    async testProvider(providerConfig: {
        type: AiProviderType;
        apiKey: string;
        modelName: string;
        temperature?: number;
        maxTokens?: number;
        baseURL?: string;
    }): Promise<HealthCheckResult> {
        const startTime = Date.now();

        try {
            this.logger.log(
                `Testing ${providerConfig.type} provider with model ${providerConfig.modelName}...`,
            );

            // Create a temporary provider instance for testing
            const testProvider = this.createProvider({
                ...providerConfig,
                enabled: true,
                baseURL: providerConfig.baseURL || '',
            });

            if (!testProvider) {
                return {
                    success: false,
                    provider: providerConfig.type,
                    model: providerConfig.modelName,
                    responseTime: Date.now() - startTime,
                    error: `Failed to create provider instance for ${providerConfig.type}`,
                };
            }

            // Test with a simple prompt
            const testMessage = {
                role: 'user',
                content: 'Hello! Please respond with just "OK" to confirm you are working.',
            };
            const response = await testProvider.invoke([testMessage]);

            const responseTime = Date.now() - startTime;
            const responseContent = response.content as string;

            this.logger.log(`${providerConfig.type} test completed in ${responseTime}ms`);

            return {
                success: true,
                provider: providerConfig.type,
                model: providerConfig.modelName,
                responseTime,
                response: responseContent.trim(),
            };
        } catch (error) {
            const responseTime = Date.now() - startTime;
            this.logger.error(`${providerConfig.type} test failed: ${this.getErrorMessage(error)}`);

            return {
                success: false,
                provider: providerConfig.type,
                model: providerConfig.modelName,
                responseTime,
                error: this.getErrorMessage(error),
            };
        }
    }

    private getErrorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
