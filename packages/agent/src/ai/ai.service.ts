import { Injectable, Logger } from '@nestjs/common';

// AI Providers
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatMistralAI } from '@langchain/mistralai';
import { ChatGroq } from '@langchain/groq';
import {
    AiProviderType,
    AiProviderConfig,
    AiServiceConfig,
    AI_PROVIDER_CAPABILITIES,
    BaseChatModel,
} from './ai-provider.interface';
import { config } from '@src/config';

@Injectable()
export class AiService {
    private readonly logger = new Logger(AiService.name);
    private readonly config: AiServiceConfig;
    private readonly providers: Map<AiProviderType, BaseChatModel> = new Map();
    private readonly isConfigured: boolean;
    private readonly isCLI: boolean;

    constructor() {
        this.isCLI = config.isCli();

        this.config = this.loadConfiguration();
        this.isConfigured = this.initializeProviders();

        if (!this.isConfigured) {
            this.logger.warn('No AI providers configured. AI features will be limited.');
        } else {
            this.logger.log(
                `AI Service initialized with ${this.providers.size} provider(s). Default: ${this.config.defaultProvider}`,
            );
        }
    }

    /**
     * Load AI service configuration from environment variables
     */
    private loadConfiguration(): AiServiceConfig {
        const defaultProvider = config.ai.getDefaultProvider();

        const providers: Record<AiProviderType, AiProviderConfig> = {
            openai: {
                type: 'openai',
                apiKey: config.ai.openAi.getKey(),
                modelName: config.ai.openAi.getModel(),
                temperature: config.ai.openAi.getTemperature(),
                enabled: !!config.ai.openAi.getKey(),
                maxTokens: config.ai.openAi.getMaxTokens(),
            },
            openrouter: {
                type: 'openrouter',
                apiKey: config.ai.openRouter.getKey(),
                modelName: config.ai.openRouter.getModel(),
                temperature: config.ai.openRouter.getTemperature(),
                enabled: !!config.ai.openRouter.getKey(),
                maxTokens: config.ai.openRouter.getMaxTokens(),
                baseURL: config.ai.openRouter.getBaseUrl(),
            },
            ollama: {
                type: 'ollama',
                apiKey: config.ai.ollama.getKey(),
                modelName: config.ai.ollama.getModel(),
                temperature: config.ai.ollama.getTemperature(),
                enabled: !!config.ai.ollama.getBaseUrl(),
                baseURL: config.ai.ollama.getBaseUrl(),
                maxTokens: config.ai.ollama.getMaxTokens(),
            },
            google: {
                type: 'google',
                apiKey: config.ai.google.getKey(),
                modelName: config.ai.google.getModel(),
                temperature: config.ai.google.getTemperature(),
                enabled: !!config.ai.google.getKey(),
                maxTokens: config.ai.google.getMaxTokens(),
                baseURL: config.ai.google.getBaseUrl(),
            },
            anthropic: {
                type: 'anthropic',
                apiKey: config.ai.anthropic.getKey(),
                modelName: config.ai.anthropic.getModel(),
                temperature: config.ai.anthropic.getTemperature(),
                enabled: !!config.ai.anthropic.getKey(),
                maxTokens: config.ai.anthropic.getMaxTokens(),
            },
            mistral: {
                type: 'mistral',
                apiKey: config.ai.mistral.getKey(),
                modelName: config.ai.mistral.getModel(),
                temperature: config.ai.mistral.getTemperature(),
                enabled: !!config.ai.mistral.getKey(),
                maxTokens: config.ai.mistral.getMaxTokens(),
            },
            groq: {
                type: 'groq',
                apiKey: config.ai.groq.getKey(),
                modelName: config.ai.groq.getModel(),
                temperature: config.ai.groq.getTemperature(),
                enabled: !!config.ai.groq.getKey(),
                maxTokens: config.ai.groq.getMaxTokens(),
            },
            deepseek: {
                type: 'deepseek',
                apiKey: config.ai.deepseek.getKey(),
                modelName: config.ai.deepseek.getModel(),
                temperature: config.ai.deepseek.getTemperature(),
                enabled: !!config.ai.deepseek.getKey(),
                maxTokens: config.ai.deepseek.getMaxTokens(),
                baseURL: config.ai.deepseek.getBaseUrl(),
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

    /**
     * Initialize AI providers based on configuration
     */
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
                    `Failed to initialize ${providerType} provider: ${error.message}`,
                );
            }
        }

