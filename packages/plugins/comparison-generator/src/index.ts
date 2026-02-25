export { ComparisonGeneratorPlugin, ComparisonGeneratorPlugin as default } from './comparison-generator.plugin.js';
export { selectNextPair, findManualPair, buildPairKey } from './pair-selector.js';
export { buildSearchQueries, researchPair } from './comparison-researcher.js';
export type { ResearchDependencies } from './comparison-researcher.js';
export { generateComparison } from './comparison-writer.js';
export type { ComparisonAiDependencies } from './comparison-writer.js';
export type {
	ComparisonPair,
	ComparisonResearch,
	ComparisonGenerationResult,
	ComparisonPluginSettings
} from './types.js';
export { DEFAULT_COMPARISON_SETTINGS } from './types.js';
