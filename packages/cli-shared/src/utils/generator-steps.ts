export enum ItemsGeneratorStep {
	PROMPT_COMPARISON = 'prompt-comparison',
	PROMPT_PROCESSING = 'prompt-processing',
	DOMAIN_DETECTION = 'domain-detection',
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
	MARKDOWN_GENERATION = 'markdown-generation'
}

export function getStepText(step: ItemsGeneratorStep): string {
	const steps: Record<ItemsGeneratorStep, string> = {
		[ItemsGeneratorStep.PROMPT_COMPARISON]: 'Comparing prompts',
		[ItemsGeneratorStep.PROMPT_PROCESSING]: 'Processing your prompt',
		[ItemsGeneratorStep.DOMAIN_DETECTION]: 'Detecting domain type',
		[ItemsGeneratorStep.AI_FIRST_ITEMS_GENERATION]: 'Generating initial AI items',
		[ItemsGeneratorStep.SEARCH_QUERIES_GENERATION]: 'Creating search queries',
		[ItemsGeneratorStep.WEB_SEARCH]: 'Searching the web',
		[ItemsGeneratorStep.CONTENT_RETRIEVAL]: 'Retrieving content',
		[ItemsGeneratorStep.CONTENT_FILTERING]: 'Filtering relevant content',
		[ItemsGeneratorStep.ITEMS_EXTRACTION]: 'Extracting items from content',
		[ItemsGeneratorStep.DEDUPLICATION_AND_DATA_AGGREGATION]: 'Removing duplicates and aggregating data',
		[ItemsGeneratorStep.CATEGORIES_TAGS_PROCESSING]: 'Processing categories and tags',
		[ItemsGeneratorStep.SOURCES_VALIDATION]: 'Validating sources',
		[ItemsGeneratorStep.BADGES_PROCESSING]: 'Processing quality badges',
		[ItemsGeneratorStep.MARKDOWN_GENERATION]: 'Generating markdown content'
	};

	return steps[step] || 'Processing';
}

export function getStepProgress(step: ItemsGeneratorStep): number {
	const steps = Object.values(ItemsGeneratorStep);
	const currentIndex = steps.indexOf(step);

	if (currentIndex === -1) return 0;

	// Calculate percentage based on step position
	return Math.round(((currentIndex + 1) / steps.length) * 100);
}
