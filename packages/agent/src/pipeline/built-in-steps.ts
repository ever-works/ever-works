import type { BuiltInStepId, PipelineStepDefinition } from '@ever-works/plugin';

/**
 * Built-in pipeline step definitions with explicit dependencies.
 * These define the standard generation pipeline for directory item generation.
 *
 * The steps are organized by their data flow dependencies:
 * - Early steps (prompt-comparison, prompt-processing, domain-detection) set up context
 * - Middle steps (search, retrieval, extraction) gather and process data
 * - Late steps (aggregation, categorization, validation) finalize the output
 */
export const BUILT_IN_STEPS: PipelineStepDefinition[] = [
    // ============================================================================
    // Phase 1: Initialization and Analysis
    // ============================================================================

    {
        id: 'prompt-comparison' as BuiltInStepId,
        name: 'Prompt Comparison',
        description:
            'Compares current prompt with previous generation to determine if regeneration is needed',
        position: { type: 'first' },
        dependencies: [],
        provides: ['shouldStop'],
        requires: [],
        optional: false,
        parallelizable: false,
        estimatedDuration: 2,
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
        estimatedDuration: 5,
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
        estimatedDuration: 8,
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
            { stepId: 'domain-detection', required: true },
        ],
        provides: ['initialAiItems', 'allInitialCategories', 'allPriorityCategories'],
        requires: ['subject', 'domainAnalysis'],
        optional: false,
        parallelizable: false,
        estimatedDuration: 30,
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
            { stepId: 'ai-first-items-generation', required: false },
        ],
        provides: ['searchQueries'],
        requires: ['subject', 'domainAnalysis'],
        optional: false,
        parallelizable: false,
        estimatedDuration: 10,
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
        estimatedDuration: 15,
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
        estimatedDuration: 45,
    },

    {
        id: 'content-filtering' as BuiltInStepId,
        name: 'Content Filtering',
        description: 'Filters retrieved content for relevance',
        position: { type: 'after', stepId: 'content-retrieval' },
        dependencies: [
            { stepId: 'content-retrieval', required: true },
            { stepId: 'domain-detection', required: true },
        ],
        provides: ['webPages'],
        requires: ['webPages', 'domainAnalysis'],
        optional: false,
        parallelizable: false,
        estimatedDuration: 10,
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
            { stepId: 'domain-detection', required: true },
        ],
        provides: ['extractedWebItems'],
        requires: ['webPages', 'domainAnalysis'],
        optional: false,
        parallelizable: true,
        estimatedDuration: 60,
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
            { stepId: 'items-extraction', required: false },
        ],
        provides: ['aggregatedItems'],
        requires: [],
        optional: false,
        parallelizable: false,
        estimatedDuration: 20,
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
            { stepId: 'domain-detection', required: true },
        ],
        provides: ['finalItems', 'finalCategories', 'finalTags', 'finalBrands'],
        requires: ['aggregatedItems', 'domainAnalysis'],
        optional: false,
        parallelizable: false,
        estimatedDuration: 25,
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
        estimatedDuration: 15,
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
        estimatedDuration: 10,
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
        estimatedDuration: 30,
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
            { stepId: 'badges-processing', required: false },
        ],
        provides: ['finalItems'],
        requires: ['finalItems', 'contentCache'],
        optional: true,
        parallelizable: true,
        estimatedDuration: 45,
    },
];

/**
 * Map of step ID to step definition for quick lookup
 */
export const BUILT_IN_STEPS_MAP: Map<BuiltInStepId, PipelineStepDefinition> = new Map(
    BUILT_IN_STEPS.map((step) => [step.id as BuiltInStepId, step]),
);

/**
 * Get a built-in step definition by ID
 */
export function getBuiltInStep(stepId: BuiltInStepId): PipelineStepDefinition | undefined {
    return BUILT_IN_STEPS_MAP.get(stepId);
}

/**
 * Check if a step ID is a built-in step
 */
export function isBuiltInStep(stepId: string): stepId is BuiltInStepId {
    return BUILT_IN_STEPS_MAP.has(stepId as BuiltInStepId);
}

/**
 * Get all step IDs in their default order
 */
export function getBuiltInStepIds(): BuiltInStepId[] {
    return BUILT_IN_STEPS.map((step) => step.id as BuiltInStepId);
}

/**
 * Service ID mapping for built-in steps
 * Maps step ID to the NestJS service that executes it
 */
export const BUILT_IN_STEP_SERVICE_MAP: Record<BuiltInStepId, string> = {
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
    'markdown-generation': 'MarkdownGenerationService',
};
