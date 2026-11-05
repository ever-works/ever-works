import { describe, expect, it } from 'vitest';
import {
	extractModelName,
	getGoogleReasoningConfig,
	getGroqReasoningConfig,
	getOpenAIReasoningConfig,
	getOpenRouterReasoningConfig,
	getReasoningConfig
} from '../reasoning.utils.js';

describe('extractModelName', () => {
	it('returns the empty string for undefined input', () => {
		expect(extractModelName()).toBe('');
		expect(extractModelName(undefined)).toBe('');
	});

	it('returns the empty string for an empty input', () => {
		expect(extractModelName('')).toBe('');
	});

	it('returns the input as-is when there is no namespace', () => {
		expect(extractModelName('gpt-5.2')).toBe('gpt-5.2');
	});

	it('strips a single namespace prefix', () => {
		expect(extractModelName('openai/gpt-5.2')).toBe('gpt-5.2');
	});

	it('returns only the last segment for multi-level namespaces', () => {
		expect(extractModelName('foo/bar/baz/gpt-5.2')).toBe('gpt-5.2');
	});

	it('returns empty string when input ends with a slash', () => {
		expect(extractModelName('openai/')).toBe('');
	});
});

describe('getReasoningConfig — gpt-5.x effort=none/minimal split', () => {
	it('gpt-5.1+ → openai effort=none', () => {
		expect(getReasoningConfig('openai', 'gpt-5.1')).toEqual({ reasoning: { effort: 'none' } });
		expect(getReasoningConfig('openai', 'gpt-5.2')).toEqual({ reasoning: { effort: 'none' } });
		expect(getReasoningConfig('openai', 'gpt-5.9')).toEqual({ reasoning: { effort: 'none' } });
		expect(getReasoningConfig('openrouter', 'openai/gpt-5.2')).toEqual({
			reasoning: { effort: 'none' }
		});
	});

	it('plain gpt-5 → openai effort=minimal (the lookahead excludes 5.x and 5-suffix variants)', () => {
		expect(getReasoningConfig('openai', 'gpt-5')).toEqual({ reasoning: { effort: 'minimal' } });
		expect(getReasoningConfig('openrouter', 'openai/gpt-5')).toEqual({
			reasoning: { effort: 'minimal' }
		});
	});

	it('returns undefined for the gpt-5-mini / gpt-5-nano variants (lookahead exclusion)', () => {
		expect(getReasoningConfig('openai', 'gpt-5-mini')).toBeUndefined();
		expect(getReasoningConfig('openai', 'gpt-5-nano')).toBeUndefined();
	});
});

describe('getReasoningConfig — o-series', () => {
	it('o1/o3/o4 → effort=minimal', () => {
		expect(getReasoningConfig('openai', 'o1')).toEqual({ reasoning: { effort: 'minimal' } });
		expect(getReasoningConfig('openai', 'o3')).toEqual({ reasoning: { effort: 'minimal' } });
		expect(getReasoningConfig('openai', 'o4')).toEqual({ reasoning: { effort: 'minimal' } });
		expect(getReasoningConfig('openai', 'o3-mini')).toEqual({ reasoning: { effort: 'minimal' } });
	});

	it('o2 is NOT in the pattern (^o[134])', () => {
		expect(getReasoningConfig('openai', 'o2')).toBeUndefined();
	});
});

