import type {
	IPlugin,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	ValidationResult,
	PluginSettings,
	MutableGenerationContext,
	PipelineStepDefinition,
	StepExecutionOptions,
	StepProgressCallback,
	IPipelineStepPlugin,
	BuiltInStepId
} from '@ever-works/plugin';

/**
 * Interface for built-in step executor services
 */
export interface IBuiltInStepExecutor {
	name: string;
	run(context: MutableGenerationContext): Promise<MutableGenerationContext>;
}

/**
 * Default Pipeline Plugin - System plugin providing the standard generation pipeline.
 *
 * This plugin is the **single source of truth** for all built-in pipeline steps.
 * The pipeline engine itself has no hardcoded knowledge of steps - it queries
 * this plugin for step definitions.
 *
 * Key characteristics:
 * - System plugin (cannot be disabled by users)
 * - Lowest priority (other plugins can replace or modify its steps)
 * - Owns all 15 built-in step definitions and service mappings
 *
 * NOTE: This is a standalone package, NOT a NestJS module.
 * It uses PluginContext for dependencies, not NestJS DI.
 */
export class DefaultPipelinePlugin implements IPlugin, IPipelineStepPlugin {
	// ============================================================================
	// Built-in Step Definitions (Single Source of Truth)
	// ============================================================================

