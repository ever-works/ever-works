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
	it('gemini-2/3 → google effort=none', () => {
		expect(getReasoningConfig('google', 'gemini-2.0-flash')).toEqual({ reasoning_effort: 'none' });
		expect(getReasoningConfig('google', 'gemini-3-pro')).toEqual({ reasoning_effort: 'none' });
	});

	it('gemini-2/3 → openrouter effort=none', () => {
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

describe('getReasoningConfig — deepseek & groq', () => {
	it('deepseek-r → openrouter effort=low', () => {
		expect(getReasoningConfig('openrouter', 'deepseek/deepseek-reasoner')).toEqual({
			reasoning: { effort: 'low' }
		});
		expect(getReasoningConfig('openrouter', 'deepseek/deepseek-r1')).toEqual({
			reasoning: { effort: 'low' }
		});
	});

	it('gpt-oss → groq effort=low + format=hidden', () => {
		expect(getReasoningConfig('groq', 'gpt-oss-120b')).toEqual({
			reasoning_effort: 'low',
			reasoning_format: 'hidden'
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
			reasoning_format: 'hidden'
		});
		expect(getGroqReasoningConfig('qwen3-coder')).toEqual({ reasoning_effort: 'none' });
		expect(getGroqReasoningConfig('gpt-5')).toBeUndefined();
		expect(getGroqReasoningConfig()).toBeUndefined();
	});
});
