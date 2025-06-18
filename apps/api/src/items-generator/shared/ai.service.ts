import { Injectable, Logger } from '@nestjs/common';

// AI Providers
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
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

@Injectable()
export class AiService {
    private readonly logger = new Logger(AiService.name);
    private readonly config: AiServiceConfig;
    private readonly providers: Map<AiProviderType, BaseChatModel> = new Map();
    private readonly isConfigured: boolean;

    constructor() {
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
        const defaultProvider = (process.env.AI_DEFAULT_PROVIDER as AiProviderType) || 'openai';

        const providers: Record<AiProviderType, AiProviderConfig> = {
            openai: {
                type: 'openai',
                apiKey: process.env.OPENAI_API_KEY,
                modelName: process.env.OPENAI_MODEL || 'gpt-4.1',
                temperature: parseFloat(process.env.OPENAI_TEMPERATURE || '0.7'),
                enabled: !!process.env.OPENAI_API_KEY,
                maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS || '4096'),
            },
            google: {
                type: 'google',
                apiKey: process.env.GOOGLE_API_KEY,
                modelName: process.env.GOOGLE_MODEL || 'gemini-2.5-flash',
                temperature: parseFloat(process.env.GOOGLE_TEMPERATURE || '0.7'),
                enabled: !!process.env.GOOGLE_API_KEY,
                maxTokens: parseInt(process.env.GOOGLE_MAX_TOKENS || '4096'),
            },
            anthropic: {
                type: 'anthropic',
                apiKey: process.env.ANTHROPIC_API_KEY,
                modelName: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
                temperature: parseFloat(process.env.ANTHROPIC_TEMPERATURE || '0.7'),
                enabled: !!process.env.ANTHROPIC_API_KEY,
                maxTokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS || '4096'),
            },
            mistral: {
                type: 'mistral',
                apiKey: process.env.MISTRAL_API_KEY,
                modelName: process.env.MISTRAL_MODEL || 'mistral-large-latest',
                temperature: parseFloat(process.env.MISTRAL_TEMPERATURE || '0.7'),
                enabled: !!process.env.MISTRAL_API_KEY,
                maxTokens: parseInt(process.env.MISTRAL_MAX_TOKENS || '4096'),
            },
            groq: {
                type: 'groq',
                apiKey: process.env.GROQ_API_KEY,
                modelName: process.env.GROQ_MODEL || 'llama-3.1-70b-versatile',
                temperature: parseFloat(process.env.GROQ_TEMPERATURE || '0.7'),
                enabled: !!process.env.GROQ_API_KEY,
                maxTokens: parseInt(process.env.GROQ_MAX_TOKENS || '4096'),
            },
            deepseek: {
                type: 'deepseek',
                apiKey: process.env.DEEPSEEK_API_KEY,
                modelName: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
                temperature: parseFloat(process.env.DEEPSEEK_TEMPERATURE || '0.7'),
                enabled: !!process.env.DEEPSEEK_API_KEY,
                maxTokens: parseInt(process.env.DEEPSEEK_MAX_TOKENS || '4096'),
                baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
            },
        };

        const fallbackProviders =
            process.env.AI_FALLBACK_PROVIDERS?.split(',').map((p) => p.trim() as AiProviderType) ||
            [];

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
            if (!config.enabled || !config.apiKey) {
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
        };

        switch (config.type) {
            case 'openai':
                return new ChatOpenAI({
                    ...commonOptions,
                    model: config.modelName || 'gpt-4.1',
                    configuration: {
                        baseURL: config.baseURL || 'https://api.openai.com',
                    },
                });

            case 'google':
                return new ChatGoogleGenerativeAI({
                    ...commonOptions,
                    model: config.modelName || 'gemini-2.5-flash',
                }) as BaseChatModel;

            case 'anthropic':
                return new ChatAnthropic({
                    ...commonOptions,
                    model: config.modelName || 'claude-3-5-sonnet-20241022',
                }) as unknown as BaseChatModel;

            case 'mistral':
                return new ChatMistralAI({
                    ...commonOptions,
                    model: config.modelName || 'mistral-large-latest',
                }) as unknown as BaseChatModel;

            case 'groq':
                return new ChatGroq({
                    ...commonOptions,
                    model: config.modelName || 'llama-3.1-70b-versatile',
                }) as unknown as BaseChatModel;

            case 'deepseek':
                return new ChatOpenAI({
                    ...commonOptions,
                    model: config.modelName || 'deepseek-chat',
                    configuration: {
                        baseURL: config.baseURL || 'https://api.deepseek.com',
                    },
                });

            default:
                this.logger.warn(`Unknown provider type: ${config.type}`);
                return null;
        }
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
            throw new Error(`Provider ${targetProvider} is not configured or enabled`);
        }

        const tempConfig = { ...config, temperature };
        const provider = this.createProvider(tempConfig);

        if (!provider) {
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
