/**
 * Prompt keys for the standard pipeline.
 *
 * These keys are used to look up externally managed prompts via the
 * prompt facade (e.g., Langfuse). When no external prompt is found,
 * the hardcoded default in each step file is used as fallback.
 *
 * Convention: `standard-pipeline.<step-name>`
 */
export const PROMPT_KEYS = {
	DOMAIN_DETECTION: 'standard-pipeline.domain-detection',
	PROMPT_PROCESSING: 'standard-pipeline.prompt-processing',
	SEARCH_QUERY_GENERATION: 'standard-pipeline.search-query-generation',
	CONTENT_FILTERING: 'standard-pipeline.content-filtering',
	ITEM_EXTRACTION: 'standard-pipeline.item-extraction',
	UNDERSTANDING: 'standard-pipeline.understanding',
	GENERATION: 'standard-pipeline.generation',
	MARKDOWN_GENERATION: 'standard-pipeline.markdown-generation',
	CATEGORY_PROCESSING: 'standard-pipeline.category-processing',
	ENHANCED_CATEGORY_PROCESSING: 'standard-pipeline.enhanced-category-processing',
	BADGE_PROCESSING: 'standard-pipeline.badge-processing',
	SOURCE_VALIDATION: 'standard-pipeline.source-validation',
	PROMPT_COMPARISON: 'standard-pipeline.prompt-comparison',
	DEDUPLICATION: 'standard-pipeline.deduplication',
	EXTRACT_NEW_ITEMS: 'standard-pipeline.extract-new-items'
} as const;
