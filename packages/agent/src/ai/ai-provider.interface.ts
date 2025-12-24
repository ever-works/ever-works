import { type ChatOpenAI } from '@langchain/openai';

export type AiProviderType =
    | 'openai'
    | 'google'
    | 'anthropic'
    | 'groq'
    | 'openrouter'
    | 'ollama'
    | 'custom';

export type BaseChatModel = ChatOpenAI;

export interface AiProviderConfig {
    type: AiProviderType;
    apiKey?: string;
    modelName?: string;
    embeddingModelName?: string;
    temperature?: number;
    enabled?: boolean;
    maxTokens?: number;
    baseURL: string;
}

export interface AiServiceConfig {
    defaultProvider: AiProviderType;
    providers: Record<AiProviderType, AiProviderConfig>;
    fallbackProviders?: AiProviderType[];
}

export interface AiProviderCapabilities {
    supportsStructuredOutput: boolean;
    supportsStreaming: boolean;
    supportsToolCalling: boolean;
    maxContextLength: number;
}

export interface AiProviderDefaults {
    model: string;
    temperature: number;
    maxTokens: number;
    baseUrl?: string;
}

export interface AiProviderInfo {
    name: string;
    displayName: string;
    description: string;
    defaults: AiProviderDefaults;
    requiresApiKey: boolean;
    models: string[];
    websiteUrl: string;
    docsUrl: string;
}

export interface ConfiguredAiProvider {
    name: string;
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens: number;
    baseUrl?: string;
}

export interface AiProviderConfiguration {
    defaultProvider: string;
    fallbackProviders: string[];
    providers: ConfiguredAiProvider[];
}

export const AI_PROVIDER_CAPABILITIES: Record<AiProviderType, AiProviderCapabilities> = {
    openai: {
        supportsStructuredOutput: true,
        supportsStreaming: true,
        supportsToolCalling: true,
        maxContextLength: 128000,
    },
    openrouter: {
        supportsStructuredOutput: true,
        supportsStreaming: true,
        supportsToolCalling: true,
        maxContextLength: 128000,
    },
    ollama: {
        supportsStructuredOutput: true,
        supportsStreaming: true,
        supportsToolCalling: true,
        maxContextLength: 128000,
    },
    google: {
        supportsStructuredOutput: true,
        supportsStreaming: true,
        supportsToolCalling: true,
        maxContextLength: 1000000,
    },
    anthropic: {
        supportsStructuredOutput: true,
        supportsStreaming: true,
        supportsToolCalling: true,
        maxContextLength: 200000,
    },
    groq: {
        supportsStructuredOutput: true,
        supportsStreaming: true,
        supportsToolCalling: true,
        maxContextLength: 128000,
    },
    custom: {
        supportsStructuredOutput: true,
        supportsStreaming: true,
        supportsToolCalling: true,
        maxContextLength: 128000,
    },
};
