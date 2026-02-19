import { wrapLanguageModel } from 'ai';
import type { LanguageModelV3 } from '@ai-sdk/provider';

/**
 * Wrap a model and strip assistant reasoning parts from prompt history.
 * This reduces context pressure during long tool-calling sessions.
 */
export function wrapReasoningFilteredModel(model: LanguageModelV3): LanguageModelV3 {
	return wrapLanguageModel({
		model,
		middleware: {
			specificationVersion: 'v3',
			transformParams: async ({ params }) => ({
				...params,
				prompt: params.prompt.map((msg) =>
					msg.role === 'assistant' && Array.isArray(msg.content)
						? { ...msg, content: msg.content.filter((part) => part.type !== 'reasoning') }
						: msg
				)
			})
		}
	}) as LanguageModelV3;
}
