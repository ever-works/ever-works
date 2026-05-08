import { describe, expect, it } from 'vitest';
import type { LLMResult } from '@langchain/core/outputs';
import { TokenUsageTracker } from '../token-usage.tracker.js';

const baseGenerations = [[{ text: 'hi' } as never]];

const result = (
	llmOutput?: Record<string, unknown>,
	generationInfo?: Record<string, unknown>
): LLMResult =>
	({
		llmOutput,
		generations: generationInfo ? [[{ text: 'hi', generationInfo }]] : baseGenerations
	}) as unknown as LLMResult;

describe('TokenUsageTracker', () => {
	it('initialises usage to zeros and exposes the LangChain-required `name`', () => {
		const t = new TokenUsageTracker();
		expect(t.name).toBe('token-usage-tracker');
		expect(t.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
	});

	it('reads the OpenAI-style camelCase non-streaming shape (`tokenUsage`)', () => {
		const t = new TokenUsageTracker();
		t.handleLLMEnd(
			result({
				tokenUsage: { promptTokens: 10, completionTokens: 7, totalTokens: 17 }
			})
		);
		expect(t.usage).toEqual({ inputTokens: 10, outputTokens: 7, totalTokens: 17 });
	});

	it('reads the OpenAI snake_case fallback (`prompt_tokens` / `completion_tokens` / `total_tokens`)', () => {
		const t = new TokenUsageTracker();
		t.handleLLMEnd(
			result({
				tokenUsage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
			})
		);
		expect(t.usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
	});

	it('reads alternate camelCase (`inputTokens` / `outputTokens`)', () => {
		const t = new TokenUsageTracker();
		t.handleLLMEnd(
			result({
				tokenUsage: { inputTokens: 5, outputTokens: 6 }
			})
		);
		expect(t.usage).toEqual({ inputTokens: 5, outputTokens: 6, totalTokens: 11 });
	});

	it('reads alternate snake_case (`input_tokens` / `output_tokens`)', () => {
		const t = new TokenUsageTracker();
		t.handleLLMEnd(
			result({
				tokenUsage: { input_tokens: 8, output_tokens: 12 }
			})
		);
		expect(t.usage).toEqual({ inputTokens: 8, outputTokens: 12, totalTokens: 20 });
	});

	it('falls back to llmOutput.estimatedTokenUsage when tokenUsage missing (streaming)', () => {
		const t = new TokenUsageTracker();
		t.handleLLMEnd(
			result({
				estimatedTokenUsage: { promptTokens: 1, completionTokens: 2 }
			})
		);
		expect(t.usage).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
	});

	it('falls back to generationInfo.tokenUsage when llmOutput is undefined', () => {
		const t = new TokenUsageTracker();
		t.handleLLMEnd(
			result(undefined, {
				tokenUsage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 }
			})
		);
		expect(t.usage).toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: 5 });
	});

	it('falls back to generationInfo.estimatedTokenUsage as last resort', () => {
		const t = new TokenUsageTracker();
		t.handleLLMEnd(
			result(undefined, {
				estimatedTokenUsage: { promptTokens: 7, completionTokens: 8 }
			})
		);
		expect(t.usage).toEqual({ inputTokens: 7, outputTokens: 8, totalTokens: 15 });
	});

	it('prefers llmOutput.tokenUsage over llmOutput.estimatedTokenUsage', () => {
		const t = new TokenUsageTracker();
		t.handleLLMEnd(
			result({
				tokenUsage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
				estimatedTokenUsage: { promptTokens: 99, completionTokens: 99, totalTokens: 198 }
			})
		);
		expect(t.usage).toEqual({ inputTokens: 10, outputTokens: 10, totalTokens: 20 });
	});

	it('prefers llmOutput over generationInfo when both supply usage', () => {
		const t = new TokenUsageTracker();
		t.handleLLMEnd(
			result(
				{ tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
				{ tokenUsage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 } }
			)
		);
		expect(t.usage).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
	});

	it('zeroes everything when no usage info is present anywhere', () => {
		const t = new TokenUsageTracker();
		t.handleLLMEnd(result());
		expect(t.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
	});

	it('computes totalTokens from input+output when totalTokens is missing', () => {
		const t = new TokenUsageTracker();
		t.handleLLMEnd(
			result({
				tokenUsage: { promptTokens: 4, completionTokens: 6 }
			})
		);
		expect(t.usage.totalTokens).toBe(10);
	});

	it('uses provider-supplied totalTokens even when it disagrees with the sum', () => {
		// Some providers report "billable" totalTokens that exceed input+output.
		// The tracker must honour the explicit value rather than re-deriving it.
		const t = new TokenUsageTracker();
		t.handleLLMEnd(
			result({
				tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 999 }
			})
		);
		expect(t.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 999 });
	});

	it('keeps total at 0 when both input and output are 0 and no total is given', () => {
		const t = new TokenUsageTracker();
		t.handleLLMEnd(result({ tokenUsage: {} }));
		expect(t.usage.totalTokens).toBe(0);
	});

	it('tolerates missing generations array (safe access through optional chaining)', () => {
		const t = new TokenUsageTracker();
		t.handleLLMEnd({ llmOutput: undefined, generations: [] } as unknown as LLMResult);
		expect(t.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
	});

	it('tolerates a completely empty result object', () => {
		const t = new TokenUsageTracker();
		t.handleLLMEnd({} as unknown as LLMResult);
		expect(t.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
	});

	it('overwrites prior usage on a subsequent call (not cumulative)', () => {
		const t = new TokenUsageTracker();
		t.handleLLMEnd(result({ tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }));
		expect(t.usage.totalTokens).toBe(15);
		t.handleLLMEnd(result({ tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }));
		expect(t.usage).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
	});

	it('prefers `promptTokens` over `prompt_tokens` when both keys exist', () => {
		const t = new TokenUsageTracker();
		t.handleLLMEnd(
			result({
				tokenUsage: { promptTokens: 5, prompt_tokens: 99, completionTokens: 7 }
			})
		);
		expect(t.usage.inputTokens).toBe(5);
		expect(t.usage.outputTokens).toBe(7);
	});
});
