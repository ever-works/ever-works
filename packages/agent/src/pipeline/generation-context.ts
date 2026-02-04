import type {
    MutableGenerationContext,
    GenerationContextSnapshot,
    StepDataKey,
    StepDataTypes,
    DirectoryReference,
    GenerationRequest,
    ExistingItems,
    PipelineMetrics,
    StepMetrics,
} from '@ever-works/plugin';

/**
 * Extended generation context with type-safe step result management.
 * This class wraps the standard MutableGenerationContext and provides
 * additional methods for type-safe storage and retrieval of step results.
 */
export class TypedGenerationContext implements MutableGenerationContext {
    // Required MutableGenerationContext properties
    directory: DirectoryReference;
    request: GenerationRequest;
    existing: ExistingItems;

    // State properties
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
    finalBrands: MutableGenerationContext['finalBrands'] = [];

    domainAnalysis?: MutableGenerationContext['domainAnalysis'];
    metrics: PipelineMetrics;

    allInitialCategories: string[] = [];
    allPriorityCategories: string[] = [];
    featuredItemHints: string[] = [];
    subject?: string;

    advancedPrompts?: MutableGenerationContext['advancedPrompts'];
    shouldStop?: boolean;

    /**
     * Internal storage for step results that don't map directly to context properties
     */
    private stepResults = new Map<string, unknown>();

    /**
     * Track which steps have provided their data
     */
    private providedBy = new Map<string, string>();

    constructor(
        directory: DirectoryReference,
        request: GenerationRequest,
        existing: ExistingItems,
    ) {
        this.directory = directory;
        this.request = request;
        this.existing = existing;
        this.metrics = this.createInitialMetrics();
    }

    /**
     * Create initial metrics object
     */
    private createInitialMetrics(): PipelineMetrics {
        return {
            startTime: Date.now(),
            itemsProcessed: 0,
            urlsExtracted: 0,
            pagesRetrieved: 0,
            itemsExtracted: 0,
            itemsAfterDedup: 0,
            steps: {},
        };
    }

    /**
     * Get a step result with type safety
     * @param key - The step data key to retrieve
     * @returns The value if present, undefined otherwise
     */
    getStepResult<K extends StepDataKey>(key: K): StepDataTypes[K] | undefined {
        // First check if the key maps to a direct property
        const directValue = this.getDirectProperty(key);
        if (directValue !== undefined) {
            return directValue as StepDataTypes[K];
        }

        // Otherwise check custom step results
        return this.stepResults.get(key) as StepDataTypes[K] | undefined;
    }

    /**
     * Set a step result with type safety
     * @param key - The step data key to set
     * @param value - The value to store
     * @param stepId - Optional ID of the step that provided this data
     */
    setStepResult<K extends StepDataKey>(key: K, value: StepDataTypes[K], stepId?: string): void {
        // Map certain keys to direct properties
        if (this.setDirectProperty(key, value)) {
            if (stepId) {
                this.providedBy.set(key, stepId);
            }
            return;
        }

        // Store in step results map
        this.stepResults.set(key, value);
        if (stepId) {
            this.providedBy.set(key, stepId);
        }
    }

    /**
     * Check if a step result exists
     * @param key - The step data key to check
     */
    hasStepResult(key: StepDataKey): boolean {
        const directValue = this.getDirectProperty(key);
        if (directValue !== undefined) {
            return true;
        }
        return this.stepResults.has(key);
    }

    /**
     * Get the step that provided a specific data key
     * @param key - The step data key
     * @returns The step ID that provided this data, or undefined
     */
    getProvidedBy(key: StepDataKey): string | undefined {
        return this.providedBy.get(key);
    }

    /**
     * Get all available step data keys
     */
    getAvailableKeys(): StepDataKey[] {
        const keys: StepDataKey[] = [];

        // Add direct properties that have values
        const directKeys: StepDataKey[] = [
            'extractedUrls',
            'searchQueries',
            'webPages',
            'processedSourceUrls',
            'contentCache',
            'initialAiItems',
            'extractedWebItems',
            'aggregatedItems',
            'finalItems',
            'finalCategories',
            'finalTags',
            'finalBrands',
            'domainAnalysis',
            'metrics',
            'allInitialCategories',
            'allPriorityCategories',
            'featuredItemHints',
            'subject',
            'shouldStop',
        ];

        for (const key of directKeys) {
            if (this.hasStepResult(key)) {
                keys.push(key);
            }
        }

        // Add custom step results
        for (const key of this.stepResults.keys()) {
            if (!keys.includes(key as StepDataKey)) {
                keys.push(key as StepDataKey);
            }
        }

        return keys;
    }