describe('getReasoningConfig — gemini & claude on openrouter', () => {
	it('gemini-2 (non-Pro) → google effort=none; Gemini 3 Pro cannot turn reasoning off → low', () => {
		expect(getReasoningConfig('google', 'gemini-2.0-flash')).toEqual({ reasoning_effort: 'none' });
		// "Reasoning cannot be turned off for Gemini 2.5 Pro or 3 models"
		// (https://aistudio.google.com/docs/openai, checked 2026-11-05).
		expect(getReasoningConfig('google', 'gemini-3-pro')).toEqual({ reasoning_effort: 'low' });
	});

	it('gemini-2 → openrouter effort=none', () => {
		expect(getReasoningConfig('openrouter', 'google/gemini-2.0-flash')).toEqual({
			reasoning: { effort: 'none' }
		});
	});

	it('claude sonnet/opus 4–9 → openrouter effort=none, but no openai/google config', () => {
		expect(getReasoningConfig('openrouter', 'anthropic/claude-sonnet-4')).toEqual({
			reasoning: { effort: 'none' }
		});
		expect(getReasoningConfig('openrouter', 'anthropic/claude-opus-5')).toEqual({
			reasoning: { effort: 'none' }
		});
		expect(getReasoningConfig('openai', 'anthropic/claude-sonnet-4')).toBeUndefined();
		expect(getReasoningConfig('google', 'anthropic/claude-sonnet-4')).toBeUndefined();
	});

	it('claude-3-5+ → openrouter effort=none', () => {
		expect(getReasoningConfig('openrouter', 'anthropic/claude-3-5-sonnet')).toEqual({
			reasoning: { effort: 'none' }
		});
	});

	it('claude-3-1 → no match (only 3-5..3-9 and 4–9)', () => {
		expect(getReasoningConfig('openrouter', 'anthropic/claude-3-1-sonnet')).toBeUndefined();
	});
});

/**
 * Current model families (models refresh, checked 2026-11-05). The registry asks
 * for the LOWEST effort each model accepts. Sources:
 *  - OpenAI per-model pages https://developers.openai.com/api/docs/models/<id>
 *    (gpt-6-astra: "supports `low`, `medium`, `high`, `xhigh`, and `max`";
 *    gpt-6.1-sol: "`low`, `medium` (default), …"; gpt-6-luna, gpt-6-sol,
 *    gpt-6.1-terra, gpt-5.6-sol: "`none`, `low`, `medium` (default), …").
 *  - Google https://aistudio.google.com/docs/openai ("Reasoning cannot be turned
 *    off for Gemini 2.5 Pro or 3 models"; Gemini 4 Argon maps minimal → low).
 *  - OpenRouter https://openrouter.ai/api/v1/models `reasoning.mandatory` /
 *    `supported_efforts` (a mandatory model "rejects" effort `none`).
 */
