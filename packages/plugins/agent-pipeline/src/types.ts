export type AgentPipelineStepId =
	| 'prepare-context'
	| 'generate-items'
	| 'collect-results'
	| 'capture-screenshots'
	| 'cleanup';

export const AGENT_PIPELINE_STEP_IDS: readonly AgentPipelineStepId[] = [
	'prepare-context',
	'generate-items',
	'collect-results',
	'capture-screenshots',
	'cleanup'
] as const;

export function isAgentPipelineStepId(value: string): value is AgentPipelineStepId {
	return (AGENT_PIPELINE_STEP_IDS as readonly string[]).includes(value);
}

export const DEFAULT_MAX_STEPS = 500;
export const DEFAULT_MAX_CONTEXT_TOKENS = 128_000;
export const DEFAULT_CONTEXT_BUDGET_RATIO = 0.8;

export const WORKER_PROMPT_OVERHEAD_TOKENS = 2000;
export const MIN_CHUNK_CHARS = 4000;

/**
 * Returns the content-budget ratio for the extraction worker based on model context size.
 * Smaller models get a lower ratio so more tokens are available for the JSON response.
 */
export function getWorkerContentBudgetRatio(maxContextTokens: number): number {
	if (maxContextTokens <= 16_000) return 0.35;
	if (maxContextTokens <= 32_000) return 0.4;
	if (maxContextTokens <= 64_000) return 0.5;
	return 0.55;
}

export const MAX_URLS_PER_BATCH = 10;