    /**
     * Get a direct property value by key
     */
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
            case 'finalBrands':
                return this.finalBrands.length > 0 ? this.finalBrands : undefined;
            case 'domainAnalysis':
                return this.domainAnalysis;
            case 'metrics':
                return this.metrics;
            case 'allInitialCategories':
                return this.allInitialCategories.length > 0 ? this.allInitialCategories : undefined;
            case 'allPriorityCategories':
                return this.allPriorityCategories.length > 0
                    ? this.allPriorityCategories
                    : undefined;
            case 'featuredItemHints':
                return this.featuredItemHints.length > 0 ? this.featuredItemHints : undefined;
            case 'subject':
                return this.subject;
            case 'shouldStop':
                return this.shouldStop;
            default:
                return undefined;
        }
    }

    /**
     * Set a direct property value by key
     * @returns true if the property was set directly, false if it should use the map
     */
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
            case 'finalBrands':
                this.finalBrands = value as MutableGenerationContext['finalBrands'];
                return true;
            case 'domainAnalysis':
                this.domainAnalysis = value as MutableGenerationContext['domainAnalysis'];
                return true;
            case 'metrics':
                this.metrics = value as PipelineMetrics;
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
            default:
                return false;
        }
    }

    /**
     * Record step metrics
     */
    recordStepMetrics(stepId: string, metrics: StepMetrics): void {
        (this.metrics as { steps: Record<string, StepMetrics> }).steps[stepId] = metrics;
    }

    /**
     * Update aggregate metrics
     */
    updateMetrics(updates: Partial<Omit<PipelineMetrics, 'startTime' | 'steps'>>): void {
        const mutableMetrics = this.metrics as {
            duration?: number;
            itemsProcessed: number;
            urlsExtracted: number;
            pagesRetrieved: number;
            itemsExtracted: number;
            itemsAfterDedup: number;
        };

        if (updates.duration !== undefined) mutableMetrics.duration = updates.duration;
        if (updates.itemsProcessed !== undefined)
            mutableMetrics.itemsProcessed = updates.itemsProcessed;
        if (updates.urlsExtracted !== undefined)
            mutableMetrics.urlsExtracted = updates.urlsExtracted;
        if (updates.pagesRetrieved !== undefined)
            mutableMetrics.pagesRetrieved = updates.pagesRetrieved;
        if (updates.itemsExtracted !== undefined)
            mutableMetrics.itemsExtracted = updates.itemsExtracted;
        if (updates.itemsAfterDedup !== undefined)
            mutableMetrics.itemsAfterDedup = updates.itemsAfterDedup;
    }

    /**
     * Create a read-only snapshot of the context
     */
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
            finalBrands: [...this.finalBrands],
            domainAnalysis: this.domainAnalysis,
            metrics: this.metrics,
            allInitialCategories: [...this.allInitialCategories],
            allPriorityCategories: [...this.allPriorityCategories],
            featuredItemHints: [...this.featuredItemHints],
            subject: this.subject,
            advancedPrompts: this.advancedPrompts,
            shouldStop: this.shouldStop,
        };
    }

    /**
     * Clear the content cache to free memory
     */
    clearContentCache(): void {
        this.contentCache.clear();
    }

    /**
     * Create a TypedGenerationContext from a MutableGenerationContext
     */
    static fromMutableContext(ctx: MutableGenerationContext): TypedGenerationContext {
        const typed = new TypedGenerationContext(ctx.directory, ctx.request, ctx.existing);

        // Copy all properties
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
        typed.finalBrands = ctx.finalBrands;
        typed.domainAnalysis = ctx.domainAnalysis;
        typed.metrics = ctx.metrics;
        typed.allInitialCategories = ctx.allInitialCategories;
        typed.allPriorityCategories = ctx.allPriorityCategories;
        typed.featuredItemHints = ctx.featuredItemHints;
        typed.subject = ctx.subject;
        typed.advancedPrompts = ctx.advancedPrompts;
        typed.shouldStop = ctx.shouldStop;

        return typed;
    }

    /**
     * Create a TypedGenerationContext from a GenerationContextSnapshot
     */
    static fromSnapshot(snapshot: GenerationContextSnapshot): TypedGenerationContext {
        const typed = new TypedGenerationContext(
            snapshot.directory,
            snapshot.request,
            snapshot.existing,
        );

        typed.extractedUrls = [...snapshot.extractedUrls];
        typed.searchQueries = [...snapshot.searchQueries];
        typed.webPages = [...snapshot.webPages];
        typed.processedSourceUrls = new Set(snapshot.processedSourceUrls);
        typed.contentCache = new Map(snapshot.contentCache);
        typed.initialAiItems = [
            ...snapshot.initialAiItems,
        ] as MutableGenerationContext['initialAiItems'];
        typed.extractedWebItems = [
            ...snapshot.extractedWebItems,
        ] as MutableGenerationContext['extractedWebItems'];
        typed.aggregatedItems = [
            ...snapshot.aggregatedItems,
        ] as MutableGenerationContext['aggregatedItems'];
        typed.finalItems = [...snapshot.finalItems] as MutableGenerationContext['finalItems'];
        typed.finalCategories = [...snapshot.finalCategories];
        typed.finalTags = [...snapshot.finalTags];
        typed.finalBrands = [...snapshot.finalBrands];
        typed.domainAnalysis = snapshot.domainAnalysis;
        typed.allInitialCategories = [...snapshot.allInitialCategories];
        typed.allPriorityCategories = [...snapshot.allPriorityCategories];
        typed.featuredItemHints = [...snapshot.featuredItemHints];
        typed.subject = snapshot.subject;
        typed.advancedPrompts = snapshot.advancedPrompts;
        typed.shouldStop = snapshot.shouldStop;

        return typed;
    }
}

/**
 * Factory function to create a new generation context
 */
export function createGenerationContext(
    directory: DirectoryReference,
    request: GenerationRequest,
    existing: ExistingItems,
): TypedGenerationContext {
    return new TypedGenerationContext(directory, request, existing);
}
