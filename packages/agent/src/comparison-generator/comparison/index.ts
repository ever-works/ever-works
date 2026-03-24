export { selectNextPair, findManualPair, buildPairKey, countRemainingPairs } from './pair-selector';
export type { PairSelectionOptions } from './pair-selector';
export { buildSearchQueries, researchPair } from './comparison-researcher';
export type { ResearchDependencies } from './comparison-researcher';
export { generateComparison } from './comparison-writer';
export type { ComparisonAiDependencies, ComparisonPromptOptions } from './comparison-writer';
export { PROMPT_KEYS as COMPARISON_PROMPT_KEYS } from './prompt-keys';
export type {
    ComparisonPair,
    ComparisonResearch,
    ComparisonGenerationResult,
    ComparisonPluginSettings,
    ComparisonProgressStage,
    ComparisonProgressCallback,
    ComparisonProgressInfo,
} from './types';
export { DEFAULT_COMPARISON_SETTINGS } from './types';
