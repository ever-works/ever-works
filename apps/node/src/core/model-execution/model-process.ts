import {
	executeModelProcessInternal,
	type ModelExecutionRequest,
	type ModelExecutionResult,
	type ModelExecutionProvider,
	type ModelCliCommand
} from './model-process.internal';
import { createProductionModelExecutionIoInternal } from './model-process-factory.internal';

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
	ModelExecutionAuthentication,
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
	/**
	 * Required for native containment on Windows. All four values must describe
	 * the final signed production helper artifact; no PATH lookup or unsigned
	 * build hash is accepted by this boundary.
	 */
	readonly windowsJobLauncher?: WindowsJobLauncherTrustConfig;
}

export interface WindowsJobLauncherTrustConfig {
	/** Node-operator-owned, normalized local drive-absolute path to the signed helper. */
	readonly helperPath: string;
	/** SHA-256 of the final Authenticode-signed artifact, never the unsigned build hash. */
	readonly expectedSha256: string;
	/** Exact Authenticode leaf certificate subject. */
	readonly publisherSubject: string;
	/** SHA-256 of the exact Authenticode leaf certificate. */
	readonly publisherCertificateSha256: string;
}

export interface ModelProcessExecutor {
	execute(request: ModelExecutionRequest): Promise<ModelExecutionResult>;
}

/** Create the production executor without exposing process, environment, clock, or filesystem seams. */
export function createModelProcessExecutor(config: ModelProcessExecutorConfig): ModelProcessExecutor {
	const io = createProductionModelExecutionIoInternal(config);
	return Object.freeze({
		execute: (request: ModelExecutionRequest) => executeModelProcessInternal(request, io)
	});
}
