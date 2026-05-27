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

/**
 * Look up the user-facing label for a known {@link ItemsGeneratorStep}.
 * Returns the literal string `'Processing'` when `step` is not a member of
 * the enum — and {@link getDynamicStepText} relies on that exact sentinel
 * value to detect "no mapping found" and fall back to the raw step string.
 * Do not change the fallback without updating the caller.
 *
 * @param step - One of the standard-pipeline {@link ItemsGeneratorStep} values.
 * @returns Human-readable status text, or `'Processing'` for unknown steps.
 */
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

/**
 * Compute a 0–100 progress percentage from an {@link ItemsGeneratorStep}.
 *
 * Position is derived from the enum's declaration order via
 * `Object.values(ItemsGeneratorStep)` — adding a step in the middle of the
 * enum will shift every subsequent step's reported progress. The percentage
 * is 1-indexed (the first step reports `Math.round(1/N * 100)`, the last
 * reports `100`), so it never reads as `0` for a valid step. Returns `0`
 * when `step` is not a known enum value.
 *
 * @param step - One of the standard-pipeline {@link ItemsGeneratorStep} values.
 * @returns Integer 0–100 percentage.
 */
export function getStepProgress(step: ItemsGeneratorStep): number {
	const steps = Object.values(ItemsGeneratorStep);
	const currentIndex = steps.indexOf(step);

	if (currentIndex === -1) return 0;

	// Calculate percentage based on step position
	return Math.round(((currentIndex + 1) / steps.length) * 100);
}

/**
 * Generation status shape expected by dynamic helpers.
 * Matches the fields available on both API and agent GenerateStatus types.
 */
export interface GenerateStatusFields {
	step?: string;
	stepName?: string;
	stepIndex?: number;
	totalSteps?: number;
	progress?: number;
	itemsProcessed?: number;
}

/**
 * Get human-readable step text from dynamic pipeline status.
 * Uses `stepName` when available, falls back to enum lookup.
 */
export function getDynamicStepText(status: GenerateStatusFields): string {
	if (status.stepName) {
		return status.stepName;
	}
	if (status.step) {
		// Try enum lookup (for legacy standard-pipeline steps)
		const enumText = getStepText(status.step as ItemsGeneratorStep);
		// If enum lookup fails ('Processing' fallback), use the raw step value
		if (enumText !== 'Processing') return enumText;
		return status.step;
	}
	return 'Processing';
}

/**
 * Get progress percentage from dynamic pipeline status.
 * Uses `progress` field when available, falls back to enum-based calculation.
 */
export function getDynamicStepProgress(status: GenerateStatusFields): number {
	if (status.progress !== undefined) {
		return Math.round(status.progress);
	}
	if (status.stepIndex !== undefined && status.totalSteps !== undefined && status.totalSteps > 0) {
		return Math.round(((status.stepIndex + 1) / status.totalSteps) * 100);
	}
	if (status.step) {
		return getStepProgress(status.step as ItemsGeneratorStep);
	}
	return 0;
}

/**
 * Get items-processed text when available.
 * Returns e.g. "27 items" or undefined when not applicable.
 */
export function getItemsProcessedText(status: GenerateStatusFields): string | undefined {
	if (status.itemsProcessed !== undefined && status.itemsProcessed > 0) {
		return `${status.itemsProcessed} items`;
	}
	return undefined;
}
