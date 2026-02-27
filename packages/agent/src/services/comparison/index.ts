export { selectNextPair, findManualPair, buildPairKey, countRemainingPairs } from './pair-selector';
export type { PairSelectionOptions } from './pair-selector';
export { buildSearchQueries, researchPair } from './comparison-researcher';
export type { ResearchDependencies } from './comparison-researcher';
export { generateComparison } from './comparison-writer';
export type { ComparisonAiDependencies } from './comparison-writer';
export type {
	ComparisonPair,
	ComparisonResearch,
	ComparisonGenerationResult,
	ComparisonPluginSettings
} from './types';
export { DEFAULT_COMPARISON_SETTINGS } from './types';
