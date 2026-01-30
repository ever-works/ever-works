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
	| { readonly type: 'first' }
	| { readonly type: 'last' };

export interface StepDependency {
	readonly stepId: string;
	readonly required?: boolean;
	readonly requiredData?: readonly string[];
}

export interface PipelineStepDefinition {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly position: StepPosition;
	readonly dependencies?: readonly StepDependency[];
	readonly optional?: boolean;
	readonly parallelizable?: boolean;
	readonly settingsSchema?: JsonSchema;
	readonly provides?: readonly string[];
	readonly requires?: readonly string[];
	readonly estimatedDuration?: number;
}

export interface StepState {
	readonly definition: PipelineStepDefinition;
	readonly status: StepStatus;
	readonly startedAt?: number;
	readonly completedAt?: number;
	readonly error?: Error | string;
	readonly result?: Record<string, unknown>;
}

export interface PipelineState {
	readonly steps: Map<string, StepState>;
	readonly currentStep?: string;
	readonly completedSteps: readonly string[];
	readonly failedSteps: readonly string[];
	readonly isRunning: boolean;
	readonly isCancelled: boolean;
	readonly startedAt?: number;
	readonly completedAt?: number;
}
