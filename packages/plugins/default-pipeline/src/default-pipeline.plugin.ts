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
	IBuiltInStepExecutor,
	StepExecutionContext,
	FormFieldDefinition,
	FormFieldGroup,
	IDefaultPipelinePlugin
} from '@ever-works/plugin';

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
 * Default Pipeline Plugin - System plugin providing the standard generation pipeline.
 *
 * This plugin is the single source of truth for all built-in pipeline steps.
 * The pipeline engine queries this plugin for step definitions.
 */
export class DefaultPipelinePlugin implements IPlugin, IDefaultPipelinePlugin<BuiltInStepId> {
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
			provides: ['extractedUrls'],
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
			provides: ['webPages'],
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
			provides: ['finalItems'],
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
			provides: ['finalItems'],
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
			provides: ['finalItems'],
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
			provides: ['finalItems'],
			requires: ['finalItems', 'contentCache'],
			optional: true,
			parallelizable: true,
			estimatedDuration: 45
		}
	];

	private static readonly STEPS_MAP: Map<BuiltInStepId, PipelineStepDefinition<BuiltInStepId>> = new Map(
		DefaultPipelinePlugin.STEPS.map((step) => [step.id, step])
	);

	// Static accessors
	static isBuiltInStep(stepId: string): stepId is BuiltInStepId {
		return DefaultPipelinePlugin.STEPS_MAP.has(stepId as BuiltInStepId);
	}

	static getBuiltInStep(stepId: BuiltInStepId): PipelineStepDefinition<BuiltInStepId> | undefined {
		return DefaultPipelinePlugin.STEPS_MAP.get(stepId);
	}

	static getBuiltInStepIds(): BuiltInStepId[] {
		return DefaultPipelinePlugin.STEPS.map((step) => step.id);
	}

	static getBuiltInSteps(): PipelineStepDefinition<BuiltInStepId>[] {
		return [...DefaultPipelinePlugin.STEPS];
	}

	// IPlugin properties
	readonly id = 'default-pipeline';
	readonly name = 'Default Pipeline';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'pipeline';
	readonly capabilities: readonly string[] = ['pipeline-step', 'form-schema-provider'];
	readonly settingsSchema: JsonSchema = { type: 'object', properties: {} };
	readonly handledConfigFields = ['*'] as const;
	readonly systemPlugin = true as const;

	private stepExecutors = new Map<BuiltInStepId, IBuiltInStepExecutor>();
	private context?: PluginContext;

	// IDefaultPipelinePlugin methods
	registerStepExecutor(stepId: BuiltInStepId, executor: IBuiltInStepExecutor): void {
		this.stepExecutors.set(stepId, executor);
		this.context?.logger.debug(`Registered executor for step: ${stepId}`);
	}

	registerStepExecutors(executors: Map<BuiltInStepId, IBuiltInStepExecutor>): void {
		for (const [stepId, executor] of executors) {
			this.registerStepExecutor(stepId, executor);
		}
	}

	hasExecutor(stepId: BuiltInStepId): boolean {
		return this.stepExecutors.has(stepId);
	}

	isValidStepId(stepId: string): stepId is BuiltInStepId {
		return DefaultPipelinePlugin.isBuiltInStep(stepId);
	}

	getStepIds(): readonly BuiltInStepId[] {
		return DefaultPipelinePlugin.getBuiltInStepIds();
	}

	getStepDefinition(stepId?: BuiltInStepId | string): PipelineStepDefinition<BuiltInStepId> | undefined {
		if (stepId) {
			return DefaultPipelinePlugin.STEPS_MAP.get(stepId as BuiltInStepId);
		}
		return DefaultPipelinePlugin.STEPS[0];
	}

	getStepDefinitions(): PipelineStepDefinition<BuiltInStepId>[] {
		return [...DefaultPipelinePlugin.STEPS];
	}

	async execute(
		context: MutableGenerationContext,
		options?: StepExecutionOptions,
		onProgress?: StepProgressCallback
	): Promise<MutableGenerationContext> {
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

	async executeStep(
		stepId: BuiltInStepId | string,
		context: MutableGenerationContext,
		execContext: StepExecutionContext,
		options?: StepExecutionOptions,
		onProgress?: StepProgressCallback
	): Promise<MutableGenerationContext> {
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

	async canSkip(context: MutableGenerationContext): Promise<boolean> {
		return context.shouldStop === true;
	}

	async validate(context: MutableGenerationContext): Promise<{ valid: boolean; error?: string }> {
		if (context.shouldStop) {
			return { valid: false, error: 'Pipeline stopped' };
		}
		return { valid: true };
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
			{ name: 'sources', title: 'Data Sources', description: 'Configure where to find items', order: 1 },
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
		context.logger.log('Default Pipeline Plugin loading...');
		this.registerBuiltInStepExecutors();
		context.logger.log(`Default Pipeline Plugin loaded with ${this.stepExecutors.size} step executors`);
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

	async onEnable(_context: PluginContext): Promise<void> {
		this.context?.logger.log('Default Pipeline Plugin enabled');
	}

	async onDisable(_context: PluginContext): Promise<void> {
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
			autoInstall: true,
			visibility: 'hidden'
		};
	}
}

export default DefaultPipelinePlugin;
