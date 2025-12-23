/**
 * Model Pricing Configuration
 * Last updated: December 2025
 *
 * Pricing per million tokens (USD)
 * Sources:
 * - OpenAI: https://openai.com/api/pricing/
 * - Anthropic: https://www.anthropic.com/pricing
 * - Google: https://ai.google.dev/gemini-api/docs/pricing
 * - Groq: https://groq.com/pricing
 */

export interface ModelPricing {
    /** Price per million input tokens (USD) */
    inputPricePerMillion: number;
    /** Price per million output tokens (USD) */
    outputPricePerMillion: number;
    /** Context window size in tokens */
    contextWindow: number;
    /** Maximum output tokens */
    maxOutputTokens?: number;
    /** Notes about the model */
    notes?: string;
}

export interface ProviderPricing {
    [modelName: string]: ModelPricing;
}

/**
 * Comprehensive pricing for all supported AI providers and models
 */
export const MODEL_PRICING: Record<string, ProviderPricing> = {
    // =========================================================================
    // OpenAI Models
    // =========================================================================
    openai: {
        // GPT-5 family (Latest - December 2025)
        'gpt-5.2': {
            inputPricePerMillion: 1.75,
            outputPricePerMillion: 14.0,
            contextWindow: 256000,
            maxOutputTokens: 32768,
            notes: 'Latest flagship (Dec 2025), 90% cache discount',
        },
        'gpt-5.2-thinking': {
            inputPricePerMillion: 1.75,
            outputPricePerMillion: 14.0,
            contextWindow: 256000,
            maxOutputTokens: 32768,
            notes: 'With reasoning capabilities, 40% higher than GPT-5.1',
        },
        'gpt-5.2-pro': {
            inputPricePerMillion: 21.0,
            outputPricePerMillion: 168.0,
            contextWindow: 256000,
            maxOutputTokens: 65536,
            notes: 'Premium tier for complex enterprise tasks',
        },
        'gpt-5.1': {
            inputPricePerMillion: 1.25,
            outputPricePerMillion: 10.0,
            contextWindow: 256000,
            maxOutputTokens: 32768,
            notes: 'November 2025, excellent value',
        },
        'gpt-5': {
            inputPricePerMillion: 1.25,
            outputPricePerMillion: 10.0,
            contextWindow: 256000,
            maxOutputTokens: 32768,
            notes: 'August 2025, very competitive pricing',
        },
        'gpt-5-mini': {
            inputPricePerMillion: 0.25,
            outputPricePerMillion: 2.0,
            contextWindow: 256000,
            maxOutputTokens: 32768,
            notes: 'Cost-effective GPT-5, 30-40% cheaper than GPT-4o',
        },
        'gpt-5-nano': {
            inputPricePerMillion: 0.05,
            outputPricePerMillion: 0.4,
            contextWindow: 128000,
            maxOutputTokens: 16384,
            notes: 'Smallest GPT-5, 95% cheaper than flagship, great for classification',
        },
        // GPT-4o family
        'gpt-4o': {
            inputPricePerMillion: 2.5,
            outputPricePerMillion: 10.0,
            contextWindow: 128000,
            maxOutputTokens: 16384,
            notes: 'Still supported, no deprecation planned',
        },
        'gpt-4o-mini': {
            inputPricePerMillion: 0.15,
            outputPricePerMillion: 0.6,
            contextWindow: 128000,
            maxOutputTokens: 16384,
            notes: 'Cost-effective, 60% cheaper than GPT-3.5 Turbo',
        },
        // GPT-4.1 family
        'gpt-4.1': {
            inputPricePerMillion: 2.0,
            outputPricePerMillion: 8.0,
            contextWindow: 128000,
            maxOutputTokens: 32768,
            notes: 'Intermediate upgrade, no deprecation planned',
        },
        // GPT-4 Turbo
        'gpt-4-turbo': {
            inputPricePerMillion: 10.0,
            outputPricePerMillion: 30.0,
            contextWindow: 128000,
            maxOutputTokens: 4096,
        },
        'gpt-4-turbo-preview': {
            inputPricePerMillion: 10.0,
            outputPricePerMillion: 30.0,
            contextWindow: 128000,
            maxOutputTokens: 4096,
        },
        // GPT-4
        'gpt-4': {
            inputPricePerMillion: 30.0,
            outputPricePerMillion: 60.0,
            contextWindow: 8192,
            maxOutputTokens: 8192,
            notes: 'Legacy, prefer GPT-5 for better value',
        },
        // GPT-3.5 Turbo
        'gpt-3.5-turbo': {
            inputPricePerMillion: 0.5,
            outputPricePerMillion: 1.5,
            contextWindow: 16385,
            maxOutputTokens: 4096,
            notes: 'Legacy, gpt-4o-mini is cheaper and better',
        },
        // o1 reasoning models
        o1: {
            inputPricePerMillion: 15.0,
            outputPricePerMillion: 60.0,
            contextWindow: 200000,
            maxOutputTokens: 100000,
            notes: 'Advanced reasoning model',
        },
        'o1-mini': {
            inputPricePerMillion: 3.0,
            outputPricePerMillion: 12.0,
            contextWindow: 128000,
            maxOutputTokens: 65536,
            notes: 'Smaller reasoning model',
        },
        'o1-preview': {
            inputPricePerMillion: 15.0,
            outputPricePerMillion: 60.0,
            contextWindow: 128000,
            maxOutputTokens: 32768,
        },
        // o3 models
        'o3-mini': {
            inputPricePerMillion: 1.1,
            outputPricePerMillion: 4.4,
            contextWindow: 200000,
            maxOutputTokens: 100000,
            notes: 'Efficient reasoning model',
        },
    },

    // =========================================================================
    // Anthropic (Claude) Models
    // =========================================================================
    anthropic: {
        // Claude Opus 4.5 (Latest - December 2025)
        'claude-opus-4.5': {
            inputPricePerMillion: 5.0,
            outputPricePerMillion: 25.0,
            contextWindow: 200000,
            maxOutputTokens: 32768,
            notes: 'Latest flagship (Dec 2025), 90% cache / 50% batch discount',
        },
        // Claude Sonnet 4.5 (Latest balanced)
        'claude-sonnet-4.5': {
            inputPricePerMillion: 3.0,
            outputPricePerMillion: 15.0,
            contextWindow: 200000,
            maxOutputTokens: 16384,
            notes: 'Balanced model, long-context: $6/$22.50',
        },
        // Claude Haiku 4.5
        'claude-haiku-4.5': {
            inputPricePerMillion: 1.0,
            outputPricePerMillion: 5.0,
            contextWindow: 200000,
            maxOutputTokens: 8192,
            notes: 'Speed optimized, cheapest Claude 4.x',
        },
        // Claude 3.5 family
        'claude-3-5-sonnet-latest': {
            inputPricePerMillion: 3.0,
            outputPricePerMillion: 15.0,
            contextWindow: 200000,
            maxOutputTokens: 8192,
            notes: 'Still supported, great for coding',
        },
        'claude-3-5-haiku-latest': {
            inputPricePerMillion: 0.8,
            outputPricePerMillion: 4.0,
            contextWindow: 200000,
            maxOutputTokens: 8192,
            notes: 'Fast and cost-effective',
        },
        // Claude 3 family (Legacy)
        'claude-3-opus-latest': {
            inputPricePerMillion: 15.0,
            outputPricePerMillion: 75.0,
            contextWindow: 200000,
            maxOutputTokens: 4096,
            notes: 'Legacy, prefer Opus 4.5 for better value',
        },
        'claude-3-haiku-latest': {
            inputPricePerMillion: 0.25,
            outputPricePerMillion: 1.25,
            contextWindow: 200000,
            maxOutputTokens: 4096,
            notes: 'Original Haiku, very cheap',
        },
    },

    // =========================================================================
    // Google (Gemini) Models
    // =========================================================================
    google: {
        // Gemini 3 family (Latest - December 2025)
        'gemini-3-pro-preview': {
            inputPricePerMillion: 2.0,
            outputPricePerMillion: 12.0,
            contextWindow: 1048576,
            maxOutputTokens: 64000,
            notes: 'Latest flagship (Nov 2025), >200k tokens: $4/$18',
        },
        'gemini-3-pro': {
            inputPricePerMillion: 2.0,
            outputPricePerMillion: 12.0,
            contextWindow: 1048576,
            maxOutputTokens: 64000,
            notes: 'Alias for gemini-3-pro-preview',
        },
        'gemini-3-flash-preview': {
            inputPricePerMillion: 0.5,
            outputPricePerMillion: 3.0,
            contextWindow: 1048576,
            notes: 'Dec 2025, 3x faster than 2.5 Pro, 30% fewer tokens',
        },
        'gemini-3-flash': {
            inputPricePerMillion: 0.5,
            outputPricePerMillion: 3.0,
            contextWindow: 1048576,
            notes: 'Free tier available with rate limits',
        },
        // Gemini 2.5 family
        'gemini-2.5-flash': {
            inputPricePerMillion: 0.3,
            outputPricePerMillion: 2.5,
            contextWindow: 1048576,
            notes: 'Enhanced Flash with better reasoning',
        },
        'gemini-2.5-pro': {
            inputPricePerMillion: 1.25,
            outputPricePerMillion: 10.0,
            contextWindow: 1048576,
            notes: 'Still supported, 50% batch discount',
        },
        // Gemini 2.0 family
        'gemini-2.0-flash': {
            inputPricePerMillion: 0.1,
            outputPricePerMillion: 0.4,
            contextWindow: 1048576,
            notes: 'Fast, cheap, 1M context - deprecation planned',
        },
        'gemini-2.0-flash-exp': {
            inputPricePerMillion: 0.1,
            outputPricePerMillion: 0.4,
            contextWindow: 1048576,
        },
        'gemini-2.0-flash-lite': {
            inputPricePerMillion: 0.1,
            outputPricePerMillion: 0.4,
            contextWindow: 1048576,
            notes: 'Lightweight version',
        },
        // Gemini 1.5 family (Legacy)
        'gemini-1.5-flash': {
            inputPricePerMillion: 0.075,
            outputPricePerMillion: 0.3,
            contextWindow: 1048576,
            notes: 'Previous generation, still very cheap',
        },
        'gemini-1.5-flash-8b': {
            inputPricePerMillion: 0.0375,
            outputPricePerMillion: 0.15,
            contextWindow: 1048576,
            notes: 'Smallest Flash, cheapest option',
        },
        'gemini-1.5-pro': {
            inputPricePerMillion: 1.25,
            outputPricePerMillion: 5.0,
            contextWindow: 2097152,
            notes: '2M context window',
        },
    },

    // =========================================================================
    // Groq Models (Ultra-fast inference)
    // =========================================================================
    groq: {
        // OpenAI Open Models on Groq
        'openai/gpt-oss-120b': {
            inputPricePerMillion: 0.15,
            outputPricePerMillion: 0.75,
            contextWindow: 128000,
            notes: 'OpenAI MoE 120B (5.1B active), 500+ tok/sec, 50% cache discount',
        },
        'openai/gpt-oss-20b': {
            inputPricePerMillion: 0.05,
            outputPricePerMillion: 0.25,
            contextWindow: 128000,
            notes: 'Smaller OpenAI open model, ultra-cheap',
        },
        // Llama 3.3 family
        'llama-3.3-70b-versatile': {
            inputPricePerMillion: 0.59,
            outputPricePerMillion: 0.79,
            contextWindow: 128000,
            notes: 'Best Llama model, very fast',
        },
        'llama-3.3-70b-specdec': {
            inputPricePerMillion: 0.59,
            outputPricePerMillion: 0.99,
            contextWindow: 8192,
            notes: 'Speculative decoding variant',
        },
        // Llama 3.1 family
        'llama-3.1-70b-versatile': {
            inputPricePerMillion: 0.59,
            outputPricePerMillion: 0.79,
            contextWindow: 128000,
        },
        'llama-3.1-8b-instant': {
            inputPricePerMillion: 0.05,
            outputPricePerMillion: 0.08,
            contextWindow: 128000,
            notes: 'Fastest, cheapest option',
        },
        // Llama 3.2 family
        'llama-3.2-90b-vision-preview': {
            inputPricePerMillion: 0.9,
            outputPricePerMillion: 0.9,
            contextWindow: 128000,
            notes: 'Vision capable',
        },
        'llama-3.2-11b-vision-preview': {
            inputPricePerMillion: 0.18,
            outputPricePerMillion: 0.18,
            contextWindow: 128000,
            notes: 'Smaller vision model',
        },
        'llama-3.2-3b-preview': {
            inputPricePerMillion: 0.06,
            outputPricePerMillion: 0.06,
            contextWindow: 128000,
        },
        'llama-3.2-1b-preview': {
            inputPricePerMillion: 0.04,
            outputPricePerMillion: 0.04,
            contextWindow: 128000,
            notes: 'Smallest, for edge use cases',
        },
        // Gemma
        'gemma2-9b-it': {
            inputPricePerMillion: 0.2,
            outputPricePerMillion: 0.2,
            contextWindow: 8192,
        },
        // DeepSeek on Groq
        'deepseek-r1-distill-llama-70b': {
            inputPricePerMillion: 0.75,
            outputPricePerMillion: 0.99,
            contextWindow: 128000,
            notes: 'DeepSeek R1 distilled to Llama',
        },
        // Qwen
        'qwen-qwq-32b': {
            inputPricePerMillion: 0.29,
            outputPricePerMillion: 0.39,
            contextWindow: 128000,
        },
    },

    // =========================================================================
    // OpenRouter (Aggregator - unified API for 400+ models)
    // Pricing: https://openrouter.ai/models
    // Note: OpenRouter charges 5.5% fee on credit purchases, but model pricing
    // is passed through without markup
    // =========================================================================
    openrouter: {
        // OpenAI GPT-5 models (Latest)
        'openai/gpt-5.2': {
            inputPricePerMillion: 1.75,
            outputPricePerMillion: 14.0,
            contextWindow: 256000,
            notes: 'Latest flagship (Dec 2025)',
        },
        'openai/gpt-5.1': {
            inputPricePerMillion: 1.25,
            outputPricePerMillion: 10.0,
            contextWindow: 256000,
        },
        'openai/gpt-5': {
            inputPricePerMillion: 1.25,
            outputPricePerMillion: 10.0,
            contextWindow: 256000,
        },
        'openai/gpt-5-mini': {
            inputPricePerMillion: 0.25,
            outputPricePerMillion: 2.0,
            contextWindow: 256000,
        },
        'openai/gpt-5-nano': {
            inputPricePerMillion: 0.05,
            outputPricePerMillion: 0.4,
            contextWindow: 128000,
        },
        // OpenAI GPT-4 models
        'openai/gpt-4o': {
            inputPricePerMillion: 2.5,
            outputPricePerMillion: 10.0,
            contextWindow: 128000,
            notes: 'Same as direct OpenAI pricing',
        },
        'openai/gpt-4o-mini': {
            inputPricePerMillion: 0.15,
            outputPricePerMillion: 0.6,
            contextWindow: 128000,
        },
        'openai/gpt-4-turbo': {
            inputPricePerMillion: 10.0,
            outputPricePerMillion: 30.0,
            contextWindow: 128000,
        },
        'openai/o1': {
            inputPricePerMillion: 15.0,
            outputPricePerMillion: 60.0,
            contextWindow: 200000,
        },
        'openai/o1-mini': {
            inputPricePerMillion: 3.0,
            outputPricePerMillion: 12.0,
            contextWindow: 128000,
        },
        'openai/o3-mini': {
            inputPricePerMillion: 1.1,
            outputPricePerMillion: 4.4,
            contextWindow: 200000,
        },
        // Anthropic models (Latest)
        'anthropic/claude-opus-4.5': {
            inputPricePerMillion: 5.0,
            outputPricePerMillion: 25.0,
            contextWindow: 200000,
            notes: 'Latest flagship (Dec 2025)',
        },
        'anthropic/claude-sonnet-4.5': {
            inputPricePerMillion: 3.0,
            outputPricePerMillion: 15.0,
            contextWindow: 200000,
            notes: 'Latest balanced model',
        },
        'anthropic/claude-haiku-4.5': {
            inputPricePerMillion: 1.0,
            outputPricePerMillion: 5.0,
            contextWindow: 200000,
            notes: 'Latest fast model',
        },
        'anthropic/claude-3.5-sonnet': {
            inputPricePerMillion: 3.0,
            outputPricePerMillion: 15.0,
            contextWindow: 200000,
        },
        'anthropic/claude-3.5-haiku': {
            inputPricePerMillion: 0.8,
            outputPricePerMillion: 4.0,
            contextWindow: 200000,
        },
        'anthropic/claude-3-haiku': {
            inputPricePerMillion: 0.25,
            outputPricePerMillion: 1.25,
            contextWindow: 200000,
            notes: 'Original Haiku, very cheap',
        },
        'anthropic/claude-3-opus': {
            inputPricePerMillion: 15.0,
            outputPricePerMillion: 75.0,
            contextWindow: 200000,
        },
        // Google Gemini models (Latest)
        'google/gemini-3-pro': {
            inputPricePerMillion: 2.0,
            outputPricePerMillion: 12.0,
            contextWindow: 1048576,
            notes: 'Latest flagship (Nov 2025)',
        },
        'google/gemini-3-flash': {
            inputPricePerMillion: 0.5,
            outputPricePerMillion: 3.0,
            contextWindow: 1048576,
            notes: 'Dec 2025, free tier available',
        },
        'google/gemini-2.0-flash': {
            inputPricePerMillion: 0.1,
            outputPricePerMillion: 0.4,
            contextWindow: 1048576,
            notes: 'Very cheap with 1M context',
        },
        'google/gemini-2.0-flash-exp:free': {
            inputPricePerMillion: 0,
            outputPricePerMillion: 0,
            contextWindow: 1048576,
            notes: 'Free tier with rate limits (50/day or 1000/day with credits)',
        },
        'google/gemini-2.5-pro-preview': {
            inputPricePerMillion: 1.25,
            outputPricePerMillion: 10.0,
            contextWindow: 1048576,
        },
        'google/gemini-1.5-flash': {
            inputPricePerMillion: 0.075,
            outputPricePerMillion: 0.3,
            contextWindow: 1048576,
        },
        // Meta Llama models
        'meta-llama/llama-3.3-70b-instruct': {
            inputPricePerMillion: 0.1,
            outputPricePerMillion: 0.32,
            contextWindow: 128000,
            notes: 'Via DeepInfra, very cheap',
        },
        'meta-llama/llama-3.3-70b-instruct:free': {
            inputPricePerMillion: 0,
            outputPricePerMillion: 0,
            contextWindow: 128000,
            notes: 'Free tier with rate limits',
        },
        'meta-llama/llama-3.1-405b-instruct': {
            inputPricePerMillion: 0.4,
            outputPricePerMillion: 0.4,
            contextWindow: 131072,
            notes: 'Largest open model',
        },
        'meta-llama/llama-3.1-70b-instruct': {
            inputPricePerMillion: 0.02,
            outputPricePerMillion: 0.03,
            contextWindow: 131072,
        },
        'meta-llama/llama-3.1-8b-instruct': {
            inputPricePerMillion: 0.02,
            outputPricePerMillion: 0.02,
            contextWindow: 131072,
            notes: 'Cheapest Llama option',
        },
        // DeepSeek models
        'deepseek/deepseek-chat': {
            inputPricePerMillion: 0.2,
            outputPricePerMillion: 0.88,
            contextWindow: 64000,
            notes: 'DeepSeek V3 latest',
        },
        'deepseek/deepseek-r1': {
            inputPricePerMillion: 0.55,
            outputPricePerMillion: 2.19,
            contextWindow: 64000,
            notes: 'Reasoning model',
        },
        'deepseek/deepseek-r1:free': {
            inputPricePerMillion: 0,
            outputPricePerMillion: 0,
            contextWindow: 64000,
            notes: 'Free tier with rate limits',
        },
        // Qwen models
        'qwen/qwen-2.5-72b-instruct': {
            inputPricePerMillion: 0.15,
            outputPricePerMillion: 0.4,
            contextWindow: 131072,
        },
        'qwen/qwq-32b': {
            inputPricePerMillion: 0.12,
            outputPricePerMillion: 0.18,
            contextWindow: 131072,
            notes: 'Reasoning model',
        },
        // xAI Grok models
        'x-ai/grok-3-mini-beta': {
            inputPricePerMillion: 0.3,
            outputPricePerMillion: 0.5,
            contextWindow: 131072,
            notes: 'xAI Grok 3 Mini',
        },
        'x-ai/grok-3-beta': {
            inputPricePerMillion: 3.0,
            outputPricePerMillion: 15.0,
            contextWindow: 131072,
        },
    },

    // =========================================================================
    // Ollama (Local - no API cost)
    // =========================================================================
    ollama: {
        // All Ollama models are free (local compute)
        'llama3.3': {
            inputPricePerMillion: 0,
            outputPricePerMillion: 0,
            contextWindow: 128000,
            notes: 'Local, hardware cost only',
        },
        'llama3.2': {
            inputPricePerMillion: 0,
            outputPricePerMillion: 0,
            contextWindow: 128000,
        },
        'llama3.1': {
            inputPricePerMillion: 0,
            outputPricePerMillion: 0,
            contextWindow: 128000,
        },
        gemma2: {
            inputPricePerMillion: 0,
            outputPricePerMillion: 0,
            contextWindow: 8192,
        },
        'qwen2.5': {
            inputPricePerMillion: 0,
            outputPricePerMillion: 0,
            contextWindow: 128000,
        },
        'deepseek-r1': {
            inputPricePerMillion: 0,
            outputPricePerMillion: 0,
            contextWindow: 128000,
        },
    },
};

