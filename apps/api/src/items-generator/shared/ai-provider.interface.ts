import { type ChatAnthropic } from '@langchain/anthropic';
import { type ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { type ChatGroq } from '@langchain/groq';
import { type ChatMistralAI } from '@langchain/mistralai';
import { type ChatOpenAI } from '@langchain/openai';

export type AiProviderType = 'openai' | 'google' | 'anthropic' | 'mistral' | 'groq' | 'deepseek';

export type BaseChatModel =
    | ChatOpenAI
    | ChatGoogleGenerativeAI
    | ChatAnthropic
    | ChatMistralAI
    | ChatGroq;

export interface AiProviderConfig {
    type: AiProviderType;
    apiKey?: string;
    modelName?: string;
    temperature?: number;
    enabled?: boolean;
    maxTokens?: number;
    baseURL?: string;
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
    costPerToken?: {
        input: number;
        output: number;
    };
}

export const AI_PROVIDER_CAPABILITIES: Record<AiProviderType, AiProviderCapabilities> = {
    openai: {
        supportsStructuredOutput: true,
        supportsStreaming: true,
        supportsToolCalling: true,
        maxContextLength: 128000,
        costPerToken: {
            input: 0.0025,
            output: 0.01,
        },
    },
    google: {
        supportsStructuredOutput: true,
        supportsStreaming: true,
        supportsToolCalling: true,
        maxContextLength: 1000000,
        costPerToken: {
            input: 0.00125,
            output: 0.005,
        },
    },
    anthropic: {
        supportsStructuredOutput: true,
        supportsStreaming: true,
        supportsToolCalling: true,
        maxContextLength: 200000,
        costPerToken: {
            input: 0.003,
            output: 0.015,
        },
    },
    mistral: {
        supportsStructuredOutput: true,
        supportsStreaming: true,
        supportsToolCalling: true,
        maxContextLength: 32000,
        costPerToken: {
            input: 0.002,
            output: 0.006,
        },
    },
    groq: {
        supportsStructuredOutput: true,
        supportsStreaming: true,
        supportsToolCalling: true,
        maxContextLength: 32000,
        costPerToken: {
            input: 0.0001,
            output: 0.0001,
        },
    },
    deepseek: {
        supportsStructuredOutput: true,
        supportsStreaming: true,
        supportsToolCalling: true,
        maxContextLength: 32000,
        costPerToken: {
            input: 0.00014,
            output: 0.00028,
        },
    },
};
