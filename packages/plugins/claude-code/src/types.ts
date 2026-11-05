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
 * Default CLI version to download: 2.1.311, the npm `stable` dist-tag on 2026-10-26
 * (`npm view @anthropic-ai/claude-code dist-tags`; `<dist>/2.1.311/manifest.json` serves the
 * same platform keys as 2.1.76). Opus 5.5 needs 2.1.280+, Sonnet 5.5 2.1.284+, Haiku 5.5
 * 2.1.293+ and the `fable` alias 2.1.257+ (https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
 */
export const DEFAULT_CLI_VERSION = '2.1.311';

/**
 * Default model: the CLI's `sonnet` alias. With CLI 2.1.311 on the Anthropic API it resolves
 * to Claude Sonnet 5.5 (https://code.claude.com/docs/en/model-config, checked 2026-11-05).
 */
export const DEFAULT_MODEL = 'sonnet';

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
