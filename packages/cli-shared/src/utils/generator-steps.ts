export enum ItemsGeneratorSteps {
	PROMPT_COMPARISON = 'prompt-comparison',
	PROMPT_PROCESSING = 'prompt-processing',
	AI_FIRST_ITEMS_GENERATION = 'ai-first-items-generation',
	SEARCH_QUERIES_GENERATION = 'search-queries-generation',
	WEB_SEARCH = 'web-search',
	CONTENT_RETRIEVAL = 'content-retrieval',
	CONTENT_FILTERING = 'content-filtering',
	ITEMS_EXTRACTION = 'items-extraction',
	DEDUPLICATION_AND_DATA_AGGREGATION = 'deduplication-and-data-aggregation',
	CATEGORIES_TAGS_PROCESSING = 'categories-tags-processing',
	SOURCES_VALIDATION = 'sources-validation',
	BADGES_PROCESSING = 'badges-processing',
	ITEMS_PROCESSING = 'items-processing'
}

export function getStepText(step: ItemsGeneratorSteps): string {
	const steps: Record<ItemsGeneratorSteps, string> = {
		[ItemsGeneratorSteps.PROMPT_COMPARISON]: 'Comparing prompts',
		[ItemsGeneratorSteps.PROMPT_PROCESSING]: 'Processing your prompt',
		[ItemsGeneratorSteps.AI_FIRST_ITEMS_GENERATION]: 'Generating initial AI items',
		[ItemsGeneratorSteps.SEARCH_QUERIES_GENERATION]: 'Creating search queries',
		[ItemsGeneratorSteps.WEB_SEARCH]: 'Searching the web',
		[ItemsGeneratorSteps.CONTENT_RETRIEVAL]: 'Retrieving content',
		[ItemsGeneratorSteps.CONTENT_FILTERING]: 'Filtering relevant content',
		[ItemsGeneratorSteps.ITEMS_EXTRACTION]: 'Extracting items from content',
		[ItemsGeneratorSteps.DEDUPLICATION_AND_DATA_AGGREGATION]: 'Removing duplicates and aggregating data',
		[ItemsGeneratorSteps.CATEGORIES_TAGS_PROCESSING]: 'Processing categories and tags',
		[ItemsGeneratorSteps.SOURCES_VALIDATION]: 'Validating sources',
		[ItemsGeneratorSteps.BADGES_PROCESSING]: 'Processing quality badges',
		[ItemsGeneratorSteps.ITEMS_PROCESSING]: 'Finalizing items'
	};

	return steps[step] || 'Processing';
}

export function getStepProgress(step: ItemsGeneratorSteps): number {
	const steps = Object.values(ItemsGeneratorSteps);
	const currentIndex = steps.indexOf(step);

	if (currentIndex === -1) return 0;

	// Calculate percentage based on step position
	return Math.round(((currentIndex + 1) / steps.length) * 100);
}
