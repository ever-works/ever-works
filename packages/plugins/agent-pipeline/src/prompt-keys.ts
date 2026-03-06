/**
 * Prompt keys for the agent pipeline.
 *
 * These keys are used to look up externally managed prompts via the
 * prompt facade (e.g., Langfuse). When no external prompt is found,
 * the hardcoded default in each prompt file is used as fallback.
 *
 * Convention: `agent-pipeline.<prompt-name>`
 */
export const PROMPT_KEYS = {
	PARENT_SYSTEM: 'agent-pipeline.parent-system',
	PARENT_USER: 'agent-pipeline.parent-user',
	WORKER_SYSTEM: 'agent-pipeline.worker-system',
	CHUNK_USER: 'agent-pipeline.chunk-user',
	MODIFICATION_SYSTEM: 'agent-pipeline.modification-system'
} as const;
