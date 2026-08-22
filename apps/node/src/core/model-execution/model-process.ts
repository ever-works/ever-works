import {
	executeModelProcessInternal,
	type ModelExecutionRequest,
	type ModelExecutionResult,
	type ModelExecutionProvider,
	type ModelCliCommand
} from './model-process.internal';

export {
	MODEL_CLI_COMPATIBILITY,
	MODEL_EXECUTION_DEFAULT_TIMEOUT_MS,
	MODEL_EXECUTION_EXCERPT_BYTES,
	MODEL_EXECUTION_MAX_INSTRUCTIONS_BYTES,
	MODEL_EXECUTION_MAX_TIMEOUT_MS,
	MODEL_EXECUTION_OUTPUT_LIMIT_BYTES,
	ModelExecutionRequestError
} from './model-process.internal';
export type {
	ClaudeEffort,
	ClaudeModelExecutionOptions,
	ClaudePermissionMode,
	CodexModelExecutionOptions,
	CodexSandbox,
	ModelCliCommand,
	ModelExecutionProvider,
	ModelExecutionRequest,
	ModelExecutionResult,
	ModelExecutionStatus
} from './model-process.internal';

export interface ModelProcessExecutorConfig {
	/**
	 * Node-operator-owned canonical executables. Their parent directories and
	 * files must not be writable by a leased task identity.
	 */
	readonly commands: Readonly<Record<ModelExecutionProvider, ModelCliCommand>>;
}

export interface ModelProcessExecutor {
	execute(request: ModelExecutionRequest): Promise<ModelExecutionResult>;
}

/** Create the production executor without exposing process, environment, clock, or filesystem seams. */
export function createModelProcessExecutor(config: ModelProcessExecutorConfig): ModelProcessExecutor {
	const commands: Readonly<Record<ModelExecutionProvider, ModelCliCommand>> = Object.freeze({
		'claude-code': Object.freeze({ ...config.commands['claude-code'] }),
		codex: Object.freeze({ ...config.commands.codex })
	});
	return Object.freeze({
		execute: (request: ModelExecutionRequest) => executeModelProcessInternal(request, { commands })
	});
}
