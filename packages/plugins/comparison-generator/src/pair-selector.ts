import type { ItemData } from '@ever-works/contracts';
import type { ComparisonPair } from './types.js';

/**
 * Build a canonical pair key that is order-independent.
 * "netlify--vercel" and "vercel--netlify" both produce "netlify--vercel".
 */
export function buildPairKey(slugA: string, slugB: string): string {
	return [slugA, slugB].sort().join('--');
}

/**
 * Group items by their primary category (first category if array).
 */
function groupByCategory(items: ItemData[]): Map<string, ItemData[]> {
	const groups = new Map<string, ItemData[]>();

	for (const item of items) {
		if (!item.slug) continue;

		const categories = Array.isArray(item.category) ? item.category : [item.category];
		const primary = categories[0];
		if (!primary) continue;

		const group = groups.get(primary) ?? [];
		group.push(item);
		groups.set(primary, group);
	}

	return groups;
}

/**
 * Sort items for pair priority: featured first, then by order, then alphabetical.
 */
function sortItemsForPriority(items: ItemData[]): ItemData[] {
	return [...items].sort((a, b) => {
		if (a.featured && !b.featured) return -1;
		if (!a.featured && b.featured) return 1;

		const orderA = a.order ?? Number.MAX_SAFE_INTEGER;
		const orderB = b.order ?? Number.MAX_SAFE_INTEGER;
		if (orderA !== orderB) return orderA - orderB;

		return a.name.localeCompare(b.name);
	});
}

/**
 * Generate all possible pairs from a list of items.
 */
function generateAllPairs(items: ItemData[], category: string): ComparisonPair[] {
	const pairs: ComparisonPair[] = [];
	for (let i = 0; i < items.length; i++) {
		for (let j = i + 1; j < items.length; j++) {
			const itemA = items[i];
			const itemB = items[j];
			pairs.push({
				itemA,
				itemB,
				category,
				pairKey: buildPairKey(itemA.slug!, itemB.slug!)
			});
		}
	}
	return pairs;
}

export interface PairSelectionOptions {
	readonly items: ItemData[];
	readonly generatedPairs: readonly string[];
	readonly minItemsForComparison: number;
	readonly maxComparisons: number;
}

/**
 * Select the next pair to compare, or null if all pairs are exhausted or cap reached.
 */
export function selectNextPair(options: PairSelectionOptions): ComparisonPair | null {
	const { items, generatedPairs, minItemsForComparison, maxComparisons } = options;

	if (generatedPairs.length >= maxComparisons) {
		return null;
	}

	const generatedSet = new Set(generatedPairs);
	const categoryGroups = groupByCategory(items);

	for (const [category, categoryItems] of categoryGroups) {
		if (categoryItems.length < minItemsForComparison) {
			continue;
		}

		const sorted = sortItemsForPriority(categoryItems);
		const pairs = generateAllPairs(sorted, category);

		for (const pair of pairs) {
			if (!generatedSet.has(pair.pairKey)) {
				return pair;
			}
		}
	}

	return null;
}

/**
 * Find a specific pair of items by slug, regardless of category constraints.
 */
export function findManualPair(items: ItemData[], itemASlug: string, itemBSlug: string): ComparisonPair | null {
	const itemA = items.find((i) => i.slug === itemASlug);
	const itemB = items.find((i) => i.slug === itemBSlug);

	if (!itemA || !itemB) {
		return null;
	}

	const categoriesA = Array.isArray(itemA.category) ? itemA.category : [itemA.category];
	const categoriesB = Array.isArray(itemB.category) ? itemB.category : [itemB.category];
	const sharedCategory = categoriesA.find((c) => categoriesB.includes(c)) ?? categoriesA[0] ?? '';

	return {
		itemA,
		itemB,
		category: sharedCategory,
		pairKey: buildPairKey(itemASlug, itemBSlug)
	};
}
