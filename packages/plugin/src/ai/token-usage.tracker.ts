import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { LLMResult } from '@langchain/core/outputs';

export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
}

/**
 * LangChain callback handler to capture token usage in a provider-agnostic way.
 * It inspects common tokenUsage fields across providers to stay resilient to API differences.
 */
export class TokenUsageTracker extends BaseCallbackHandler {
	name = 'token-usage-tracker';

	usage: TokenUsage = {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0
	};

	handleLLMEnd(output: LLMResult) {
		// LangChain uses different field names depending on the provider and code path:
		// - tokenUsage: standard non-streaming path
		// - estimatedTokenUsage: streaming and some provider-specific paths
		const llmOutput = output?.llmOutput as Record<string, unknown> | undefined;
		const generationInfo = output?.generations?.[0]?.[0]?.generationInfo as Record<string, unknown> | undefined;

		const tokenUsage = (llmOutput?.tokenUsage ??
			llmOutput?.estimatedTokenUsage ??
			generationInfo?.tokenUsage ??
			generationInfo?.estimatedTokenUsage ??
			{}) as Record<string, number | undefined>;

		const inputTokens =
			tokenUsage.promptTokens ??
			tokenUsage.prompt_tokens ??
			tokenUsage.inputTokens ??
			tokenUsage.input_tokens ??
			0;

		const outputTokens =
			tokenUsage.completionTokens ??
			tokenUsage.completion_tokens ??
			tokenUsage.outputTokens ??
			tokenUsage.output_tokens ??
			0;

		const totalTokens =
			tokenUsage.totalTokens ??
			tokenUsage.total_tokens ??
			(inputTokens || outputTokens ? inputTokens + outputTokens : 0);

		this.usage = {
			inputTokens,
			outputTokens,
			totalTokens
		};
	}
}
