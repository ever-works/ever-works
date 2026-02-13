/**
 * Built-in pipeline step identifiers.
 *
 * This type is the SINGLE SOURCE OF TRUTH for all step IDs in the default pipeline.
 * The @ever-works/plugin package is agnostic to these IDs - it only knows about
 * generic step positions and definitions.
 */
export type BuiltInStepId =
	| 'prompt-comparison'
	| 'prompt-processing'
	| 'domain-detection'
	| 'ai-first-items-generation'
	| 'search-queries-generation'
	| 'web-search'
	| 'content-retrieval'
	| 'content-filtering'
	| 'items-extraction'
	| 'deduplication-and-data-aggregation'
	| 'categories-tags-processing'
	| 'sources-validation'
	| 'badges-processing'
	| 'image-capture'
	| 'markdown-generation';

/**
 * Array of all built-in step IDs in execution order.
 * Useful for iteration and validation.
 */
export const BUILT_IN_STEP_IDS: readonly BuiltInStepId[] = [
	'prompt-comparison',
	'prompt-processing',
	'domain-detection',
	'ai-first-items-generation',
	'search-queries-generation',
	'web-search',
	'content-retrieval',
	'content-filtering',
	'items-extraction',
	'deduplication-and-data-aggregation',
	'categories-tags-processing',
	'sources-validation',
	'badges-processing',
	'image-capture',
	'markdown-generation'
] as const;

/**
 * Type guard to check if a string is a valid BuiltInStepId
 */
export function isBuiltInStepId(value: string): value is BuiltInStepId {
	return BUILT_IN_STEP_IDS.includes(value as BuiltInStepId);
}
