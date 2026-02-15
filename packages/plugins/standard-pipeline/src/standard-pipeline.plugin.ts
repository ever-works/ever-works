import type {
	IPipelinePlugin,
	IPipelineContext,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	ValidationResult,
	PluginSettings,
	PipelineStepDefinition,
	PipelineExecutionOptions,
	PipelineProgressCallback,
	PipelineResult,
	PipelineState,
	StepExecutionOptions,
	StepProgressCallback,
	IBuiltInStepExecutor,
	StepExecutionContext,
	FormFieldDefinition,
	FormFieldGroup,
	DirectoryReference,
	GenerationRequest,
	ExistingItems,
	IFormSchemaProvider
} from '@ever-works/plugin';
import type { MutableGenerationContext, GenerationContextSnapshot } from './context/index.js';
import type { StepDataKey } from './context/index.js';
import { TypedGenerationContext } from './context/index.js';

import type { BuiltInStepId } from './types.js';

import { PromptComparisonStep } from './steps/prompt-comparison.step.js';
import { PromptProcessingStep } from './steps/prompt-processing.step.js';
import { DomainDetectionStep } from './steps/domain-detection.step.js';
import { AiItemGenerationStep } from './steps/ai-item-generation.step.js';
import { SearchQueryGenerationStep } from './steps/search-query-generation.step.js';
import { WebSearchStep } from './steps/web-search.step.js';
import { ContentRetrievalStep } from './steps/content-retrieval.step.js';
import { ContentFilteringStep } from './steps/content-filtering.step.js';
import { ItemExtractionStep } from './steps/item-extraction.step.js';
import { DataAggregationStep } from './steps/data-aggregation.step.js';
import { CategoryProcessingStep } from './steps/category-processing.step.js';
import { SourceValidationStep } from './steps/source-validation.step.js';
import { BadgeProcessingStep } from './steps/badge-processing.step.js';
import { ImageCaptureStep } from './steps/image-capture.step.js';
import { MarkdownGenerationStep } from './steps/markdown-generation.step.js';

/**
 * Standard Pipeline Plugin - The default 15-step generation pipeline.
 *
 * This plugin is engine-orchestratable: it implements executeStep/registerStepExecutor
 * so the engine can run steps individually and pipeline-modifier plugins can
 * inject/replace/disable steps.
 *
 * Implements IPipelinePlugin (capability: 'pipeline') and IFormSchemaProvider.
 */