	/**
	 * Built-in pipeline step definitions with explicit dependencies.
	 * These define the standard generation pipeline for directory item generation.
	 *
	 * The steps are organized by their data flow dependencies:
	 * - Early steps (prompt-comparison, prompt-processing, domain-detection) set up context
	 * - Middle steps (search, retrieval, extraction) gather and process data
	 * - Late steps (aggregation, categorization, validation) finalize the output
	 */
	private static readonly STEPS: PipelineStepDefinition[] = [
		// ============================================================================
		// Phase 1: Initialization and Analysis
		// ============================================================================

		{
			id: 'prompt-comparison' as BuiltInStepId,
			name: 'Prompt Comparison',
			description: 'Compares current prompt with previous generation to determine if regeneration is needed',
			position: { type: 'first' },
			dependencies: [],
			provides: ['shouldStop'],
			requires: [],
			optional: false,
			parallelizable: false,
			estimatedDuration: 2
		},

		{
			id: 'prompt-processing' as BuiltInStepId,
			name: 'Prompt Processing',
			description: 'Processes the user prompt to extract subject and featured item hints',
			position: { type: 'after', stepId: 'prompt-comparison' },
			dependencies: [{ stepId: 'prompt-comparison', required: true }],
			provides: ['subject', 'featuredItemHints'],
			requires: [],
			optional: false,
			parallelizable: false,
			estimatedDuration: 5
		},

		{
			id: 'domain-detection' as BuiltInStepId,
			name: 'Domain Detection',
			description: 'Analyzes the prompt to detect the domain type for specialized handling',
			position: { type: 'after', stepId: 'prompt-processing' },
			dependencies: [{ stepId: 'prompt-processing', required: true }],
			provides: ['domainAnalysis'],
			requires: ['subject'],
			optional: false,
			parallelizable: false,
			estimatedDuration: 8
		},

		// ============================================================================
		// Phase 2: Initial Content Generation
		// ============================================================================

		{
			id: 'ai-first-items-generation' as BuiltInStepId,
			name: 'AI First Items Generation',
			description: 'Generates initial items using AI based on the prompt and domain analysis',
			position: { type: 'after', stepId: 'domain-detection' },
			dependencies: [
				{ stepId: 'prompt-processing', required: true },
				{ stepId: 'domain-detection', required: true }
			],
			provides: ['initialAiItems', 'allInitialCategories', 'allPriorityCategories'],
			requires: ['subject', 'domainAnalysis'],
			optional: false,
			parallelizable: false,
			estimatedDuration: 30
		},

		// ============================================================================
		// Phase 3: Web Search and Retrieval
		// ============================================================================

		{
			id: 'search-queries-generation' as BuiltInStepId,
			name: 'Search Queries Generation',
			description: 'Generates search queries based on the prompt and existing items',
			position: { type: 'after', stepId: 'ai-first-items-generation' },
			dependencies: [
				{ stepId: 'prompt-processing', required: true },
				{ stepId: 'domain-detection', required: true },
				{ stepId: 'ai-first-items-generation', required: false }
			],
			provides: ['searchQueries'],
			requires: ['subject', 'domainAnalysis'],
			optional: false,
			parallelizable: false,
			estimatedDuration: 10
		},

		{
			id: 'web-search' as BuiltInStepId,
			name: 'Web Search',
			description: 'Executes search queries to find relevant URLs',
			position: { type: 'after', stepId: 'search-queries-generation' },
			dependencies: [{ stepId: 'search-queries-generation', required: true }],
			provides: ['extractedUrls'],
			requires: ['searchQueries'],
			optional: false,
			parallelizable: false,
			estimatedDuration: 15
		},

		{
			id: 'content-retrieval' as BuiltInStepId,
			name: 'Content Retrieval',
			description: 'Retrieves web page content from discovered URLs',
			position: { type: 'after', stepId: 'web-search' },
			dependencies: [{ stepId: 'web-search', required: true }],
			provides: ['webPages', 'processedSourceUrls', 'contentCache'],
			requires: ['extractedUrls'],
			optional: false,
			parallelizable: true,
			estimatedDuration: 45
		},

		{
			id: 'content-filtering' as BuiltInStepId,
			name: 'Content Filtering',
			description: 'Filters retrieved content for relevance',
			position: { type: 'after', stepId: 'content-retrieval' },
			dependencies: [
				{ stepId: 'content-retrieval', required: true },
				{ stepId: 'domain-detection', required: true }
			],
			provides: ['webPages'],
			requires: ['webPages', 'domainAnalysis'],
			optional: false,
			parallelizable: false,
			estimatedDuration: 10
		},

		// ============================================================================
		// Phase 4: Item Extraction
		// ============================================================================

		{
			id: 'items-extraction' as BuiltInStepId,
			name: 'Items Extraction',
			description: 'Extracts items from filtered web content',
			position: { type: 'after', stepId: 'content-filtering' },
			dependencies: [
				{ stepId: 'content-filtering', required: true },
				{ stepId: 'domain-detection', required: true }
			],
			provides: ['extractedWebItems'],
			requires: ['webPages', 'domainAnalysis'],
			optional: false,
			parallelizable: true,
			estimatedDuration: 60
		},

		// ============================================================================
		// Phase 5: Data Aggregation and Deduplication
		// ============================================================================

		{
			id: 'deduplication-and-data-aggregation' as BuiltInStepId,
			name: 'Deduplication and Data Aggregation',
			description: 'Merges AI and web items, removes duplicates, and aggregates data',
			position: { type: 'after', stepId: 'items-extraction' },
			dependencies: [
				{ stepId: 'ai-first-items-generation', required: false },
				{ stepId: 'items-extraction', required: false }
			],
			provides: ['aggregatedItems'],
			requires: [],
			optional: false,
			parallelizable: false,
			estimatedDuration: 20
		},

		// ============================================================================
		// Phase 6: Categorization and Validation
		// ============================================================================

		{
			id: 'categories-tags-processing' as BuiltInStepId,
			name: 'Categories and Tags Processing',
			description: 'Processes and assigns categories and tags to items',
			position: { type: 'after', stepId: 'deduplication-and-data-aggregation' },
			dependencies: [
				{ stepId: 'deduplication-and-data-aggregation', required: true },
				{ stepId: 'domain-detection', required: true }
			],
			provides: ['finalItems', 'finalCategories', 'finalTags', 'finalBrands'],
			requires: ['aggregatedItems', 'domainAnalysis'],
			optional: false,
			parallelizable: false,
			estimatedDuration: 25
		},

		{
			id: 'sources-validation' as BuiltInStepId,
			name: 'Sources Validation',
			description: 'Validates source URLs and ensures they are accessible',
			position: { type: 'after', stepId: 'categories-tags-processing' },
			dependencies: [{ stepId: 'categories-tags-processing', required: true }],
			provides: ['finalItems'],
			requires: ['finalItems'],
			optional: true,
			parallelizable: true,
			estimatedDuration: 15
		},

		// ============================================================================
		// Phase 7: Enrichment
		// ============================================================================

		{
			id: 'badges-processing' as BuiltInStepId,
			name: 'Badges Processing',
			description: 'Evaluates and assigns badges to items',
			position: { type: 'after', stepId: 'sources-validation' },
			dependencies: [{ stepId: 'categories-tags-processing', required: true }],
			provides: ['finalItems'],
			requires: ['finalItems'],
			optional: true,
			parallelizable: false,
			estimatedDuration: 10
		},

		{
			id: 'image-capture' as BuiltInStepId,
			name: 'Image Capture',
			description: 'Captures screenshots or fetches images for items',
			position: { type: 'after', stepId: 'badges-processing' },
			dependencies: [{ stepId: 'categories-tags-processing', required: true }],
			provides: ['finalItems'],
			requires: ['finalItems'],
			optional: true,
			parallelizable: true,
			estimatedDuration: 30
		},

		// ============================================================================
		// Phase 8: Final Output
		// ============================================================================

		{
			id: 'markdown-generation' as BuiltInStepId,
			name: 'Markdown Generation',
			description: 'Generates markdown descriptions for items using source content',
			position: { type: 'last' },
			dependencies: [
				{ stepId: 'image-capture', required: false },
				{ stepId: 'badges-processing', required: false }
			],
			provides: ['finalItems'],
			requires: ['finalItems', 'contentCache'],
			optional: true,
			parallelizable: true,
			estimatedDuration: 45
		}
	];

