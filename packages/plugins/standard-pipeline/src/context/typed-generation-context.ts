import type { DirectoryReference, GenerationRequest, ExistingItems, StepMetrics } from '@ever-works/plugin';
import type { MutableGenerationContext, GenerationContextSnapshot } from './mutable-generation-context.js';
import type { StepDataKey, StepDataTypes, StandardPipelineMetrics } from './step-data-types.js';

export class TypedGenerationContext implements MutableGenerationContext {
	directory: DirectoryReference;
	request: GenerationRequest;
	existing: ExistingItems;

	extractedUrls: string[] = [];
	searchQueries: string[] = [];
	webPages: MutableGenerationContext['webPages'] = [];
	processedSourceUrls: Set<string> = new Set();
	contentCache: Map<string, string> = new Map();

	initialAiItems: MutableGenerationContext['initialAiItems'] = [];
	extractedWebItems: MutableGenerationContext['extractedWebItems'] = [];
	aggregatedItems: MutableGenerationContext['aggregatedItems'] = [];
	finalItems: MutableGenerationContext['finalItems'] = [];
	finalCategories: MutableGenerationContext['finalCategories'] = [];
	finalTags: MutableGenerationContext['finalTags'] = [];
	finalCollections: MutableGenerationContext['finalCollections'] = [];
	finalBrands: MutableGenerationContext['finalBrands'] = [];

	domainAnalysis?: MutableGenerationContext['domainAnalysis'];
	metrics: StandardPipelineMetrics;

	allInitialCategories: string[] = [];
	allPriorityCategories: string[] = [];
	featuredItemHints: string[] = [];
	subject?: string;

	advancedPrompts?: MutableGenerationContext['advancedPrompts'];
	shouldStop?: boolean;
	warnings: string[] = [];
	pluginConfig?: Record<string, Record<string, unknown>>;

	constructor(directory: DirectoryReference, request: GenerationRequest, existing: ExistingItems) {
		this.directory = directory;
		this.request = request;
		this.existing = existing;
		this.pluginConfig = request.pluginConfig;
		this.metrics = this.createInitialMetrics();
	}

	private createInitialMetrics(): StandardPipelineMetrics {
		return {
			startTime: Date.now(),
			itemsProcessed: 0,
			urlsExtracted: 0,
			pagesRetrieved: 0,
			itemsExtracted: 0,
			itemsAfterDedup: 0,
			steps: {}
		};
	}

	getStepResult<K extends StepDataKey>(key: K): StepDataTypes[K] | undefined {
		return this.getDirectProperty(key) as StepDataTypes[K] | undefined;
	}

	setStepResult<K extends StepDataKey>(key: K, value: StepDataTypes[K]): void {
		this.setDirectProperty(key, value);
	}

	hasStepResult(key: StepDataKey): boolean {
		return this.getDirectProperty(key) !== undefined;
	}

	private getDirectProperty(key: StepDataKey): unknown {
		switch (key) {
			case 'extractedUrls':
				return this.extractedUrls.length > 0 ? this.extractedUrls : undefined;
			case 'searchQueries':
				return this.searchQueries.length > 0 ? this.searchQueries : undefined;
			case 'webPages':
				return this.webPages.length > 0 ? this.webPages : undefined;
			case 'processedSourceUrls':
				return this.processedSourceUrls.size > 0 ? this.processedSourceUrls : undefined;
			case 'contentCache':
				return this.contentCache.size > 0 ? this.contentCache : undefined;
			case 'initialAiItems':
				return this.initialAiItems.length > 0 ? this.initialAiItems : undefined;
			case 'extractedWebItems':
				return this.extractedWebItems.length > 0 ? this.extractedWebItems : undefined;
			case 'aggregatedItems':
				return this.aggregatedItems.length > 0 ? this.aggregatedItems : undefined;
			case 'finalItems':
				return this.finalItems.length > 0 ? this.finalItems : undefined;
			case 'finalCategories':
				return this.finalCategories.length > 0 ? this.finalCategories : undefined;
			case 'finalTags':
				return this.finalTags.length > 0 ? this.finalTags : undefined;
			case 'finalCollections':
				return this.finalCollections.length > 0 ? this.finalCollections : undefined;
			case 'finalBrands':
				return this.finalBrands.length > 0 ? this.finalBrands : undefined;
			case 'domainAnalysis':
				return this.domainAnalysis;
			case 'metrics':
				return this.metrics;
			case 'allInitialCategories':
				return this.allInitialCategories.length > 0 ? this.allInitialCategories : undefined;
			case 'allPriorityCategories':
				return this.allPriorityCategories.length > 0 ? this.allPriorityCategories : undefined;
			case 'featuredItemHints':
				return this.featuredItemHints.length > 0 ? this.featuredItemHints : undefined;
			case 'subject':
				return this.subject;
			case 'shouldStop':
				return this.shouldStop;
			case 'warnings':
				return this.warnings.length > 0 ? this.warnings : undefined;
			default:
				return undefined;
		}
	}

