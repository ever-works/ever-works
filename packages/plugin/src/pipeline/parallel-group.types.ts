import type { PipelineStepDefinition, StepState } from './step-definition.types.js';

/**
 * A group of steps that can be executed in parallel
 *
 * @typeParam TStepId - Union type of valid step IDs
 */
export interface ParallelGroup<TStepId extends string = string> {
	/** Unique group identifier */
	readonly id: string;
	/** Step IDs in this group */
	readonly stepIds: readonly TStepId[];
	/** Whether all steps must complete successfully */
	readonly allRequired: boolean;
	/** Minimum number of steps that must complete */
	readonly minRequired?: number;
	/** Maximum concurrent executions */
	readonly maxConcurrent?: number;
}

/**
 * Parallel execution result
 *
 * @typeParam TStepId - Union type of valid step IDs
 */
export interface ParallelExecutionResult<TStepId extends string = string> {
	/** Group ID */
	readonly groupId: string;
	/** Results by step ID */
	readonly results: Map<TStepId, StepState<TStepId>>;
	/** Number of successful steps */
	readonly successCount: number;
	/** Number of failed steps */
	readonly failedCount: number;
	/** Total execution time */
	readonly duration: number;
	/** Whether the group completed successfully */
	readonly success: boolean;
}

/**
 * Step graph for dependency resolution
 *
 * @typeParam TStepId - Union type of valid step IDs
 */
export interface StepGraph<TStepId extends string = string> {
	/** All step definitions indexed by ID */
	readonly steps: Map<TStepId, PipelineStepDefinition<TStepId>>;
	/** Edges: stepId -> dependent step IDs */
	readonly dependents: Map<TStepId, Set<TStepId>>;
	/** Edges: stepId -> dependency step IDs */
	readonly dependencies: Map<TStepId, Set<TStepId>>;
	/** Parallel groups */
	readonly parallelGroups: readonly ParallelGroup<TStepId>[];
}

/**
 * Execution plan for the pipeline
 *
 * @typeParam TStepId - Union type of valid step IDs
 */
export interface ExecutionPlan<TStepId extends string = string> {
	/** Ordered phases of execution (steps in same phase can run in parallel) */
	readonly phases: readonly ExecutionPhase<TStepId>[];
	/** Total step count */
	readonly totalSteps: number;
	/** Estimated total duration */
	readonly estimatedDuration?: number;
}

/**
 * A phase of execution containing steps that can run in parallel
 *
 * @typeParam TStepId - Union type of valid step IDs
 */
export interface ExecutionPhase<TStepId extends string = string> {
	/** Phase index */
	readonly index: number;
	/** Step IDs in this phase */
	readonly stepIds: readonly TStepId[];
	/** Whether steps should run in parallel */
	readonly parallel: boolean;
	/** Maximum concurrent executions */
	readonly maxConcurrent?: number;
}