	/**
	 * Map of step ID to step definition for quick lookup
	 */
	private static readonly STEPS_MAP: Map<BuiltInStepId, PipelineStepDefinition> = new Map(
		DefaultPipelinePlugin.STEPS.map((step) => [step.id as BuiltInStepId, step])
	);

	/**
	 * Service ID mapping for built-in steps.
	 * Maps step ID to the NestJS service that executes it (in packages/agent).
	 */
	private static readonly SERVICE_MAP: Record<BuiltInStepId, string> = {
		'prompt-comparison': 'PromptComparisonService',
		'prompt-processing': 'PromptProcessingService',
		'domain-detection': 'DomainDetectionService',
		'ai-first-items-generation': 'AiItemGenerationService',
		'search-queries-generation': 'SearchQueryGenerationService',
		'web-search': 'SearchService',
		'content-retrieval': 'WebPageRetrievalService',
		'content-filtering': 'ContentFilteringService',
		'items-extraction': 'ItemExtractionService',
		'deduplication-and-data-aggregation': 'DataAggregationService',
		'categories-tags-processing': 'CategoryProcessingService',
		'sources-validation': 'SourceValidationService',
		'badges-processing': 'BadgeProcessingService',
		'image-capture': 'ImageCaptureService',
		'markdown-generation': 'MarkdownGenerationService'
	};

	// ============================================================================
	// Static Methods for External Access
	// ============================================================================

	/**
	 * Check if a step ID is a built-in step (type guard)
	 */
	static isBuiltInStep(stepId: string): stepId is BuiltInStepId {
		return DefaultPipelinePlugin.STEPS_MAP.has(stepId as BuiltInStepId);
	}

	/**
	 * Get a built-in step definition by ID
	 */
	static getBuiltInStep(stepId: BuiltInStepId): PipelineStepDefinition | undefined {
		return DefaultPipelinePlugin.STEPS_MAP.get(stepId);
	}

	/**
	 * Get all built-in step IDs
	 */
	static getBuiltInStepIds(): BuiltInStepId[] {
		return DefaultPipelinePlugin.STEPS.map((step) => step.id as BuiltInStepId);
	}

	/**
	 * Get all built-in step definitions (returns a copy)
	 */
	static getBuiltInSteps(): PipelineStepDefinition[] {
		return [...DefaultPipelinePlugin.STEPS];
	}

	/**
	 * Get the service name mapping for built-in steps
	 */
	static getServiceMap(): Record<BuiltInStepId, string> {
		return { ...DefaultPipelinePlugin.SERVICE_MAP };
	}

	/**
	 * Get the service name for a specific step
	 */
	static getServiceNameForStep(stepId: BuiltInStepId): string | undefined {
		return DefaultPipelinePlugin.SERVICE_MAP[stepId];
	}

	// ============================================================================
	// IPlugin Interface Properties
	// ============================================================================