	private setDirectProperty(key: StepDataKey, value: unknown): boolean {
		switch (key) {
			case 'extractedUrls':
				this.extractedUrls = value as string[];
				return true;
			case 'searchQueries':
				this.searchQueries = value as string[];
				return true;
			case 'webPages':
				this.webPages = value as MutableGenerationContext['webPages'];
				return true;
			case 'processedSourceUrls':
				this.processedSourceUrls = value as Set<string>;
				return true;
			case 'contentCache':
				this.contentCache = value as Map<string, string>;
				return true;
			case 'initialAiItems':
				this.initialAiItems = value as MutableGenerationContext['initialAiItems'];
				return true;
			case 'extractedWebItems':
				this.extractedWebItems = value as MutableGenerationContext['extractedWebItems'];
				return true;
			case 'aggregatedItems':
				this.aggregatedItems = value as MutableGenerationContext['aggregatedItems'];
				return true;
			case 'finalItems':
				this.finalItems = value as MutableGenerationContext['finalItems'];
				return true;
			case 'finalCategories':
				this.finalCategories = value as MutableGenerationContext['finalCategories'];
				return true;
			case 'finalTags':
				this.finalTags = value as MutableGenerationContext['finalTags'];
				return true;
			case 'finalCollections':
				this.finalCollections = value as MutableGenerationContext['finalCollections'];
				return true;
			case 'finalBrands':
				this.finalBrands = value as MutableGenerationContext['finalBrands'];
				return true;
			case 'domainAnalysis':
				this.domainAnalysis = value as MutableGenerationContext['domainAnalysis'];
				return true;
			case 'metrics':
				this.metrics = value as StandardPipelineMetrics;
				return true;
			case 'allInitialCategories':
				this.allInitialCategories = value as string[];
				return true;
			case 'allPriorityCategories':
				this.allPriorityCategories = value as string[];
				return true;
			case 'featuredItemHints':
				this.featuredItemHints = value as string[];
				return true;
			case 'subject':
				this.subject = value as string | undefined;
				return true;
			case 'shouldStop':
				this.shouldStop = value as boolean | undefined;
				return true;
			case 'warnings':
				this.warnings = value as string[];
				return true;
			default:
				return false;
		}
	}

	recordStepMetrics(stepId: string, metrics: StepMetrics): void {
		(this.metrics as { steps: Record<string, StepMetrics> }).steps[stepId] = metrics;
	}

	updateMetrics(updates: Partial<Omit<StandardPipelineMetrics, 'startTime' | 'steps'>>): void {
		const m = this.metrics as {
			duration?: number;
			itemsProcessed: number;
			urlsExtracted: number;
			pagesRetrieved: number;
			itemsExtracted: number;
			itemsAfterDedup: number;
		};
		if (updates.duration !== undefined) m.duration = updates.duration;
		if (updates.itemsProcessed !== undefined) m.itemsProcessed = updates.itemsProcessed;
		if (updates.urlsExtracted !== undefined) m.urlsExtracted = updates.urlsExtracted;
		if (updates.pagesRetrieved !== undefined) m.pagesRetrieved = updates.pagesRetrieved;
		if (updates.itemsExtracted !== undefined) m.itemsExtracted = updates.itemsExtracted;
		if (updates.itemsAfterDedup !== undefined) m.itemsAfterDedup = updates.itemsAfterDedup;
	}