/**
 * Get pricing for a specific model
 */
export function getModelPricing(provider: string, model: string): ModelPricing | null {
    const providerPricing = MODEL_PRICING[provider.toLowerCase()];
    if (!providerPricing) return null;

    // Try exact match first
    if (providerPricing[model]) {
        return providerPricing[model];
    }

    // Try to find a matching model (partial match)
    const modelLower = model.toLowerCase();
    for (const [key, pricing] of Object.entries(providerPricing)) {
        if (key.toLowerCase().includes(modelLower) || modelLower.includes(key.toLowerCase())) {
            return pricing;
        }
    }

    return null;
}

/**
 * Calculate the cost for a request
 */
export function calculateRequestCost(
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
): number {
    const pricing = getModelPricing(provider, model);
    if (!pricing) return 0;

    const inputCost = (inputTokens / 1_000_000) * pricing.inputPricePerMillion;
    const outputCost = (outputTokens / 1_000_000) * pricing.outputPricePerMillion;

    return inputCost + outputCost;
}

/**
 * Get estimated cost per 1000 requests (assuming average token usage)
 * Useful for capacity planning
 */
export function estimateCostPer1000Requests(
    provider: string,
    model: string,
    avgInputTokens: number = 500,
    avgOutputTokens: number = 500,
): number {
    return calculateRequestCost(provider, model, avgInputTokens * 1000, avgOutputTokens * 1000);
}

