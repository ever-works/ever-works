import type { BuiltInStepId, StepStatus } from './step-types.js';
import type { JsonSchema } from '../settings/json-schema.types.js';

/**
 * Step position relative to built-in steps
 */
export type StepPosition =
	| { readonly type: 'before'; readonly stepId: BuiltInStepId }
	| { readonly type: 'after'; readonly stepId: BuiltInStepId }
	| { readonly type: 'replace'; readonly stepId: BuiltInStepId }
	| { readonly type: 'first' }
	| { readonly type: 'last' };

/**
 * Step dependency definition
 */
export interface StepDependency {
	/** ID of the step this step depends on */
	readonly stepId: string;
	/** Whether the dependency must complete successfully */
	readonly required?: boolean;
	/** Data keys required from the dependency */
	readonly requiredData?: readonly string[];
}

/**
 * Pipeline step definition
 */
export interface PipelineStepDefinition {
	/** Unique step identifier */
	readonly id: string;
	/** Display name */
	readonly name: string;
	/** Step description */
	readonly description?: string;
	/** Position in pipeline relative to built-in steps */
	readonly position: StepPosition;
	/** Step dependencies */
	readonly dependencies?: readonly StepDependency[];
	/** Whether the step can be skipped */
	readonly optional?: boolean;
	/** Whether the step can run in parallel with others */
	readonly parallelizable?: boolean;
	/** Settings schema for step configuration */
	readonly settingsSchema?: JsonSchema;
	/** Data keys this step provides */
	readonly provides?: readonly string[];
	/** Data keys this step requires */
	readonly requires?: readonly string[];
	/** Estimated duration in seconds (for progress display) */
	readonly estimatedDuration?: number;
}

/**
 * Runtime step state
 */
export interface StepState {
	/** Step definition */
	readonly definition: PipelineStepDefinition;
	/** Current status */
	readonly status: StepStatus;
	/** Start timestamp */
	readonly startedAt?: number;
	/** End timestamp */
	readonly completedAt?: number;
	/** Error if failed */
	readonly error?: Error | string;
	/** Step result data */
	readonly result?: Record<string, unknown>;
}

/**
 * Pipeline state
 */
export interface PipelineState {
	/** All step states */
	readonly steps: Map<string, StepState>;
	/** Current running step ID */
	readonly currentStep?: string;
	/** Completed step IDs in order */
	readonly completedSteps: readonly string[];
	/** Failed step IDs */
	readonly failedSteps: readonly string[];
	/** Whether pipeline is running */
	readonly isRunning: boolean;
	/** Whether pipeline was cancelled */
	readonly isCancelled: boolean;
	/** Pipeline start time */
	readonly startedAt?: number;
	/** Pipeline end time */
	readonly completedAt?: number;
}
