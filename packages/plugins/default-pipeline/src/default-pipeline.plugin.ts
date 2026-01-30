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
	IBuiltInStepExecutor,
	StepExecutionContext,
	FormFieldDefinition,
	FormFieldGroup,
	IFormSchemaProvider
} from '@ever-works/plugin';

// Import BuiltInStepId from local types - this plugin is the source of truth
import type { BuiltInStepId } from './types.js';

// Import all step implementations
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

 */
export class DefaultPipelinePlugin implements IPlugin, IPipelineStepPlugin, IFormSchemaProvider {
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
	readonly capabilities: readonly string[] = ['pipeline-step', 'form-schema-provider'];
	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {}
	};

	/**
	 * This plugin handles ALL config fields (it's the standard pipeline)
	 */
	readonly handledConfigFields = ['*'] as const;

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
	 * Get a specific step definition by ID.
	 *
	 * @param stepId - Optional step ID. If not provided, returns the first step.
	 * @returns The step definition or undefined if not found.
	 */
	getStepDefinition(stepId?: string): PipelineStepDefinition | undefined {
		if (stepId) {
			return DefaultPipelinePlugin.STEPS_MAP.get(stepId as BuiltInStepId);
		}
		// Backward compatibility: return first step if no ID provided
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
	 *
	 * Note: The stepId and execContext should be passed through options.settings
	 * This method is part of IPipelineStepPlugin interface.
	 */
	async execute(
		context: MutableGenerationContext,
		options?: StepExecutionOptions,
		onProgress?: StepProgressCallback
	): Promise<MutableGenerationContext> {
		// This method is called when the pipeline executes a specific step
		// The stepId and execContext should be passed through options.settings
		const stepId = options?.settings?.stepId as string;
		const execContext = options?.settings?.execContext as StepExecutionContext;

		if (!stepId) {
			throw new Error('DefaultPipelinePlugin.execute() requires stepId in options.settings');
		}

		if (!execContext) {
			throw new Error('DefaultPipelinePlugin.execute() requires execContext in options.settings');
		}

		return this.executeStep(stepId, context, execContext, options, onProgress);
	}

	/**
	 * Execute a specific step by ID
	 */
	async executeStep(
		stepId: string,
		context: MutableGenerationContext,
		execContext: StepExecutionContext,
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
			const result = await executor.run(context, execContext);

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
	// IFormSchemaProvider interface
	// ============================================================================

	/**
	 * Get form fields for the generator form.
	 * These fields replace the hardcoded ConfigDto fields in the frontend.
	 */
	getFormFields(): FormFieldDefinition[] {
		return [
			// === DATA SOURCES ===
			{
				name: 'source_urls',
				type: 'tags',
				label: 'Source URLs',
				description: 'URLs to extract items from directly (bypasses search)',
				placeholder: 'https://example.com/products',
				group: 'sources'
			},

			// === CATEGORY HINTS ===
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

			// === FEATURE TOGGLES ===
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

			// === SEARCH CONFIGURATION ===
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

			// === VOLUME CONTROL ===
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

			// === ADVANCED SETTINGS ===
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

	/**
	 * Get form field groups for UI organization
	 */
	getFormGroups(): FormFieldGroup[] {
		return [
			{
				name: 'sources',
				title: 'Data Sources',
				description: 'Configure where to find items',
				order: 1
			},
			{
				name: 'categories',
				title: 'Categories & Keywords',
				description: 'Guide the categorization and search',
				order: 2,
				collapsible: true
			},
			{
				name: 'features',
				title: 'Generation Features',
				description: 'Enable or disable generation features',
				order: 3,
				collapsible: true
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

	/**
	 * Validate form input values for the generator form
	 */
	validateFormInput(values: Record<string, unknown>): ValidationResult {
		const errors: Array<{ path: string; message: string }> = [];

		// Validate numeric ranges
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
					errors.push({
						path: field.name,
						message: `${field.name} must be a number`
					});
				} else if (num < field.min || num > field.max) {
					errors.push({
						path: field.name,
						message: `${field.name} must be between ${field.min} and ${field.max}`
					});
				}
			}
		}

		// Validate URL arrays
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
							errors.push({
								path: `${fieldName}[${i}]`,
								message: `Invalid URL: ${url}`
							});
						}
					}
				}
			}
		}

		// Validate data_volume_mode
		const volumeMode = values.data_volume_mode;
		if (volumeMode !== undefined && !['real', 'sample'].includes(volumeMode as string)) {
			errors.push({
				path: 'data_volume_mode',
				message: 'data_volume_mode must be "real" or "sample"'
			});
		}

		return {
			valid: errors.length === 0,
			errors: errors.length > 0 ? errors : undefined
		};
	}

	/**
	 * Get default values for all form fields
	 */
	getDefaultValues(): Record<string, unknown> {
		const defaults: Record<string, unknown> = {};
		for (const field of this.getFormFields()) {
			if (field.defaultValue !== undefined) {
				defaults[field.name] = field.defaultValue;
			}
		}
		return defaults;
	}

	/**
	 * Transform form values before sending to the backend.
	 * Handles case normalization and type conversion.
	 */
	transformFormValues(values: Record<string, unknown>): Record<string, unknown> {
		const transformed = { ...values };

		// Normalize data_volume_mode to uppercase for backend compatibility
		if (transformed.data_volume_mode) {
			transformed.data_volume_mode = (transformed.data_volume_mode as string).toUpperCase();
		}

		// Filter out empty arrays
		for (const key of Object.keys(transformed)) {
			if (Array.isArray(transformed[key]) && (transformed[key] as unknown[]).length === 0) {
				delete transformed[key];
			}
		}

		return transformed;
	}

	// ============================================================================
	// IPlugin lifecycle interface
	// ============================================================================

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Default Pipeline Plugin loading...');

		// Register all built-in step executors
		this.registerBuiltInStepExecutors();

		context.logger.log(`Default Pipeline Plugin loaded with ${this.stepExecutors.size} step executors`);
	}

	/**
	 * Register all built-in step executors.
	 * This method is called during plugin load to set up all step implementations.
	 */
	private registerBuiltInStepExecutors(): void {
		// Map of step IDs to their executor instances
		const stepExecutors: Record<string, IBuiltInStepExecutor> = {
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

		// Register each step executor
		for (const [stepId, executor] of Object.entries(stepExecutors)) {
			this.registerStepExecutor(stepId as BuiltInStepId, executor);
		}
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
			description: 'System plugin providing the default generation pipeline with 15 built-in steps',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			systemPlugin: true,
			autoInstall: true
		};
	}
}

export default DefaultPipelinePlugin;
