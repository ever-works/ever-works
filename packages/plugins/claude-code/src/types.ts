/**
 * Step IDs for the Claude Code pipeline.
 * All steps run sequentially (non-parallelizable).
 */
export type ClaudeCodeStepId =
	| 'setup-claude-code'
	| 'prepare-context'
	| 'generate-items'
	| 'collect-results'
	| 'capture-screenshots'
	| 'cleanup';

/**
 * All step IDs as an array for iteration
 */
export const CLAUDE_CODE_STEP_IDS: readonly ClaudeCodeStepId[] = [
	'setup-claude-code',
	'prepare-context',
	'generate-items',
	'collect-results',
	'capture-screenshots',
	'cleanup'
] as const;

/**
 * Type guard for ClaudeCodeStepId
 */
export function isClaudeCodeStepId(value: string): value is ClaudeCodeStepId {
	return (CLAUDE_CODE_STEP_IDS as readonly string[]).includes(value);
}

/**
 * Base temporary work for all Claude Code operations
 */
export const BASE_TEMP_DIR = '/tmp/claude-code-generator';

/**
 * GCS bucket URL for Claude Code CLI distribution
 */
export const CLAUDE_CODE_DIST_URL =
	'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases';

/**
 * Default CLI version to download
 */
export const DEFAULT_CLI_VERSION = '2.1.76';

/**
 * Default maximum number of agentic turns for Claude Code
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
