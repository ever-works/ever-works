import type { IPlugin } from '../plugin.interface.js';
import type { ItemData, Category, Tag, Brand, DomainAnalysis } from '@ever-works/contracts';
import type { PipelineStepDefinition, PipelineState } from '../../pipeline/step-definition.types.js';
import type { ExecutionPlan } from '../../pipeline/parallel-group.types.js';
import type {
	MutableGenerationContext,
	GenerationRequest,
	ExistingItems,
	DirectoryReference
} from '../../pipeline/generation-context.interface.js';
import type { IBuiltInStepExecutor } from '../../pipeline/built-in-step-executor.interface.js';
import type { StepExecutionContext } from '../../pipeline/step-execution-context.interface.js';
import type { PipelineMetrics } from '../../pipeline/step-types.js';

// ============================================================================
// Shared Pipeline Types
// ============================================================================

/**
 * Pipeline execution options
 */
export interface PipelineExecutionOptions {
	/** Maximum execution time in ms */
	readonly timeout?: number;
	/** Steps to skip */
	readonly skipSteps?: readonly string[];
	/** Steps to include (if set, only these steps run) */
	readonly onlySteps?: readonly string[];
	/** Custom settings for steps */
	readonly stepSettings?: Record<string, Record<string, unknown>>;
	/** Cancellation signal */
	readonly signal?: AbortSignal;
	/** Whether to continue on step failure */
	readonly continueOnError?: boolean;
	/** Maximum concurrent steps */
	readonly maxConcurrent?: number;
	/** Facade access for any pipeline (provided by the engine) */
	readonly execContext?: StepExecutionContext;
}

/**
 * Pipeline progress callback
 */
export type PipelineProgressCallback = (progress: PipelineProgress) => void;

/**
 * Pipeline progress information
 */
export interface PipelineProgress {
	/** Overall progress percentage (0-100) */
	readonly percent: number;
	/** Current step index */
	readonly currentStepIndex: number;
	/** Total steps */
	readonly totalSteps: number;
	/** Current step name */
	readonly currentStepName: string;
	/** Current step progress */
	readonly stepProgress?: number;
	/** Progress message */
	readonly message?: string;
	/** Items processed so far */
	readonly itemsProcessed?: number;
}

/**
 * Pipeline execution result
 */
export interface PipelineResult {
	/** Whether execution was successful */
	readonly success: boolean;
	/** Generated items */
	readonly items: readonly ItemData[];
	/** Generated categories */
	readonly categories: readonly Category[];
	/** Generated tags */
	readonly tags: readonly Tag[];
	/** Generated brands */
	readonly brands: readonly Brand[];
	/** Domain analysis from generation */
	readonly domainAnalysis?: DomainAnalysis;
	/** Pipeline execution metrics */
	readonly metrics?: PipelineMetrics;
	/** Execution duration in ms */
	readonly duration: number;
	/** Steps completed */
	readonly stepsCompleted: number;
	/** Total steps */
	readonly totalSteps: number;
	/** Error if failed */
	readonly error?: Error | string;
	/** Failed step */
	readonly failedStep?: string;
	/** Pipeline state */
	readonly state?: PipelineState;
}

// ============================================================================
// Shared Step Types
// ============================================================================

/**
 * Pipeline step execution options
 */
export interface StepExecutionOptions {
	/** Timeout in milliseconds */
	readonly timeout?: number;
	/** Whether to skip on error */
	readonly skipOnError?: boolean;
	/** Custom step settings */
	readonly settings?: Record<string, unknown>;
	/** Signal for cancellation */
	readonly signal?: AbortSignal;
}

/**
 * Step progress callback
 */
export type StepProgressCallback = (progress: StepProgress) => void;

/**
 * Step progress information
 */
export interface StepProgress {
	/** Progress percentage (0-100) */
	readonly percent: number;
	/** Progress message */
	readonly message?: string;
	/** Items processed */
	readonly itemsProcessed?: number;
	/** Total items to process */
	readonly totalItems?: number;
}

// ============================================================================
// Pipeline Plugin Interface
// ============================================================================

/**
 * Unified pipeline plugin interface.
 * Capability: 'pipeline'
 *
 * All pipelines implement this interface. A pipeline generates directory content
 * (items, categories, tags, brands) through a series of steps.
 *
 * Pipelines come in two flavors:
 * - **Engine-orchestratable**: Implements optional step execution methods (executeStep,
 *   registerStepExecutor, etc.). The engine can run steps individually and
 *   pipeline-modifier plugins can inject/replace/disable steps.
 *   Example: standard-pipeline (15 steps)
 *
 * - **Self-managed**: Only implements required methods. The plugin owns execution entirely.
 *   Example: claude-code (5 steps)
 *
 * @typeParam TStepId - Union type of valid step IDs
 */
export interface IPipelinePlugin<TStepId extends string = string> extends IPlugin {
	/** All pipelines must define their steps */
	getStepDefinitions(): readonly PipelineStepDefinition<TStepId>[];

	/** All pipelines must be executable */
	execute(
		directory: DirectoryReference,
		request: GenerationRequest,
		existing: ExistingItems,
		options?: PipelineExecutionOptions,
		onProgress?: PipelineProgressCallback
	): Promise<PipelineResult>;

	/** Create an execution plan (step ordering, parallelization) */
	createExecutionPlan?(options?: PipelineExecutionOptions): ExecutionPlan;

	// --- Optional: Engine-orchestrated step execution ---
	// If these are implemented, the engine CAN run steps individually
	// and pipeline-modifier plugins CAN inject/replace/disable steps.

	/** Check if a step ID belongs to this pipeline */
	isValidStepId?(stepId: string): stepId is TStepId;
	/** Get all valid step IDs */
	getStepIds?(): readonly TStepId[];
	/** Register an executor for a step */
	registerStepExecutor?(stepId: TStepId, executor: IBuiltInStepExecutor): void;
	/** Check if executor is registered */
	hasExecutor?(stepId: TStepId): boolean;
	/** Execute a single step */
	executeStep?(
		stepId: TStepId | string,
		context: MutableGenerationContext,
		execContext: StepExecutionContext,
		options?: StepExecutionOptions,
		onProgress?: StepProgressCallback
	): Promise<MutableGenerationContext>;

	// --- Optional: lifecycle ---
	cancel?(): Promise<void>;
	getState?(): PipelineState | null;
	resume?(
		state: PipelineState,
		context: MutableGenerationContext,
		options?: PipelineExecutionOptions,
		onProgress?: PipelineProgressCallback
	): Promise<PipelineResult>;
	executeWithContext?(
		context: MutableGenerationContext,
		options?: PipelineExecutionOptions,
		onProgress?: PipelineProgressCallback
	): Promise<PipelineResult>;
}

/**
 * Type guard for pipeline plugins
 */
export function isPipelinePlugin(plugin: IPlugin): plugin is IPipelinePlugin {
	return plugin.capabilities.includes('pipeline');
}

/**
 * Check if a pipeline supports engine-orchestrated step execution.
 * Pipelines that support this can have steps injected/replaced/disabled by modifier plugins.
 */
export function isStepOrchestratablePipeline(plugin: IPipelinePlugin): boolean {
	return typeof plugin.executeStep === 'function' && typeof plugin.registerStepExecutor === 'function';
}
