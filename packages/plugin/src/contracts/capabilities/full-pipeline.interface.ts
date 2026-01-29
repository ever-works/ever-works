import type { IPlugin } from '../plugin.interface.js';
import type { ItemData, Category, Tag, Brand } from '../../common/item.types.js';
import type { DomainAnalysis } from '../../common/domain.types.js';
import type {
	MutableGenerationContext,
	GenerationRequest,
	ExistingItems,
	DirectoryReference
} from '../../pipeline/generation-context.interface.js';
import type { ExecutionPlan } from '../../pipeline/parallel-group.types.js';
import type { PipelineStepDefinition, PipelineState } from '../../pipeline/step-definition.types.js';
import type { PipelineMetrics } from '../../pipeline/step-types.js';

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
	readonly state: PipelineState;
}

/**
 * Full pipeline plugin interface
 * Capability: 'full-pipeline'
 */
export interface IFullPipelinePlugin extends IPlugin {
	/**
	 * Get all step definitions in this pipeline
	 */
	getStepDefinitions(): readonly PipelineStepDefinition[];

	/**
	 * Create an execution plan
	 */
	createExecutionPlan(options?: PipelineExecutionOptions): ExecutionPlan;

	/**
	 * Execute the full pipeline
	 */
	execute(
		directory: DirectoryReference,
		request: GenerationRequest,
		existing: ExistingItems,
		options?: PipelineExecutionOptions,
		onProgress?: PipelineProgressCallback
	): Promise<PipelineResult>;

	/**
	 * Execute with an existing context
	 */
	executeWithContext?(
		context: MutableGenerationContext,
		options?: PipelineExecutionOptions,
		onProgress?: PipelineProgressCallback
	): Promise<PipelineResult>;

	/**
	 * Cancel execution
	 */
	cancel?(): Promise<void>;

	/**
	 * Get current pipeline state
	 */
	getState?(): PipelineState | null;

	/**
	 * Resume from a previous state
	 */
	resume?(
		state: PipelineState,
		context: MutableGenerationContext,
		options?: PipelineExecutionOptions,
		onProgress?: PipelineProgressCallback
	): Promise<PipelineResult>;
}

/**
 * Type guard for full pipeline plugins
 */
export function isFullPipelinePlugin(plugin: IPlugin): plugin is IFullPipelinePlugin {
	return plugin.capabilities.includes('full-pipeline');
}
