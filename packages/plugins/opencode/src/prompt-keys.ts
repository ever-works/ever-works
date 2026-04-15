/**
 * Prompt keys for the OpenCode pipeline.
 *
 * These keys are used to look up externally managed prompts via the
 * prompt facade (e.g., Langfuse). When no external prompt is found,
 * the hardcoded default in each prompt file is used as fallback.
 *
 * Convention: `opencode.<prompt-name>`
 */
export const PROMPT_KEYS = {
	SYSTEM: 'opencode.system',
	USER: 'opencode.user'
} as const;
