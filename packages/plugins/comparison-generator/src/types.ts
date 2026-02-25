import type { ItemData, ComparisonData, ComparisonDimension } from '@ever-works/contracts';

export interface ComparisonPair {
	readonly itemA: ItemData;
	readonly itemB: ItemData;
	readonly category: string;
	readonly pairKey: string;
}

export interface ComparisonResearch {
	readonly content: string;
	readonly sources: string[];
}

export interface ComparisonGenerationResult {
	readonly comparison: ComparisonData;
	readonly markdown: string;
}

export interface ComparisonPluginSettings {
	readonly cadence_override: 'use_directory' | 'daily' | 'weekly' | 'monthly';
	readonly max_comparisons_mode: 'custom' | 'unlimited';
	readonly max_comparisons: number;
	readonly min_items_for_comparison: number;
	readonly ai_provider?: string;
	readonly ai_model?: string;
}

export const DEFAULT_COMPARISON_SETTINGS: ComparisonPluginSettings = {
	cadence_override: 'use_directory',
	max_comparisons_mode: 'custom',
	max_comparisons: 50,
	min_items_for_comparison: 3
};

export { ComparisonData, ComparisonDimension };