        return hasConfiguredProvider;
    }

    /**
     * Create a provider instance based on configuration
     */
    private createProvider(config: AiProviderConfig): BaseChatModel | null {
        const commonOptions = {
            apiKey: config.apiKey,
            temperature: config.temperature || 0.7,
            maxTokens: config.maxTokens || 4096,
            reasoning: {
                effort: 'low' as const,
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
                return new ChatAnthropic({
                    ...commonOptions,
                    model: config.modelName,
                }) as unknown as BaseChatModel;

            case 'mistral':
                return new ChatMistralAI({
                    ...commonOptions,
                    model: config.modelName,
                }) as unknown as BaseChatModel;

            case 'groq':
                return new ChatGroq({
                    ...commonOptions,
                    model: config.modelName,
                }) as unknown as BaseChatModel;

            case 'deepseek':
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

    /**
     * Check if any AI provider is configured
     */
    isApiKeyConfigured(): boolean {
        return this.isConfigured;
    }

    /**
     * Check if the AI service is properly configured
     */
    isAiConfigured(): boolean {
        return this.isConfigured;
    }

    /**
     * Get the default LLM instance
     */
    getLlm(): BaseChatModel {
        return this.getLlmByProvider(this.config.defaultProvider);
    }

    /**
     * Get LLM instance by provider type
     */
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

    /**
     * Create a temporary LLM with a different temperature
     */
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

    /**
     * Get available provider types
     */
    getAvailableProviders(): AiProviderType[] {
        return Array.from(this.providers.keys());
    }

    /**
     * Get provider configuration
     */
    getProviderConfig(providerType: AiProviderType): AiProviderConfig | undefined {
        return this.config.providers[providerType];
    }

    /**
     * Get service configuration
     */
    getServiceConfig(): AiServiceConfig {
        return { ...this.config };
    }

    /**
     * Check if a specific provider is available
     */
    isProviderAvailable(providerType: AiProviderType): boolean {
        return this.providers.has(providerType);
    }

    /**
     * Get provider capabilities
     */
    getProviderCapabilities(providerType: AiProviderType) {
        return AI_PROVIDER_CAPABILITIES[providerType];
    }

    /**
     * Get the most cost-effective provider for a given task
     */
    getCostEffectiveProvider(): AiProviderType {
        const availableProviders = this.getAvailableProviders();

        // Sort by cost (input token cost)
        const sortedByCost = availableProviders.sort((a, b) => {
            const costA = AI_PROVIDER_CAPABILITIES[a].costPerToken?.input || 0;
            const costB = AI_PROVIDER_CAPABILITIES[b].costPerToken?.input || 0;
            return costA - costB;
        });

        return sortedByCost[0] || this.config.defaultProvider;
    }

    /**
     * Get the fastest provider (typically Groq for inference speed)
     */
    getFastestProvider(): AiProviderType {
        if (this.isProviderAvailable('groq')) {
            return 'groq';
        }
        return this.config.defaultProvider;
    }

    /**
     * Get the most capable provider (highest context length)
     */
    getMostCapableProvider(): AiProviderType {
        const availableProviders = this.getAvailableProviders();

        const sortedByContext = availableProviders.sort((a, b) => {
            const contextA = AI_PROVIDER_CAPABILITIES[a].maxContextLength;
            const contextB = AI_PROVIDER_CAPABILITIES[b].maxContextLength;
            return contextB - contextA;
        });

        return sortedByContext[0] || this.config.defaultProvider;
    }

    /**
     * Create LLM with automatic provider selection based on criteria
     */
    createLlmWithCriteria(criteria: {
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

    /**
     * Test a specific AI provider configuration
     */
    async testProvider(providerConfig: {
        type: AiProviderType;
        apiKey: string;
        modelName: string;
        temperature?: number;
        maxTokens?: number;
        baseURL?: string;
    }): Promise<{
        success: boolean;
        provider: string;
        model: string;
        responseTime: number;
        error?: string;
        response?: string;
    }> {
        const startTime = Date.now();

        try {
            this.logger.log(
                `Testing ${providerConfig.type} provider with model ${providerConfig.modelName}...`,
            );

            // Create a temporary provider instance for testing
            const testProvider = this.createProvider({
                ...providerConfig,
                enabled: true,
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
            this.logger.error(`${providerConfig.type} test failed: ${error.message}`);

            return {
                success: false,
                provider: providerConfig.type,
                model: providerConfig.modelName,
                responseTime,
                error: error.message,
            };
        }
    }

    /**
     * Test multiple provider configurations
     */
    async testMultipleProviders(
        providerConfigs: Array<{
            type: AiProviderType;
            apiKey: string;
            modelName: string;
            temperature?: number;
            maxTokens?: number;
            baseURL?: string;
        }>,
    ): Promise<
        Array<{
            success: boolean;
            provider: string;
            model: string;
            responseTime: number;
            error?: string;
            response?: string;
        }>
    > {
        const results = [];

        for (const config of providerConfigs) {
            const result = await this.testProvider(config);
            results.push(result);
        }

        return results;
    }

    /**
     * Log provider usage statistics
     */
    logProviderStats(): void {
        this.logger.log('=== AI Provider Configuration ===');
        this.logger.log(`Default Provider: ${this.config.defaultProvider}`);
        this.logger.log(`Available Providers: ${this.getAvailableProviders().join(', ')}`);
        this.logger.log(
            `Fallback Providers: ${this.config.fallbackProviders?.join(', ') || 'None'}`,
        );

        for (const [provider, capabilities] of Object.entries(AI_PROVIDER_CAPABILITIES)) {
            if (this.isProviderAvailable(provider as AiProviderType)) {
                this.logger.log(
                    `${provider}: Context=${capabilities.maxContextLength}, Cost=${capabilities.costPerToken?.input || 'N/A'}/token`,
                );
            }
        }
        this.logger.log('================================');
    }
}
