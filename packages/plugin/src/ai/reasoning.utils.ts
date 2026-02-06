/**
 * Reasoning configuration utilities for AI models.
 * Manages reasoning effort settings across different providers.
 */

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
		openrouter: { reasoning: { effort: 'none' } }
	},
	{
		pattern: /gpt-5(?!\.\d)/,
		openai: { reasoning: { effort: 'minimal' } },
		openrouter: { reasoning: { effort: 'minimal' } }
	},
	{
		pattern: /^o[134]/,
		openai: { reasoning: { effort: 'minimal' } },
		openrouter: { reasoning: { effort: 'minimal' } }
	},
	{
		pattern: /gemini-[23]/,
		google: { reasoning_effort: 'none' },
		openrouter: { reasoning: { effort: 'none' } }
	},
	{
		pattern: /claude-(sonnet|opus)-[4-9]|claude-3-[5-9]/,
		openrouter: { reasoning: { effort: 'none' } }
	},
	{
		pattern: /deepseek-r|deepseek-reasoner/,
		openrouter: { reasoning: { effort: 'low' } }
	},
	{
		pattern: /gpt-oss/,
		groq: { reasoning_effort: 'low', reasoning_format: 'hidden' }
	},
	{
		pattern: /qwen3/,
		groq: { reasoning_effort: 'none' }
	}
];

/**
 * Extract the model name from a potentially namespaced model string.
 * e.g., "openai/gpt-5.2" -> "gpt-5.2"
 */
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

/**
 * Get reasoning model kwargs for a given provider type and model.
 * Returns undefined if no reasoning config is needed.
 */
export function getReasoningConfig(providerType: string, model?: string): Record<string, unknown> | undefined {
	const config = findReasoningConfig(model);
	if (!config) return undefined;

	switch (providerType) {
		case 'openai':
			return config.openai;
		case 'openrouter':
			return config.openrouter;
		case 'google':
			return config.google;
		case 'groq':
			return config.groq;
		default:
			return undefined;
	}
}

/**
 * Provider-specific reasoning config getters (for backward compatibility)
 */
export function getOpenAIReasoningConfig(
	model?: string
): { reasoning: { effort: 'none' | 'low' | 'minimal' } } | undefined {
	return findReasoningConfig(model)?.openai;
}

export function getOpenRouterReasoningConfig(
	model?: string
): { reasoning: { effort: 'none' | 'low' | 'minimal' } } | undefined {
	return findReasoningConfig(model)?.openrouter;
}

export function getGoogleReasoningConfig(model?: string): { reasoning_effort: 'none' } | undefined {
	return findReasoningConfig(model)?.google;
}

export function getGroqReasoningConfig(
	model?: string
): { reasoning_effort: 'none' | 'low'; reasoning_format?: 'hidden' } | undefined {
	return findReasoningConfig(model)?.groq;
}
