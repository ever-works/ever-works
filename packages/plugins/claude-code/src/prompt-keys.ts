/**
 * Prompt keys for the Claude Code pipeline.
 *
 * These keys are used to look up externally managed prompts via the
 * prompt facade (e.g., Langfuse). When no external prompt is found,
 * the hardcoded default in each prompt file is used as fallback.
 *
 * Convention: `claude-code.<prompt-name>`
 */
export const PROMPT_KEYS = {
	SYSTEM: 'claude-code.system',
	USER: 'claude-code.user'
} as const;
