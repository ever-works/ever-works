import type { StepStatus } from './step-types.js';
import type { JsonSchema } from '../settings/json-schema.types.js';

/**
 * Step position relative to other steps.
 *
 * Generic over TStepId to support both:
 * - Built-in pipelines with specific step ID types (e.g., BuiltInStepId)
 * - Custom pipelines with their own step ID types
 *
 * @example
 * // Using with default pipeline's BuiltInStepId
 * const position: StepPosition<BuiltInStepId> = { type: 'after', stepId: 'web-search' };
 *
 * // Using with generic string (for custom pipelines)
 * const customPosition: StepPosition = { type: 'after', stepId: 'my-custom-step' };
 */
export type StepPosition<TStepId extends string = string> =
	| { readonly type: 'before'; readonly stepId: TStepId }
	| { readonly type: 'after'; readonly stepId: TStepId }
	| { readonly type: 'replace'; readonly stepId: TStepId }
	| { readonly type: 'disable'; readonly stepId: TStepId }
	| { readonly type: 'first' }
	| { readonly type: 'last' };

/**
 * Step dependency definition.
 *
 * @typeParam TStepId - Union type of valid step IDs
 */
export interface StepDependency<TStepId extends string = string> {
	readonly stepId: TStepId;
	readonly required?: boolean;
	readonly requiredData?: readonly string[];
}

/**
 * Pipeline step definition.
 *
 * @typeParam TStepId - Union type of valid step IDs
 */
export interface PipelineStepDefinition<TStepId extends string = string> {
	readonly id: TStepId;
	readonly name: string;
	readonly description?: string;
	readonly position: StepPosition<TStepId>;
	readonly dependencies?: readonly StepDependency<TStepId>[];
	readonly optional?: boolean;
	readonly parallelizable?: boolean;
	readonly settingsSchema?: JsonSchema;
	readonly provides?: readonly string[];
	readonly requires?: readonly string[];
	readonly estimatedDuration?: number;
}

/**
 * State of a single step during pipeline execution.
 *
 * @typeParam TStepId - Union type of valid step IDs
 */
export interface StepState<TStepId extends string = string> {
	readonly definition: PipelineStepDefinition<TStepId>;
	readonly status: StepStatus;
	readonly startedAt?: number;
	readonly completedAt?: number;
	readonly error?: Error | string;
	readonly result?: Record<string, unknown>;
}

/**
 * State of the entire pipeline during execution.
 *
 * @typeParam TStepId - Union type of valid step IDs
 */
export interface PipelineState<TStepId extends string = string> {
	readonly steps: Map<TStepId, StepState<TStepId>>;
	readonly currentStep?: TStepId;
	readonly completedSteps: readonly TStepId[];
	readonly failedSteps: readonly TStepId[];
	readonly isRunning: boolean;
	readonly isCancelled: boolean;
	readonly startedAt?: number;
	readonly completedAt?: number;
}