/**
 * Compare costs between two models for the same workload
 */
export function compareCosts(
    provider1: string,
    model1: string,
    provider2: string,
    model2: string,
    inputTokens: number = 1_000_000,
    outputTokens: number = 1_000_000,
): {
    model1Cost: number;
    model2Cost: number;
    savings: number;
    savingsPercent: number;
} {
    const cost1 = calculateRequestCost(provider1, model1, inputTokens, outputTokens);
    const cost2 = calculateRequestCost(provider2, model2, inputTokens, outputTokens);

    const savings = cost1 - cost2;
    const savingsPercent = cost1 > 0 ? (savings / cost1) * 100 : 0;

    return {
        model1Cost: cost1,
        model2Cost: cost2,
        savings,
        savingsPercent,
    };
}

/**
 * Get the cheapest model for a provider
 */
export function getCheapestModel(
    provider: string,
): { model: string; pricing: ModelPricing } | null {
    const providerPricing = MODEL_PRICING[provider.toLowerCase()];
    if (!providerPricing) return null;

    let cheapest: { model: string; pricing: ModelPricing } | null = null;
    let lowestCost = Infinity;

    for (const [model, pricing] of Object.entries(providerPricing)) {
        // Use combined input + output cost as metric
        const combinedCost = pricing.inputPricePerMillion + pricing.outputPricePerMillion;
        if (combinedCost < lowestCost) {
            lowestCost = combinedCost;
            cheapest = { model, pricing };
        }
    }

    return cheapest;
}