export class StandardPipelinePlugin implements IPipelinePlugin<BuiltInStepId>, IFormSchemaProvider {
	/**
	 * Built-in pipeline step definitions with explicit dependencies.
	 * Steps are organized by data flow: initialization -> generation -> search -> extraction -> aggregation -> output
	 */
	private static readonly STEPS: PipelineStepDefinition<BuiltInStepId>[] = [
		// Phase 1: Initialization
		{
			id: 'prompt-comparison',
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
			id: 'prompt-processing',
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
			id: 'domain-detection',
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

		// Phase 2: Content Generation
		{
			id: 'ai-first-items-generation',
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

		// Phase 3: Web Search
		{
			id: 'search-queries-generation',
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
			id: 'web-search',
			name: 'Web Search',
			description: 'Executes search queries to find relevant URLs',
			position: { type: 'after', stepId: 'search-queries-generation' },
			dependencies: [{ stepId: 'search-queries-generation', required: true }],
			provides: ['extractedUrls', 'webPages', 'processedSourceUrls', 'contentCache'],
			requires: ['searchQueries'],
			optional: false,
			parallelizable: false,
			estimatedDuration: 15
		},
		{
			id: 'content-retrieval',
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
			id: 'content-filtering',
			name: 'Content Filtering',
			description: 'Filters retrieved content for relevance',
			position: { type: 'after', stepId: 'content-retrieval' },
			dependencies: [
				{ stepId: 'content-retrieval', required: true },
				{ stepId: 'domain-detection', required: true }
			],
			provides: [],
			requires: ['webPages', 'domainAnalysis'],
			optional: false,
			parallelizable: false,
			estimatedDuration: 10
		},

		// Phase 4: Extraction
		{
			id: 'items-extraction',
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

		// Phase 5: Aggregation
		{
			id: 'deduplication-and-data-aggregation',
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

		// Phase 6: Categorization
		{
			id: 'categories-tags-processing',
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
			id: 'sources-validation',
			name: 'Sources Validation',
			description: 'Validates source URLs and ensures they are accessible',
			position: { type: 'after', stepId: 'categories-tags-processing' },
			dependencies: [{ stepId: 'categories-tags-processing', required: true }],
			provides: [],
			requires: ['finalItems'],
			optional: true,
			parallelizable: true,
			estimatedDuration: 15
		},

		// Phase 7: Enrichment
		{
			id: 'badges-processing',
			name: 'Badges Processing',
			description: 'Evaluates and assigns badges to items',
			position: { type: 'after', stepId: 'sources-validation' },
			dependencies: [{ stepId: 'categories-tags-processing', required: true }],
			provides: [],
			requires: ['finalItems'],
			optional: true,
			parallelizable: false,
			estimatedDuration: 10
		},
		{
			id: 'image-capture',
			name: 'Image Capture',
			description: 'Captures screenshots or fetches images for items',
			position: { type: 'after', stepId: 'badges-processing' },
			dependencies: [{ stepId: 'categories-tags-processing', required: true }],
			provides: [],
			requires: ['finalItems'],
			optional: true,
			parallelizable: true,
			estimatedDuration: 30
		},

		// Phase 8: Output
		{
			id: 'markdown-generation',
			name: 'Markdown Generation',
			description: 'Generates markdown descriptions for items using source content',
			position: { type: 'last' },
			dependencies: [
				{ stepId: 'image-capture', required: false },
				{ stepId: 'badges-processing', required: false }
			],
			provides: [],
			requires: ['finalItems', 'contentCache'],
			optional: true,
			parallelizable: true,
			estimatedDuration: 45
		}
	];

	private static readonly STEPS_MAP: Map<BuiltInStepId, PipelineStepDefinition<BuiltInStepId>> = new Map(
		StandardPipelinePlugin.STEPS.map((step) => [step.id, step])
	);

	// IPlugin properties
	readonly id = 'standard-pipeline';
	readonly name = 'Standard Pipeline';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'pipeline';
	readonly capabilities: readonly string[] = ['pipeline', 'form-schema-provider'];
	readonly settingsSchema: JsonSchema = { type: 'object', properties: {} };
	readonly systemPlugin = true;
	readonly handledConfigFields = ['*'] as const;

	private stepExecutors = new Map<BuiltInStepId, IBuiltInStepExecutor>();
	private context?: PluginContext;

	// IPipelinePlugin methods
	registerStepExecutor(stepId: BuiltInStepId, executor: IBuiltInStepExecutor): void {
		this.stepExecutors.set(stepId, executor);
		this.context?.logger.debug(`Registered executor for step: ${stepId}`);
	}

	registerStepExecutors(executors: Map<BuiltInStepId, IBuiltInStepExecutor>): void {
		for (const [stepId, executor] of executors) {
			this.registerStepExecutor(stepId, executor);
		}
	}

	isValidStepId(stepId: string): stepId is BuiltInStepId {
		return StandardPipelinePlugin.STEPS_MAP.has(stepId as BuiltInStepId);
	}

	getStepDefinition(stepId?: BuiltInStepId | string): PipelineStepDefinition<BuiltInStepId> | undefined {
		if (stepId) {
			return StandardPipelinePlugin.STEPS_MAP.get(stepId as BuiltInStepId);
		}
		return StandardPipelinePlugin.STEPS[0];
	}

	getStepDefinitions(): PipelineStepDefinition<BuiltInStepId>[] {
		return [...StandardPipelinePlugin.STEPS];
	}

	async execute(
		_directory: DirectoryReference,
		_request: GenerationRequest,
		_existing: ExistingItems,
		_options?: PipelineExecutionOptions,
		_onProgress?: PipelineProgressCallback
	): Promise<PipelineResult> {
		// Standard pipeline is engine-orchestrated — it should never be called directly.
		// The engine calls executeStep() for each step individually.
		throw new Error(
			'StandardPipelinePlugin.execute() should not be called directly. ' +
				'Use the pipeline engine to orchestrate step execution.'
		);
	}

	async executeStep(
		stepId: BuiltInStepId | string,
		context: IPipelineContext,
		execContext: StepExecutionContext,
		options?: StepExecutionOptions,
		onProgress?: StepProgressCallback
	): Promise<IPipelineContext> {
		const executor = this.stepExecutors.get(stepId as BuiltInStepId);

		if (!executor) {
			throw new Error(`No executor registered for step "${stepId}"`);
		}

		if (onProgress) {
			onProgress({ percent: 0, message: `Starting ${executor.name}` });
		}

		if (options?.signal?.aborted) {
			throw new Error(`Step "${stepId}" was cancelled before execution`);
		}

		try {
			const result = await executor.run(context, execContext);
			if (onProgress) {
				onProgress({ percent: 100, message: `Completed ${executor.name}` });
			}
			return result;
		} catch (error) {
			this.context?.logger.error(`Step "${stepId}" failed: ${(error as Error).message}`);
			throw error;
		}
	}

	// --- Context lifecycle hooks ---

	createContext(
		directory: DirectoryReference,
		request: GenerationRequest,
		existing: ExistingItems
	): IPipelineContext {
		return new TypedGenerationContext(directory, request, existing);
	}

	contextToSnapshot(context: IPipelineContext): unknown {
		return (context as TypedGenerationContext).toSnapshot();
	}

	contextFromSnapshot(snapshot: unknown): IPipelineContext {
		return TypedGenerationContext.fromSnapshot(snapshot as GenerationContextSnapshot);
	}

	extractResult(
		context: IPipelineContext,
		meta: { duration: number; stepsCompleted: number; totalSteps: number; state?: PipelineState }
	): PipelineResult {
		const ctx = context as TypedGenerationContext;
		const hasItems = ctx.finalItems.length > 0;
		ctx.updateMetrics({ duration: meta.duration, itemsProcessed: ctx.finalItems.length });
		return {
			success: hasItems,
			items: ctx.finalItems,
			categories: ctx.finalCategories,
			tags: ctx.finalTags,
			brands: ctx.finalBrands,
			duration: meta.duration,
			stepsCompleted: meta.stepsCompleted,
			totalSteps: meta.totalSteps,
			state: meta.state,
			warnings: ctx.warnings.length > 0 ? ctx.warnings : undefined,
			error: hasItems ? undefined : 'Pipeline completed but generated no items.'
		};
	}

	/**
	 * Determines if a checkpoint is worth resuming.
	 *
	 * Returns false (discard) when:
	 * - The pipeline was explicitly stopped (shouldStop === true)
	 * - Data-producing steps ran but produced nothing (empty pipeline — no point resuming)
	 *
	 * Returns true (resume) when:
	 * - Any intermediate data exists (webPages, items, etc.)
	 * - No data-producing steps have completed yet (too early to judge)
	 */
	isCheckpointViable(snapshot: unknown, completedSteps: string[]): boolean {
		const ctx = snapshot as GenerationContextSnapshot;

		// Explicitly stopped — discard
		if (ctx.shouldStop) return false;

		// Any intermediate data means progress was made — resume
		const hasData =
			ctx.webPages.length > 0 ||
			ctx.initialAiItems.length > 0 ||
			ctx.extractedWebItems.length > 0 ||
			ctx.aggregatedItems.length > 0 ||
			ctx.finalItems.length > 0;
		if (hasData) return true;

		// If data-producing steps already ran but produced nothing, don't resume
		const dataStepIds: string[] = this.getStepDefinitions()
			.filter((s) =>
				s.provides?.some((k) =>
					['webPages', 'initialAiItems', 'extractedWebItems', 'aggregatedItems', 'finalItems'].includes(k)
				)
			)
			.map((s) => s.id);
		return !completedSteps.some((id) => dataStepIds.includes(id));
	}

	canSkipStep(stepId: string, context: IPipelineContext): boolean {
		const ctx = context as TypedGenerationContext;
		const step = this.getStepDefinition(stepId as BuiltInStepId);
		if (!step?.provides?.length) return false;
		return step.provides.every((key) => ctx.hasStepResult(key as StepDataKey));
	}

	// IFormSchemaProvider methods
	getFormFields(): FormFieldDefinition[] {
		return [
			// Data Sources
			{
				name: 'source_urls',
				type: 'tags',
				label: 'Source URLs',
				description: 'URLs to extract items from directly (bypasses search)',
				placeholder: 'https://example.com/products',
				group: 'sources'
			},

			// Categories
			{
				name: 'initial_categories',
				type: 'tags',
				label: 'Initial Categories',
				description: 'Suggested categories for the directory',
				group: 'categories'
			},
			{
				name: 'priority_categories',
				type: 'tags',
				label: 'Priority Categories',
				description: 'Categories to prioritize and show first in results',
				group: 'categories'
			},
			{
				name: 'target_keywords',
				type: 'tags',
				label: 'Target Keywords',
				description: 'Keywords to guide search and extraction',
				group: 'categories'
			},

			// Features
			{
				name: 'ai_first_generation_enabled',
				type: 'boolean',
				label: 'AI First Generation',
				description: 'Generate initial items using AI before web search',
				defaultValue: false,
				group: 'features'
			},
			{
				name: 'generate_categories',
				type: 'boolean',
				label: 'Generate Categories',
				description: 'Automatically generate categories from content',
				defaultValue: true,
				group: 'features'
			},
			{
				name: 'generate_tags',
				type: 'boolean',
				label: 'Generate Tags',
				description: 'Automatically generate tags for items',
				defaultValue: true,
				group: 'features'
			},
			{
				name: 'generate_brands',
				type: 'boolean',
				label: 'Extract Brands',
				description: 'Extract and categorize brands from content',
				defaultValue: true,
				group: 'features'
			},
			{
				name: 'capture_screenshots',
				type: 'boolean',
				label: 'Capture Screenshots',
				description: 'Take screenshots or extract images for items',
				defaultValue: false,
				group: 'features'
			},
			{
				name: 'badge_evaluation_enabled',
				type: 'boolean',
				label: 'Enable Badge Evaluation',
				description: 'Evaluate and assign badges to items',
				defaultValue: false,
				group: 'features'
			},

			// Search
			{
				name: 'max_search_queries',
				type: 'number',
				label: 'Max Search Queries',
				description: 'Number of search queries to generate and execute',
				defaultValue: 10,
				validation: { min: 1, max: 100 },
				group: 'search'
			},
			{
				name: 'max_results_per_query',
				type: 'number',
				label: 'Results per Query',
				description: 'Maximum results to retrieve per search query',
				defaultValue: 5,
				validation: { min: 1, max: 100 },
				group: 'search'
			},
			{
				name: 'max_pages_to_process',
				type: 'number',
				label: 'Max Pages to Process',
				description: 'Maximum web pages to process for content extraction',
				defaultValue: 10,
				validation: { min: 1, max: 1000 },
				group: 'search'
			},

			// Volume
			{
				name: 'data_volume_mode',
				type: 'select',
				label: 'Data Volume',
				description: 'Controls the amount of data processed',
				options: [
					{ value: 'real', label: 'Full (production)' },
					{ value: 'sample', label: 'Sample (testing)' }
				],
				defaultValue: 'real',
				group: 'volume'
			},
			{
				name: 'max_items',
				type: 'number',
				label: 'Max Items',
				description: 'Maximum items to generate (optional limit)',
				validation: { min: 1, max: 1000 },
				group: 'volume'
			},

			// Advanced
			{
				name: 'content_filtering_enabled',
				type: 'boolean',
				label: 'Content Filtering',
				description: 'Filter irrelevant content before extraction',
				defaultValue: true,
				group: 'advanced'
			},
			{
				name: 'relevance_threshold_content',
				type: 'number',
				label: 'Relevance Threshold',
				description: 'Minimum relevance score for content (0-1)',
				defaultValue: 0.6,
				validation: { min: 0, max: 1 },
				showIf: { field: 'content_filtering_enabled', operator: 'eq', value: true },
				group: 'advanced'
			},
			{
				name: 'min_content_length_for_extraction',
				type: 'number',
				label: 'Min Content Length',
				description: 'Minimum character length for content extraction',
				defaultValue: 100,
				validation: { min: 0, max: 10000 },
				group: 'advanced'
			},
			{
				name: 'prompt_comparison_confidence_threshold',
				type: 'number',
				label: 'Prompt Comparison Threshold',
				description: 'Confidence threshold for prompt similarity (0-1)',
				defaultValue: 0.5,
				validation: { min: 0, max: 1 },
				group: 'advanced'
			}
		];
	}

	getFormGroups(): FormFieldGroup[] {
		return [
			{
				name: 'sources',
				title: 'Data Sources',
				description: 'Configure where to find items',
				order: 1,
				collapsible: true,
				collapsed: true
			},
			{
				name: 'categories',
				title: 'Categories & Keywords',
				description: 'Guide the categorization and search',
				order: 2,
				collapsible: true,
				collapsed: true
			},
			{
				name: 'features',
				title: 'Generation Features',
				description: 'Enable or disable generation features',
				order: 3,
				collapsible: true,
				collapsed: true
			},
			{
				name: 'search',
				title: 'Search Configuration',
				description: 'Configure web search behavior',
				order: 4,
				collapsible: true,
				collapsed: true
			},
			{
				name: 'volume',
				title: 'Volume Control',
				description: 'Control the amount of data processed',
				order: 5,
				collapsible: true,
				collapsed: true
			},
			{
				name: 'advanced',
				title: 'Advanced Settings',
				description: 'Fine-tune extraction and filtering',
				order: 6,
				collapsible: true,
				collapsed: true
			}
		];
	}

	validateFormInput(values: Record<string, unknown>): ValidationResult {
		const errors: Array<{ path: string; message: string }> = [];

		const numericFields = [
			{ name: 'max_search_queries', min: 1, max: 100 },
			{ name: 'max_results_per_query', min: 1, max: 100 },
			{ name: 'max_pages_to_process', min: 1, max: 1000 },
			{ name: 'max_items', min: 1, max: 1000 },
			{ name: 'relevance_threshold_content', min: 0, max: 1 },
			{ name: 'min_content_length_for_extraction', min: 0, max: 10000 },
			{ name: 'prompt_comparison_confidence_threshold', min: 0, max: 1 }
		];

		for (const field of numericFields) {
			const value = values[field.name];
			if (value !== undefined && value !== null) {
				const num = Number(value);
				if (isNaN(num)) {
					errors.push({ path: field.name, message: `${field.name} must be a number` });
				} else if (num < field.min || num > field.max) {
					errors.push({
						path: field.name,
						message: `${field.name} must be between ${field.min} and ${field.max}`
					});
				}
			}
		}

		const urlArrayFields = ['source_urls'];
		for (const fieldName of urlArrayFields) {
			const value = values[fieldName];
			if (Array.isArray(value)) {
				for (let i = 0; i < value.length; i++) {
					const url = value[i];
					if (typeof url === 'string' && url.trim()) {
						try {
							new URL(url);
						} catch {
							errors.push({ path: `${fieldName}[${i}]`, message: `Invalid URL: ${url}` });
						}
					}
				}
			}
		}

		const volumeMode = values.data_volume_mode;
		if (volumeMode !== undefined && !['real', 'sample'].includes(volumeMode as string)) {
			errors.push({ path: 'data_volume_mode', message: 'data_volume_mode must be "real" or "sample"' });
		}

		return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
	}

	getDefaultValues(): Record<string, unknown> {
		const defaults: Record<string, unknown> = {};
		for (const field of this.getFormFields()) {
			if (field.defaultValue !== undefined) {
				defaults[field.name] = field.defaultValue;
			}
		}
		return defaults;
	}

	transformFormValues(values: Record<string, unknown>): Record<string, unknown> {
		const transformed = { ...values };

		if (transformed.data_volume_mode) {
			transformed.data_volume_mode = (transformed.data_volume_mode as string).toUpperCase();
		}

		for (const key of Object.keys(transformed)) {
			if (Array.isArray(transformed[key]) && (transformed[key] as unknown[]).length === 0) {
				delete transformed[key];
			}
		}

		return transformed;
	}

	// IPlugin lifecycle
	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		this.registerBuiltInStepExecutors();
		context.logger.log(`Standard Pipeline Plugin loaded with ${this.stepExecutors.size} step executors`);
	}

	private registerBuiltInStepExecutors(): void {
		const stepExecutors: Record<BuiltInStepId, IBuiltInStepExecutor> = {
			'prompt-comparison': new PromptComparisonStep(),
			'prompt-processing': new PromptProcessingStep(),
			'domain-detection': new DomainDetectionStep(),
			'ai-first-items-generation': new AiItemGenerationStep(),
			'search-queries-generation': new SearchQueryGenerationStep(),
			'web-search': new WebSearchStep(),
			'content-retrieval': new ContentRetrievalStep(),
			'content-filtering': new ContentFilteringStep(),
			'items-extraction': new ItemExtractionStep(),
			'deduplication-and-data-aggregation': new DataAggregationStep(),
			'categories-tags-processing': new CategoryProcessingStep(),
			'sources-validation': new SourceValidationStep(),
			'badges-processing': new BadgeProcessingStep(),
			'image-capture': new ImageCaptureStep(),
			'markdown-generation': new MarkdownGenerationStep()
		};

		for (const [stepId, executor] of Object.entries(stepExecutors)) {
			this.registerStepExecutor(stepId as BuiltInStepId, executor);
		}
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
		const totalSteps = StandardPipelinePlugin.STEPS.length;
		const allRegistered = registeredSteps === totalSteps;

		const missingSteps = StandardPipelinePlugin.STEPS.filter((s) => !this.stepExecutors.has(s.id)).map((s) => s.id);

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
			description: 'Standard 15-step generation pipeline with AI, search, extraction, and categorization',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			systemPlugin: true,
			autoEnable: true,
			visibility: 'public',
			defaultForCapabilities: ['pipeline'],
			selectableProviderCategories: ['ai-provider', 'search', 'screenshot', 'content-extractor'],
			readme: [
				'## What is the Standard Pipeline?',
				'',
				'The default engine-orchestrated generation pipeline. It runs 15 sequential steps that combine AI generation, web search, content extraction, and post-processing to build a complete directory from a single prompt.',
				'',
				'## How it works',
				'',
				'The pipeline is organized into 6 phases:',
				'',
				'1. **Initialization** — Compares the prompt against previous runs, extracts the subject, and detects the domain type',
				'2. **AI Generation** — Generates an initial set of items using AI based on the prompt and domain analysis',
				'3. **Web Search** — Builds search queries, executes web searches, retrieves page content, and filters for relevance',
				'4. **Extraction** — Extracts structured items from web content and aggregates them with AI-generated items',
				'5. **Enrichment** — Assigns categories, validates sources, generates badges, and captures screenshots',
				'6. **Output** — Generates markdown descriptions for each item',
				'',
				'## Features',
				'',
				'- **Checkpoint resume** — progress is saved after each step and can be resumed on failure',
				'- **Step-level progress** — reports current step name, index, and percentage to the UI in real time',
				'- **Extensible** — pipeline-modifier plugins can inject, replace, or disable individual steps',
				'- **Provider-agnostic** — works with any AI, search, screenshot, or content-extractor plugin'
			].join('\n'),
			icon: {
				type: 'svg',
				value: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-9 4 18 3-9h4"/></svg>'
			}
		};
	}
}

export default StandardPipelinePlugin;
