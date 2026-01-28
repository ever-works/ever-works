import type { PipelineStepDefinition, StepState } from './step-definition.types.js';

/**
 * A group of steps that can be executed in parallel
 */
export interface ParallelGroup {
	/** Unique group identifier */
	readonly id: string;
	/** Step IDs in this group */
	readonly stepIds: readonly string[];
	/** Whether all steps must complete successfully */
	readonly allRequired: boolean;
	/** Minimum number of steps that must complete */
	readonly minRequired?: number;
	/** Maximum concurrent executions */
	readonly maxConcurrent?: number;
}

/**
 * Parallel execution result
 */
export interface ParallelExecutionResult {
	/** Group ID */
	readonly groupId: string;
	/** Results by step ID */
	readonly results: Map<string, StepState>;
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
 */
export interface StepGraph {
	/** All step definitions indexed by ID */
	readonly steps: Map<string, PipelineStepDefinition>;
	/** Edges: stepId -> dependent step IDs */
	readonly dependents: Map<string, Set<string>>;
	/** Edges: stepId -> dependency step IDs */
	readonly dependencies: Map<string, Set<string>>;
	/** Parallel groups */
	readonly parallelGroups: readonly ParallelGroup[];
}

/**
 * Execution plan for the pipeline
 */
export interface ExecutionPlan {
	/** Ordered phases of execution (steps in same phase can run in parallel) */
	readonly phases: readonly ExecutionPhase[];
	/** Total step count */
	readonly totalSteps: number;
	/** Estimated total duration */
	readonly estimatedDuration?: number;
}

/**
 * A phase of execution containing steps that can run in parallel
 */
export interface ExecutionPhase {
	/** Phase index */
	readonly index: number;
	/** Step IDs in this phase */
	readonly stepIds: readonly string[];
	/** Whether steps should run in parallel */
	readonly parallel: boolean;
	/** Maximum concurrent executions */
	readonly maxConcurrent?: number;
}
