type ReasoningConfig = {
    pattern: RegExp;
    openai?: { reasoning: { effort: 'none' | 'low' | 'minimal' } };
    openrouter?: { reasoning: { effort: 'none' | 'low' | 'minimal' } };
    google?: { reasoning_effort: 'none' };
    groq?: { reasoning_effort: 'none' | 'low'; reasoning_format?: 'hidden' };
};

const REASONING_MODELS: ReasoningConfig[] = [
    {
        pattern: /gpt-5\.[1-9]/,
        openai: { reasoning: { effort: 'none' } },
        openrouter: { reasoning: { effort: 'none' } },
    },
    {
        pattern: /gpt-5(?!\.\d)/,
        openai: { reasoning: { effort: 'minimal' } },
        openrouter: { reasoning: { effort: 'minimal' } },
    },
    {
        pattern: /^o[134]/,
        openai: { reasoning: { effort: 'low' } },
        openrouter: { reasoning: { effort: 'low' } },
    },
    {
        pattern: /gemini-[23]/,
        google: { reasoning_effort: 'none' },
        openrouter: { reasoning: { effort: 'none' } },
    },
    {
        pattern: /claude-(sonnet|opus)-[4-9]|claude-3-[5-9]/,
        openrouter: { reasoning: { effort: 'none' } },
    },
    {
        pattern: /deepseek-r|deepseek-reasoner/,
        openrouter: { reasoning: { effort: 'low' } },
    },
    {
        pattern: /gpt-oss/,
        groq: { reasoning_effort: 'low', reasoning_format: 'hidden' },
    },
    {
        pattern: /qwen3/,
        groq: { reasoning_effort: 'none' },
    },
];

export function extractModelName(model?: string): string {
    if (!model) return '';
    const parts = model.split('/');
    return parts[parts.length - 1];
}

function findReasoningConfig(model?: string): ReasoningConfig | undefined {
    const name = extractModelName(model);
    if (!name) return undefined;
    return REASONING_MODELS.find((config) => config.pattern.test(name));
}

export function getOpenAIReasoningConfig(
    model?: string,
): { reasoning: { effort: 'none' | 'low' | 'minimal' } } | undefined {
    return findReasoningConfig(model)?.openai;
}

export function getOpenRouterReasoningConfig(
    model?: string,
): { reasoning: { effort: 'none' | 'low' | 'minimal' } } | undefined {
    return findReasoningConfig(model)?.openrouter;
}

export function getGoogleReasoningConfig(model?: string): { reasoning_effort: 'none' } | undefined {
    return findReasoningConfig(model)?.google;
}

export function getGroqReasoningConfig(
    model?: string,
): { reasoning_effort: 'none' | 'low'; reasoning_format?: 'hidden' } | undefined {
    return findReasoningConfig(model)?.groq;
}
