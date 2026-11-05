/**
 * Reasoning configuration utilities for AI models.
 * Manages reasoning effort settings across different providers.
 */

type Effort = 'none' | 'minimal' | 'low' | 'medium';

type ReasoningConfig = {
	pattern: RegExp;
	openai?: { reasoning: { effort: Effort } };
	openrouter?: { reasoning: { effort: Effort } };
	google?: { reasoning_effort: Effort };
	groq?: { reasoning_effort: 'none' | 'low'; include_reasoning?: boolean };
};

/**
 * Each entry asks for the LOWEST reasoning effort the matched models accept
 * (first match wins, so specific patterns come first). Patterns match the bare
 * model name, after `extractModelName` strips any `provider/` or `models/`
 * prefix. A provider that rejects the value anyway is handled by
 * `AiOperations.withParamRetry`, which drops the parameter and retries.
 *
 * Current families checked 2026-11-05:
 *  - OpenAI per-model pages https://developers.openai.com/api/docs/models/<id>:
 *    gpt-6-astra and gpt-6.1-sol support `low` … `max` (no `none`); gpt-6-luna,
 *    gpt-6-sol, gpt-6.1-terra and gpt-5.6-* support `none` … `max`.
 *  - Google https://aistudio.google.com/docs/openai: "Reasoning cannot be
 *    turned off for Gemini 2.5 Pro or 3 models"; Gemini 4 Argon maps `minimal`
 *    to `low`, and Gemini 3.8 Flash rejects `minimal`.
 *  - OpenRouter https://openrouter.ai/api/v1/models (`reasoning.mandatory`,
 *    `supported_efforts`): Claude Opus/Sonnet 5.5 and Fable are mandatory
 *    (lowest `low`); Claude Haiku 5.5 accepts `none`; Gemini 3.5 Flash-Lite /
 *    3.6 Flash accept `minimal`, 3.7+/4 only `low` and up; gpt-5.2/5.4/5.5-pro
 *    accept only `medium` and up; gpt-5.1-codex* and gpt-5.2-codex are mandatory
 *    (lowest `low`).
 *  - Groq https://console.groq.com/docs/reasoning: for gpt-oss "the
 *    `reasoning_format` parameter is not supported"; `include_reasoning: false`
 *    hides the reasoning instead.
 */
const REASONING_MODELS: ReasoningConfig[] = [
	{
		pattern: /^gpt-6-astra|^gpt-6\.1-sol|^gpt-6\.\d+-[a-z]+-pro/,
		openai: { reasoning: { effort: 'low' } },
		openrouter: { reasoning: { effort: 'low' } }
	},
	{
		pattern: /^gpt-6/,
		openai: { reasoning: { effort: 'none' } },
		openrouter: { reasoning: { effort: 'none' } }
	},
	{
		pattern: /gpt-5\.[2-5]-pro/,
		openai: { reasoning: { effort: 'medium' } },
		openrouter: { reasoning: { effort: 'medium' } }
	},
	{
		pattern: /gpt-5\.[12]-codex/,
		openai: { reasoning: { effort: 'low' } },
		openrouter: { reasoning: { effort: 'low' } }
	},
	{
		pattern: /gpt-5\.[1-9]/,
		openai: { reasoning: { effort: 'none' } },
		openrouter: { reasoning: { effort: 'none' } }
	},
	{
		pattern: /gpt-5(?!\.\d)(?!-[a-z])/,
		openai: { reasoning: { effort: 'minimal' } },
		openrouter: { reasoning: { effort: 'minimal' } }
	},
	{
		pattern: /^o[134]/,
		openai: { reasoning: { effort: 'minimal' } },
		openrouter: { reasoning: { effort: 'minimal' } }
	},
	{
		pattern: /gemini-(?:[4-9]|3\.[7-9])|gemini-(?:2\.5|3(?:\.\d+)?)-pro/,
		google: { reasoning_effort: 'low' },
		openrouter: { reasoning: { effort: 'low' } }
	},
	{
		pattern: /gemini-3/,
		google: { reasoning_effort: 'minimal' },
		openrouter: { reasoning: { effort: 'minimal' } }
	},
	{
		pattern: /gemini-2/,
		google: { reasoning_effort: 'none' },
		openrouter: { reasoning: { effort: 'none' } }
	},
	{
		pattern: /claude-(?:opus|sonnet)-5[.-]5|claude-fable/,
		openrouter: { reasoning: { effort: 'low' } }
	},
	{
		pattern: /claude-(sonnet|opus)-[4-9]|claude-haiku-[5-9]|claude-3-[5-9]/,
		openrouter: { reasoning: { effort: 'none' } }
	},
	{
		pattern: /deepseek-r|deepseek-reasoner/,
		openrouter: { reasoning: { effort: 'low' } }
	},
	{
		pattern: /gpt-oss/,
		groq: { reasoning_effort: 'low', include_reasoning: false }
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
 * Resolve provider-specific reasoning kwargs for a given model.
 *
 * Matches the model name against the `REASONING_MODELS` registry and, on a hit,
 * returns the slice of config that belongs to `providerType`. Any provider not
 * known to the registry returns `undefined` — callers should treat that as
 * "no reasoning features for this model on this provider" and fall back to the
 * provider's default request shape.
 *
 * @param providerType - Provider name. Recognised values: `openai`, `openrouter`, `google`, `groq`.
 * @param model - Model identifier. May be bare (`gpt-5`) or namespaced (`openai/gpt-5`); the
 *   namespace prefix is stripped before lookup.
 * @returns Provider-specific reasoning kwargs, or `undefined` if the model is not in the
 *   reasoning registry or the provider is unknown.
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
 * Provider-specific reasoning-config getters (for backward compatibility).
 *
 * Each helper is a thin wrapper that resolves the model against the reasoning
 * registry and returns just that provider's slice of config — convenient when
 * the caller is already locked to one provider and does not need the
 * dispatcher in `getReasoningConfig`. All return `undefined` when the model is
 * not a reasoning model on that provider.
 */
export function getOpenAIReasoningConfig(model?: string): { reasoning: { effort: Effort } } | undefined {
	return findReasoningConfig(model)?.openai;
}

export function getOpenRouterReasoningConfig(model?: string): { reasoning: { effort: Effort } } | undefined {
	return findReasoningConfig(model)?.openrouter;
}

export function getGoogleReasoningConfig(model?: string): { reasoning_effort: Effort } | undefined {
	return findReasoningConfig(model)?.google;
}

export function getGroqReasoningConfig(
	model?: string
): { reasoning_effort: 'none' | 'low'; include_reasoning?: boolean } | undefined {
	return findReasoningConfig(model)?.groq;
}
