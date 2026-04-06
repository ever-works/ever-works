import type { PipelineExecutionOptions } from '@ever-works/plugin';
import type { TextStreamPart, ToolSet } from 'ai';

type StreamLoggingOptions = {
	onLogEntry?: PipelineExecutionOptions['onLogEntry'];
	scope: string;
	stepIndex: number;
	source?: 'pipeline' | 'system' | 'orchestrator';
};

type StreamTextResultLike<TOOLS extends ToolSet> = {
	fullStream: AsyncIterable<TextStreamPart<TOOLS>>;
};

function emitRealtimeLog(
	onLogEntry: PipelineExecutionOptions['onLogEntry'],
	message: string,
	stepIndex: number,
	level: 'info' | 'warn' | 'error' | 'debug' = 'info',
	source: 'pipeline' | 'system' | 'orchestrator' = 'pipeline',
	stepName: string | null = null,
	durationMs: number | null = null
) {
	onLogEntry?.({
		timestamp: new Date().toISOString(),
		level,
		source,
		event: 'message',
		message,
		stepIndex,
		stepName,
		durationMs
	});
}

function getStepNumber(currentStepNumber: number): number {
	return currentStepNumber > 0 ? currentStepNumber : 1;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function consumeStreamWithLogging<TOOLS extends ToolSet>(
	result: StreamTextResultLike<TOOLS>,
	options: StreamLoggingOptions
): Promise<void> {
	let currentStepNumber = 0;
	const reasoningLoggedForStep = new Set<number>();
	const textLoggedForStep = new Set<number>();
	const activeToolCalls = new Set<string>();
	const source = options.source ?? 'pipeline';

	for await (const part of result.fullStream) {
		switch (part.type) {
			case 'start-step': {
				currentStepNumber += 1;
				reasoningLoggedForStep.delete(currentStepNumber);
				textLoggedForStep.delete(currentStepNumber);
				emitRealtimeLog(
					options.onLogEntry,
					`${options.scope}: model step ${currentStepNumber} started`,
					options.stepIndex,
					'info',
					source
				);
				break;
			}

			case 'reasoning-delta': {
				const stepNumber = getStepNumber(currentStepNumber);
				if (reasoningLoggedForStep.has(stepNumber)) {
					break;
				}

				reasoningLoggedForStep.add(stepNumber);
				emitRealtimeLog(
					options.onLogEntry,
					`${options.scope}: reasoning in progress`,
					options.stepIndex,
					'debug',
					source
				);
				break;
			}

			case 'text-delta': {
				const stepNumber = getStepNumber(currentStepNumber);
				if (textLoggedForStep.has(stepNumber)) {
					break;
				}

				textLoggedForStep.add(stepNumber);
				emitRealtimeLog(
					options.onLogEntry,
					`${options.scope}: generating response text`,
					options.stepIndex,
					'debug',
					source
				);
				break;
			}

			case 'tool-call': {
				if (activeToolCalls.has(part.toolCallId)) {
					break;
				}

				activeToolCalls.add(part.toolCallId);
				emitRealtimeLog(
					options.onLogEntry,
					`${options.scope}: calling tool "${part.toolName}" (step ${getStepNumber(currentStepNumber)})`,
					options.stepIndex,
					'info',
					source
				);
				break;
			}

			case 'tool-result': {
				if (part.preliminary) {
					break;
				}

				activeToolCalls.delete(part.toolCallId);
				emitRealtimeLog(
					options.onLogEntry,
					`${options.scope}: tool "${part.toolName}" completed (step ${getStepNumber(currentStepNumber)})`,
					options.stepIndex,
					'info',
					source
				);
				break;
			}

			case 'tool-error': {
				activeToolCalls.delete(part.toolCallId);
				emitRealtimeLog(
					options.onLogEntry,
					`${options.scope}: tool "${part.toolName}" failed (step ${getStepNumber(currentStepNumber)}) - ${formatError(part.error)}`,
					options.stepIndex,
					'warn',
					source
				);
				break;
			}

			case 'tool-output-denied': {
				activeToolCalls.delete(part.toolCallId);
				emitRealtimeLog(
					options.onLogEntry,
					`${options.scope}: tool "${part.toolName}" output was denied (step ${getStepNumber(currentStepNumber)})`,
					options.stepIndex,
					'warn',
					source
				);
				break;
			}

			case 'finish-step': {
				emitRealtimeLog(
					options.onLogEntry,
					`${options.scope}: model step ${getStepNumber(currentStepNumber)} finished (${part.finishReason}; ${part.usage.totalTokens} tokens)`,
					options.stepIndex,
					'info',
					source
				);
				break;
			}

			case 'abort': {
				emitRealtimeLog(
					options.onLogEntry,
					`${options.scope}: generation aborted${part.reason ? ` - ${part.reason}` : ''}`,
					options.stepIndex,
					'warn',
					source
				);
				break;
			}

			case 'error': {
				emitRealtimeLog(
					options.onLogEntry,
					`${options.scope}: stream error - ${formatError(part.error)}`,
					options.stepIndex,
					'error',
					source
				);
				break;
			}

			default:
				break;
		}
	}
}