	toSnapshot(): GenerationContextSnapshot {
		return {
			directory: this.directory,
			request: this.request,
			existing: this.existing,
			extractedUrls: [...this.extractedUrls],
			searchQueries: [...this.searchQueries],
			webPages: [...this.webPages],
			processedSourceUrls: this.processedSourceUrls,
			contentCache: this.contentCache,
			initialAiItems: [...this.initialAiItems],
			extractedWebItems: [...this.extractedWebItems],
			aggregatedItems: [...this.aggregatedItems],
			finalItems: [...this.finalItems],
			finalCategories: [...this.finalCategories],
			finalTags: [...this.finalTags],
			finalCollections: [...this.finalCollections],
			finalBrands: [...this.finalBrands],
			domainAnalysis: this.domainAnalysis,
			metrics: this.metrics,
			allInitialCategories: [...this.allInitialCategories],
			allPriorityCategories: [...this.allPriorityCategories],
			featuredItemHints: [...this.featuredItemHints],
			subject: this.subject,
			advancedPrompts: this.advancedPrompts,
			shouldStop: this.shouldStop,
			warnings: [...this.warnings],
			pluginConfig: this.pluginConfig
		};
	}

	clearContentCache(): void {
		this.contentCache.clear();
	}

	static fromMutableContext(ctx: MutableGenerationContext): TypedGenerationContext {
		const typed = new TypedGenerationContext(ctx.directory, ctx.request, ctx.existing);
		typed.extractedUrls = ctx.extractedUrls;
		typed.searchQueries = ctx.searchQueries;
		typed.webPages = ctx.webPages;
		typed.processedSourceUrls = ctx.processedSourceUrls;
		typed.contentCache = ctx.contentCache;
		typed.initialAiItems = ctx.initialAiItems;
		typed.extractedWebItems = ctx.extractedWebItems;
		typed.aggregatedItems = ctx.aggregatedItems;
		typed.finalItems = ctx.finalItems;
		typed.finalCategories = ctx.finalCategories;
		typed.finalTags = ctx.finalTags;
		typed.finalCollections = ctx.finalCollections;
		typed.finalBrands = ctx.finalBrands;
		typed.domainAnalysis = ctx.domainAnalysis;
		typed.metrics = ctx.metrics;
		typed.allInitialCategories = ctx.allInitialCategories;
		typed.allPriorityCategories = ctx.allPriorityCategories;
		typed.featuredItemHints = ctx.featuredItemHints;
		typed.subject = ctx.subject;
		typed.advancedPrompts = ctx.advancedPrompts;
		typed.shouldStop = ctx.shouldStop;
		typed.warnings = [...ctx.warnings];
		typed.pluginConfig = ctx.pluginConfig;
		return typed;
	}

	static fromSnapshot(snapshot: GenerationContextSnapshot): TypedGenerationContext {
		const typed = new TypedGenerationContext(snapshot.directory, snapshot.request, snapshot.existing);
		typed.extractedUrls = [...snapshot.extractedUrls];
		typed.searchQueries = [...snapshot.searchQueries];
		typed.webPages = [...snapshot.webPages];
		typed.processedSourceUrls = new Set(snapshot.processedSourceUrls);
		typed.contentCache = new Map(snapshot.contentCache);
		typed.initialAiItems = [...snapshot.initialAiItems] as MutableGenerationContext['initialAiItems'];
		typed.extractedWebItems = [...snapshot.extractedWebItems] as MutableGenerationContext['extractedWebItems'];
		typed.aggregatedItems = [...snapshot.aggregatedItems] as MutableGenerationContext['aggregatedItems'];
		typed.finalItems = [...snapshot.finalItems] as MutableGenerationContext['finalItems'];
		typed.finalCategories = [...snapshot.finalCategories];
		typed.finalTags = [...snapshot.finalTags];
		typed.finalCollections = [...(snapshot.finalCollections || [])];
		typed.finalBrands = [...snapshot.finalBrands];
		typed.domainAnalysis = snapshot.domainAnalysis;
		typed.allInitialCategories = [...snapshot.allInitialCategories];
		typed.allPriorityCategories = [...snapshot.allPriorityCategories];
		typed.featuredItemHints = [...snapshot.featuredItemHints];
		typed.subject = snapshot.subject;
		typed.advancedPrompts = snapshot.advancedPrompts;
		typed.shouldStop = snapshot.shouldStop;
		typed.warnings = [...snapshot.warnings];
		typed.pluginConfig = snapshot.pluginConfig;
		return typed;
	}
}
