/**
 * Prompt keys for the Codex pipeline.
 *
 * These keys are used to look up externally managed prompts via the
 * prompt facade (e.g., Langfuse). When no external prompt is found,
 * the hardcoded default in each prompt file is used as fallback.
 *
 * Convention: `codex.<prompt-name>`
 */
export const PROMPT_KEYS = {
	SYSTEM: 'codex.system',
	USER: 'codex.user'
} as const;