describe('getReasoningConfig — current families (models refresh 2026-11-05)', () => {
	it('GPT-6 Astra and GPT-6.1 Sol cannot turn reasoning off → effort=low', () => {
		for (const model of ['gpt-6-astra', 'gpt-6.1-sol']) {
			expect(getReasoningConfig('openai', model)).toEqual({ reasoning: { effort: 'low' } });
			expect(getReasoningConfig('openrouter', `openai/${model}`)).toEqual({ reasoning: { effort: 'low' } });
		}
	});

	it('the mandatory GPT-6 -pro variants (Astra, 6.1 Sol, 6.1 Terra) → effort=low', () => {
		for (const model of ['openai/gpt-6-astra-pro', 'openai/gpt-6.1-sol-pro', 'openai/gpt-6.1-terra-pro']) {
			expect(getReasoningConfig('openrouter', model)).toEqual({ reasoning: { effort: 'low' } });
		}
	});

	it('GPT-6 Luna / Sol -pro accept none → effort=none', () => {
		for (const model of ['openai/gpt-6-luna-pro', 'openai/gpt-6-sol-pro']) {
			expect(getReasoningConfig('openrouter', model)).toEqual({ reasoning: { effort: 'none' } });
		}
	});

	// OpenRouter supported_efforts (2026-11-05): gpt-5.2/5.4/5.5-pro accept only
	// medium and up; gpt-5.1-codex(-mini/-max) and gpt-5.2-codex are mandatory
	// with low as the lowest; gpt-5.3-codex and gpt-5.6-*-pro accept none.
	it('GPT-5.x -pro (5.2–5.5) → effort=medium; GPT-5.1/5.2 -codex → effort=low', () => {
		for (const model of ['gpt-5.2-pro', 'gpt-5.4-pro', 'gpt-5.5-pro']) {
			expect(getReasoningConfig('openai', model)).toEqual({ reasoning: { effort: 'medium' } });
			expect(getReasoningConfig('openrouter', `openai/${model}`)).toEqual({ reasoning: { effort: 'medium' } });
		}
		for (const model of ['gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5.1-codex-max', 'gpt-5.2-codex']) {
			expect(getReasoningConfig('openrouter', `openai/${model}`)).toEqual({ reasoning: { effort: 'low' } });
		}
		for (const model of ['gpt-5.3-codex', 'gpt-5.6-sol-pro']) {
			expect(getReasoningConfig('openrouter', `openai/${model}`)).toEqual({ reasoning: { effort: 'none' } });
		}
	});

	it('retired Gemini 2.0 Pro keeps effort=none (only 2.5 Pro and Gemini 3 Pro cannot turn reasoning off)', () => {
		expect(getReasoningConfig('google', 'gemini-2.0-pro-exp')).toEqual({ reasoning_effort: 'none' });
	});

	it('GPT-6 Luna / Sol, GPT-6.1 Terra and GPT-5.6 accept none → effort=none', () => {
		for (const model of [
			'gpt-6-luna',
			'gpt-6-sol',
			'gpt-6.1-terra',
			'gpt-5.6-sol',
			'gpt-5.6-terra',
			'gpt-5.6-luna'
		]) {
			expect(getReasoningConfig('openai', model)).toEqual({ reasoning: { effort: 'none' } });
			expect(getReasoningConfig('openrouter', `openai/${model}`)).toEqual({ reasoning: { effort: 'none' } });
		}
	});

	it('Gemini 4, 3.7+ Flash and the Pro models → effort=low (thinking cannot be turned off)', () => {
		for (const model of [
			'gemini-4-argon',
			'gemini-3.8-flash',
			'gemini-3.7-flash',
			'gemini-3.1-pro-preview',
			'gemini-2.5-pro'
		]) {
			expect(getReasoningConfig('google', model)).toEqual({ reasoning_effort: 'low' });
			expect(getReasoningConfig('openrouter', `google/${model}`)).toEqual({ reasoning: { effort: 'low' } });
		}
		// The google plugin's ids carry a `models/` prefix.
		expect(getReasoningConfig('google', 'models/gemini-3.8-flash')).toEqual({ reasoning_effort: 'low' });
	});

	it('other Gemini 3.x models accept minimal → effort=minimal', () => {
		for (const model of [
			'gemini-3.6-flash',
			'gemini-3.5-flash-lite',
			'gemini-3.1-flash-lite',
			'gemini-3-flash-preview'
		]) {
			expect(getReasoningConfig('google', model)).toEqual({ reasoning_effort: 'minimal' });
			expect(getReasoningConfig('openrouter', `google/${model}`)).toEqual({ reasoning: { effort: 'minimal' } });
		}
	});

	it('Gemini 2.5 Flash / Flash-Lite still accept none', () => {
		expect(getReasoningConfig('google', 'models/gemini-2.5-flash')).toEqual({ reasoning_effort: 'none' });
		expect(getReasoningConfig('google', 'gemini-2.5-flash-lite')).toEqual({ reasoning_effort: 'none' });
	});

	it('Claude Opus / Sonnet 5.5 and Fable always think on OpenRouter → effort=low', () => {
		for (const model of ['claude-opus-5.5', 'claude-sonnet-5.5', 'claude-fable-5.1', 'claude-fable-5']) {
			expect(getReasoningConfig('openrouter', `anthropic/${model}`)).toEqual({ reasoning: { effort: 'low' } });
		}
	});

	it('Claude Haiku 5.5 accepts none on OpenRouter; earlier Opus / Sonnet stay at none', () => {
		for (const model of ['claude-haiku-5.5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4.8']) {
			expect(getReasoningConfig('openrouter', `anthropic/${model}`)).toEqual({ reasoning: { effort: 'none' } });
		}
	});

	it('never sends effort=none to a model OpenRouter marks reasoning-mandatory', () => {
		const mandatory = [
			'openai/gpt-6-astra',
			'openai/gpt-6.1-sol',
			'anthropic/claude-opus-5.5',
			'anthropic/claude-sonnet-5.5',
			'anthropic/claude-fable-5.1',
			'google/gemini-4-argon',
			'google/gemini-3.8-flash',
			'google/gemini-3.6-flash',
			'google/gemini-3.5-flash-lite',
			'google/gemini-3.1-pro-preview',
			'google/gemini-2.5-pro'
		];
		for (const model of mandatory) {
			expect(getOpenRouterReasoningConfig(model)?.reasoning.effort).not.toBe('none');
		}
	});
});

