import {
	NoSuchToolError,
	InvalidToolInputError,
	APICallError,
	generateText,
	type LanguageModel,
	type ToolSet
} from 'ai';
import type { PluginLogger } from '@ever-works/plugin';
import { delay } from './pipeline-helpers.js';

const TOOL_ERROR_PATTERNS = [
	'parsing failed',
	'tool call validation',
	'not in request.tools',
	'tool_use_failed',
	'invalid_tool_call',
	'failed to call a function',
	'failed_generation'
];

/**
 * Detects whether an error is a tool-calling error (hallucinated tool name,
 * invalid input, or unparseable tool call).
 */
export function isToolCallingError(error: unknown): boolean {
	if (NoSuchToolError.isInstance(error)) return true;
	if (InvalidToolInputError.isInstance(error)) return true;

	if (APICallError.isInstance(error)) {
		const msg = error.message.toLowerCase();
		return TOOL_ERROR_PATTERNS.some((p) => msg.includes(p));
	}

	if (error instanceof Error) {
		const msg = error.message.toLowerCase();
		return TOOL_ERROR_PATTERNS.some((p) => msg.includes(p));
	}

	return false;
}

/**
 * Creates an `experimental_repairToolCall` callback for `generateText()`.
 *
 * When the model hallucinates a tool name or provides invalid input, this
 * re-asks the model to correct itself by sending the failed call + error
 * message back as context.
 */
export function createToolCallRepairFn(
	model: LanguageModel,
	logger: PluginLogger
): Parameters<typeof generateText>[0]['experimental_repairToolCall'] {
	return async ({ system, messages, toolCall, tools, error }) => {
		try {
			const toolNames = Object.keys(tools as ToolSet);
			logger.warn(
				`Tool call repair: model called "${toolCall.toolName}" ` +
					`(available: ${toolNames.join(', ')}). Error: ${error.message}`
			);

			const { text } = await generateText({
				model,
				system,
				messages: [
					...messages,
					{
						role: 'assistant' as const,
						content: [
							{
								type: 'tool-call' as const,
								toolCallId: toolCall.toolCallId,
								toolName: toolCall.toolName,
								input: toolCall.input
							}
						]
					},
					{
						role: 'tool' as const,
						content: [
							{
								type: 'tool-result' as const,
								toolCallId: toolCall.toolCallId,
								toolName: toolCall.toolName,
								output: {
									type: 'text' as const,
									value:
										`Error: ${error.message}. The available tools are: ${toolNames.join(', ')}. ` +
										'Please retry with a valid tool name and correct input.'
								}
							}
						]
					}
				]
			});

			// Try to parse the repaired tool call from the model's response
			try {
				const repaired = JSON.parse(text);
				if (repaired.toolName && repaired.input !== undefined) {
					return {
						type: 'tool-call' as const,
						toolCallId: toolCall.toolCallId,
						toolName: repaired.toolName,
						input: typeof repaired.input === 'string' ? repaired.input : JSON.stringify(repaired.input)
					};
				}
			} catch {
				// Response wasn't valid JSON - skip repair
			}

			logger.warn('Tool call repair: model did not produce a valid repair, skipping tool call');
			return null;
		} catch (repairError) {
			logger.warn(
				`Tool call repair failed: ${repairError instanceof Error ? repairError.message : String(repairError)}`
			);
			return null;
		}
	};
}

const DEFAULT_MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = [1000, 3000];

interface ToolCallingRetryOptions {
	providerName: string;
	modelName: string;
	signal?: AbortSignal;
	logger: PluginLogger;
	maxRetries?: number;
}

class ToolCallingError extends Error {
	readonly originalError: unknown;

	constructor(message: string, originalError: unknown) {
		super(message);
		this.name = 'ToolCallingError';
		this.originalError = originalError;
	}
}

/**
 * Wraps a `generateText()` call with retry logic for tool-calling errors.
 *
 * Only retries errors identified as tool-calling issues (hallucinated tools,
 * invalid input, parsing failures). Network errors and aborts are not retried.
 */
export async function withToolCallingRetry<T>(fn: () => Promise<T>, options: ToolCallingRetryOptions): Promise<T> {
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			// Never retry aborts
			if (options.signal?.aborted) throw error;

			// Only retry tool-calling errors
			if (!isToolCallingError(error)) throw error;

			// Exhausted retries
			if (attempt >= maxRetries) {
				const msg =
					`Model "${options.modelName}" from provider "${options.providerName}" ` +
					`failed after ${attempt + 1} attempts due to tool-calling errors. ` +
					'This model may not properly support tool calling. ' +
					'Try switching to a different model (e.g. GPT-4o, Claude Sonnet).';

				throw new ToolCallingError(msg, error);
			}

			const backoff = RETRY_BACKOFF_MS[attempt] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
			options.logger.warn(
				`Tool-calling error on attempt ${attempt + 1}/${maxRetries + 1}, ` +
					`retrying in ${backoff}ms: ${error instanceof Error ? error.message : String(error)}`
			);
			await delay(backoff);
		}
	}

	// Unreachable, but satisfies TypeScript
	throw new Error('Unexpected: retry loop exited without returning or throwing');
}
