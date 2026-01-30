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