describe('getReasoningConfig — deepseek & groq', () => {
	it('deepseek-r → openrouter effort=low', () => {
		expect(getReasoningConfig('openrouter', 'deepseek/deepseek-reasoner')).toEqual({
			reasoning: { effort: 'low' }
		});
		expect(getReasoningConfig('openrouter', 'deepseek/deepseek-r1')).toEqual({
			reasoning: { effort: 'low' }
		});
	});

	// Groq: "the `reasoning_format` parameter is not supported" for gpt-oss;
	// `include_reasoning: false` hides the reasoning instead
	// (https://console.groq.com/docs/reasoning, checked 2026-11-05).
	it('gpt-oss → groq effort=low + include_reasoning=false (no reasoning_format)', () => {
		expect(getReasoningConfig('groq', 'gpt-oss-120b')).toEqual({
			reasoning_effort: 'low',
			include_reasoning: false
		});
	});

	it('qwen3 → groq effort=none, no reasoning_format', () => {
		const cfg = getReasoningConfig('groq', 'qwen3-32b');
		expect(cfg).toEqual({ reasoning_effort: 'none' });
		expect((cfg as Record<string, unknown> | undefined)?.reasoning_format).toBeUndefined();
	});
});

describe('getReasoningConfig — mismatched provider', () => {
	it('returns undefined when the matched config has no entry for the requested provider', () => {
		// gpt-5 has openai+openrouter entries only — google must be undefined.
		expect(getReasoningConfig('google', 'gpt-5')).toBeUndefined();
	});

	it('returns undefined for unknown provider types', () => {
		expect(getReasoningConfig('mistral' as unknown as string, 'gpt-5')).toBeUndefined();
		expect(getReasoningConfig('anthropic' as unknown as string, 'gpt-5')).toBeUndefined();
	});

	it('returns undefined when the model has no reasoning config', () => {
		expect(getReasoningConfig('openai', 'gpt-3.5-turbo')).toBeUndefined();
		expect(getReasoningConfig('openai', 'gpt-4o')).toBeUndefined();
		expect(getReasoningConfig('openai', 'random-llm')).toBeUndefined();
	});

	it('returns undefined for missing/empty model', () => {
		expect(getReasoningConfig('openai')).toBeUndefined();
		expect(getReasoningConfig('openai', '')).toBeUndefined();
	});
});

describe('per-provider getter convenience functions', () => {
	it('getOpenAIReasoningConfig matches getReasoningConfig("openai", …)', () => {
		expect(getOpenAIReasoningConfig('gpt-5.2')).toEqual(getReasoningConfig('openai', 'gpt-5.2'));
		expect(getOpenAIReasoningConfig('gpt-5')).toEqual(getReasoningConfig('openai', 'gpt-5'));
		expect(getOpenAIReasoningConfig('o3')).toEqual(getReasoningConfig('openai', 'o3'));
		expect(getOpenAIReasoningConfig('claude-sonnet-4')).toBeUndefined();
		expect(getOpenAIReasoningConfig()).toBeUndefined();
	});

	it('getOpenRouterReasoningConfig matches getReasoningConfig("openrouter", …)', () => {
		expect(getOpenRouterReasoningConfig('openai/gpt-5')).toEqual(getReasoningConfig('openrouter', 'openai/gpt-5'));
		expect(getOpenRouterReasoningConfig('anthropic/claude-sonnet-4')).toEqual({
			reasoning: { effort: 'none' }
		});
	});

	it('getGoogleReasoningConfig matches getReasoningConfig("google", …)', () => {
		expect(getGoogleReasoningConfig('gemini-2.0-flash')).toEqual({ reasoning_effort: 'none' });
		expect(getGoogleReasoningConfig('gpt-5')).toBeUndefined();
	});

	it('getGroqReasoningConfig matches getReasoningConfig("groq", …)', () => {
		expect(getGroqReasoningConfig('gpt-oss-20b')).toEqual({
			reasoning_effort: 'low',
			include_reasoning: false
		});
		expect(getGroqReasoningConfig('qwen3-coder')).toEqual({ reasoning_effort: 'none' });
		expect(getGroqReasoningConfig('gpt-5')).toBeUndefined();
		expect(getGroqReasoningConfig()).toBeUndefined();
	});
});