	readonly id = 'default-pipeline';
	readonly name = 'Default Pipeline';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'pipeline';
	readonly capabilities: readonly string[] = ['pipeline-step'];
	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {}
	};

	/**
	 * Marks this as a system plugin that cannot be disabled
	 */
	readonly systemPlugin = true;

	/**
	 * Map of step ID to the service that executes it
	 */
	private stepExecutors = new Map<string, IBuiltInStepExecutor>();

	private context?: PluginContext;

	/**
	 * Register a built-in step executor service
	 */
	registerStepExecutor(stepId: BuiltInStepId, executor: IBuiltInStepExecutor): void {
		this.stepExecutors.set(stepId, executor);
		this.context?.logger.debug(`Registered executor for step: ${stepId}`);
	}

	/**
	 * Register multiple step executors at once
	 */
	registerStepExecutors(executors: Map<BuiltInStepId, IBuiltInStepExecutor>): void {
		for (const [stepId, executor] of executors) {
			this.registerStepExecutor(stepId, executor);
		}
	}

	/**
	 * Check if an executor is registered for a step
	 */
	hasExecutor(stepId: string): boolean {
		return this.stepExecutors.has(stepId);
	}

	/**
	 * Get the service name for a built-in step (instance method)
	 */
	getServiceName(stepId: BuiltInStepId): string | undefined {
		return DefaultPipelinePlugin.SERVICE_MAP[stepId];
	}

	// ============================================================================
	// IPipelineStepPlugin interface
	// ============================================================================

	/**
	 * Get step definitions for all built-in steps
	 */
	getStepDefinition(): PipelineStepDefinition {
		// This returns the first step - in practice, getStepDefinitions is used
		return DefaultPipelinePlugin.STEPS[0];
	}

	/**
	 * Get all step definitions provided by this plugin
	 */
	getStepDefinitions(): PipelineStepDefinition[] {
		return [...DefaultPipelinePlugin.STEPS];
	}

	/**
	 * Execute a pipeline step
	 */
	async execute(
		context: MutableGenerationContext,
		options?: StepExecutionOptions,
		onProgress?: StepProgressCallback
	): Promise<MutableGenerationContext> {
		// This method is called when the pipeline executes a specific step
		// The stepId should be passed through options.settings.stepId
		const stepId = options?.settings?.stepId as string;

		if (!stepId) {
			throw new Error('DefaultPipelinePlugin.execute() requires stepId in options.settings');
		}

		return this.executeStep(stepId, context, options, onProgress);
	}

	/**
	 * Execute a specific step by ID
	 */
	async executeStep(
		stepId: string,
		context: MutableGenerationContext,
		options?: StepExecutionOptions,
		onProgress?: StepProgressCallback
	): Promise<MutableGenerationContext> {
		const executor = this.stepExecutors.get(stepId);

		if (!executor) {
			const serviceName = DefaultPipelinePlugin.SERVICE_MAP[stepId as BuiltInStepId];
			throw new Error(
				`No executor registered for step "${stepId}". ` + `Expected service: ${serviceName || 'unknown'}`
			);
		}

		// Report progress start
		if (onProgress) {
			onProgress({
				percent: 0,
				message: `Starting ${executor.name}`
			});
		}

		// Check for cancellation
		if (options?.signal?.aborted) {
			throw new Error(`Step "${stepId}" was cancelled before execution`);
		}

		try {
			const result = await executor.run(context);

			// Report progress complete
			if (onProgress) {
				onProgress({
					percent: 100,
					message: `Completed ${executor.name}`
				});
			}

			return result;
		} catch (error) {
			this.context?.logger.error(`Step "${stepId}" failed: ${(error as Error).message}`);
			throw error;
		}
	}

	/**
	 * Check if a step can be skipped (built-in steps use shouldStop flag)
	 */
	async canSkip(context: MutableGenerationContext): Promise<boolean> {
		return context.shouldStop === true;
	}

	/**
	 * Validate that a step can run
	 */
	async validate(context: MutableGenerationContext): Promise<{ valid: boolean; error?: string }> {
		if (context.shouldStop) {
			return { valid: false, error: 'Pipeline stopped' };
		}
		return { valid: true };
	}

	// ============================================================================
	// IPlugin lifecycle interface
	// ============================================================================

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Default Pipeline Plugin loaded');
	}

	async onEnable(_context: PluginContext): Promise<void> {
		this.context?.logger.log('Default Pipeline Plugin enabled');
	}

	async onDisable(_context: PluginContext): Promise<void> {
		// System plugins should not be disabled, but handle gracefully
		this.context?.logger.warn('Attempted to disable system plugin - this should not happen');
	}

	async onUnload(): Promise<void> {
		this.stepExecutors.clear();
		this.context = undefined;
	}

	async validateSettings(_settings: PluginSettings): Promise<ValidationResult> {
		return { valid: true };
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		const registeredSteps = this.stepExecutors.size;
		const totalSteps = DefaultPipelinePlugin.STEPS.length;
		const allRegistered = registeredSteps === totalSteps;

		const missingSteps = DefaultPipelinePlugin.STEPS.filter((s) => !this.stepExecutors.has(s.id)).map((s) => s.id);

		return {
			status: allRegistered ? 'healthy' : 'degraded',
			message: allRegistered
				? `All ${totalSteps} built-in steps registered`
				: `Only ${registeredSteps}/${totalSteps} steps registered`,
			checkedAt: Date.now(),
			checks: missingSteps.map((stepId) => ({
				name: `step-${stepId}`,
				status: 'unhealthy' as const,
				message: `Missing executor for step: ${stepId}`,
				data: { stepId }
			}))
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'System plugin providing the default generation pipeline',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true
		};
	}
}

export default DefaultPipelinePlugin;