/**
 * Get all models sorted by cost (cheapest first)
 */
export function getAllModelsSortedByCost(): Array<{
    provider: string;
    model: string;
    pricing: ModelPricing;
    combinedCostPerMillion: number;
}> {
    const allModels: Array<{
        provider: string;
        model: string;
        pricing: ModelPricing;
        combinedCostPerMillion: number;
    }> = [];

    for (const [provider, models] of Object.entries(MODEL_PRICING)) {
        for (const [model, pricing] of Object.entries(models)) {
            allModels.push({
                provider,
                model,
                pricing,
                combinedCostPerMillion:
                    pricing.inputPricePerMillion + pricing.outputPricePerMillion,
            });
        }
    }

    return allModels.sort((a, b) => a.combinedCostPerMillion - b.combinedCostPerMillion);
}

/**
 * Recommended models by tier (based on cost/performance ratio)
 * Updated: December 2025
 */
export const RECOMMENDED_MODELS_BY_TIER = {
    /** Ultra-cheap: < $1 per million combined */
    economy: [
        { provider: 'ollama', model: 'llama3.3', note: 'Free (local)' },
        {
            provider: 'openrouter',
            model: 'meta-llama/llama-3.3-70b-instruct:free',
            note: 'Free with limits',
        },
        { provider: 'groq', model: 'llama-3.1-8b-instant', note: '$0.13/M, ultra-fast' },
        { provider: 'openai', model: 'gpt-5-nano', note: '$0.45/M, smallest GPT-5' },
        { provider: 'google', model: 'gemini-2.0-flash', note: '$0.50/M, 1M context' },
        { provider: 'openai', model: 'gpt-4o-mini', note: '$0.75/M, excellent quality' },
        { provider: 'groq', model: 'openai/gpt-oss-120b', note: '$0.90/M, OpenAI open model' },
    ],
    /** Standard: $1 - $12 per million combined */
    standard: [
        { provider: 'groq', model: 'llama-3.3-70b-versatile', note: '$1.38/M, fast + capable' },
        { provider: 'openai', model: 'gpt-5-mini', note: '$2.25/M, cost-effective GPT-5' },
        { provider: 'google', model: 'gemini-2.5-flash', note: '$2.80/M, thinking mode' },
        { provider: 'google', model: 'gemini-3-flash-preview', note: '$3.50/M, 3x faster' },
        {
            provider: 'anthropic',
            model: 'claude-3-5-haiku-latest',
            note: '$4.80/M, great for code',
        },
        { provider: 'anthropic', model: 'claude-haiku-4.5', note: '$6/M, latest Haiku' },
        { provider: 'openai', model: 'gpt-5.1', note: '$11.25/M, Nov 2025 flagship' },
        { provider: 'openai', model: 'gpt-5', note: '$11.25/M, Aug 2025 flagship' },
        { provider: 'google', model: 'gemini-2.5-pro', note: '$11.25/M, large context' },
    ],
    /** Premium: > $12 per million combined (best quality) */
    premium: [
        { provider: 'openai', model: 'gpt-4o', note: '$12.50/M, still excellent' },
        { provider: 'google', model: 'gemini-3-pro', note: '$14/M, 1M context' },
        { provider: 'openai', model: 'gpt-5.2', note: '$15.75/M, Dec 2025 flagship' },
        { provider: 'openai', model: 'gpt-5.1', note: '$11.25/M, Nov 2025 flagship' },
        { provider: 'anthropic', model: 'claude-sonnet-4.5', note: '$18/M, balanced' },
        { provider: 'anthropic', model: 'claude-opus-4.5', note: '$30/M, most capable' },
    ],
};
