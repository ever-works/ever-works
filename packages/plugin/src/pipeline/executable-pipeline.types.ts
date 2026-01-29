import type { PipelineStepDefinition } from './step-definition.types.js';
import type { ParallelGroup } from './parallel-group.types.js';

/**
 * A step executor - either built-in or plugin-provided
 */
export type StepExecutor =
	| { readonly type: 'builtin'; readonly serviceId: string }
	| { readonly type: 'plugin'; readonly pluginId: string; readonly stepId: string };

/**
 * A fully compiled pipeline ready for execution.
 * Contains ordered steps, parallel groups, and executor mapping.
 *
 * This represents the final compiled form of a pipeline after all
 * plugin contributions have been merged and validated.
 */
export interface ExecutablePipeline {
	/** All steps in topological order */
	readonly steps: PipelineStepDefinition[];

	/** Groups of steps that can be executed in parallel */
	readonly groups: ParallelGroup[];

	/** Map from step ID to its executor (built-in service or plugin) */
	readonly executorMap: Map<string, StepExecutor>;

	/** Original step IDs that were replaced (original -> replacement plugin step ID) */
	readonly replacedSteps: Map<string, string>;

	/** Step IDs that were disabled by plugins */
	readonly disabledSteps: Set<string>;

	/** Step IDs that were injected by plugins */
	readonly injectedSteps: Set<string>;

	/** Total estimated duration in milliseconds */
	readonly estimatedDuration?: number;

	/** Pipeline source (standard or plugin ID that defined the full pipeline) */
	readonly source: 'standard' | string;
}

/**
 * Create an empty executable pipeline
 * @param source - The source of the pipeline (standard or plugin ID)
 */
export function createExecutablePipeline(source: 'standard' | string = 'standard'): ExecutablePipeline {
	return {
		steps: [],
		groups: [],
		executorMap: new Map(),
		replacedSteps: new Map(),
		disabledSteps: new Set(),
		injectedSteps: new Set(),
		source
	};
}

/**
 * Type guard to check if a step was injected by a plugin
 */
export function isInjectedStep(pipeline: ExecutablePipeline, stepId: string): boolean {
	return pipeline.injectedSteps.has(stepId);
}

/**
 * Type guard to check if a step was replaced
 */
export function isReplacedStep(pipeline: ExecutablePipeline, stepId: string): boolean {
	return pipeline.replacedSteps.has(stepId);
}

/**
 * Type guard to check if a step is disabled
 */
export function isDisabledStep(pipeline: ExecutablePipeline, stepId: string): boolean {
	return pipeline.disabledSteps.has(stepId);
}

/**
 * Get the executor for a step
 */
export function getStepExecutor(pipeline: ExecutablePipeline, stepId: string): StepExecutor | undefined {
	return pipeline.executorMap.get(stepId);
}
