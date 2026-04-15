/**
 * Step IDs for the OpenCode pipeline.
 * All steps run sequentially (non-parallelizable).
 */
export type OpenCodeStepId =
	| 'setup-opencode'
	| 'prepare-context'
	| 'generate-items'
	| 'collect-results'
	| 'capture-screenshots'
	| 'cleanup';

/**
 * All step IDs as an array for iteration
 */
export const OPENCODE_STEP_IDS: readonly OpenCodeStepId[] = [
	'setup-opencode',
	'prepare-context',
	'generate-items',
	'collect-results',
	'capture-screenshots',
	'cleanup'
] as const;

/**
 * Type guard for OpenCodeStepId
 */
export function isOpenCodeStepId(value: string): value is OpenCodeStepId {
	return (OPENCODE_STEP_IDS as readonly string[]).includes(value);
}

/**
 * Base temporary directory for all OpenCode operations
 */
export const BASE_TEMP_DIR = '/tmp/opencode-generator';

/**
 * GitHub repository for OpenCode CLI distribution
 */
export const OPENCODE_GITHUB_REPO = 'sst/opencode';

/**
 * Default CLI version to download
 */
export const DEFAULT_CLI_VERSION = 'v1.0.223';

/**
 * Default maximum number of agentic turns for OpenCode
 */
export const DEFAULT_MAX_TURNS = 500;

/**
 * Maximum stdout/stderr buffer size (10MB) to prevent OOM
 */
export const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/**
 * Timeout for SIGKILL after SIGTERM (5 seconds)
 */
export const KILL_TIMEOUT_MS = 5000;
