/**
 * Step IDs for the Agent Pipeline.
 * All steps run sequentially (non-parallelizable).
 */
export type AgentPipelineStepId =
	| 'prepare-context'
	| 'generate-items'
	| 'collect-results'
	| 'capture-screenshots'
	| 'cleanup';

/**
 * All step IDs as an array for iteration
 */
export const AGENT_PIPELINE_STEP_IDS: readonly AgentPipelineStepId[] = [
	'prepare-context',
	'generate-items',
	'collect-results',
	'capture-screenshots',
	'cleanup'
] as const;

/**
 * Type guard for AgentPipelineStepId
 */
export function isAgentPipelineStepId(value: string): value is AgentPipelineStepId {
	return (AGENT_PIPELINE_STEP_IDS as readonly string[]).includes(value);
}

/**
 * Default maximum number of agent steps (tool-calling rounds)
 */
export const DEFAULT_MAX_STEPS = 500;

/**
 * Maximum content length when extracting web pages (characters)
 */
export const MAX_EXTRACT_CONTENT_LENGTH = 8000;
