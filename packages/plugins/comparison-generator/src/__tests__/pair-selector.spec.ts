import { describe, it, expect } from 'vitest';
import { selectNextPair, findManualPair, buildPairKey, countRemainingPairs } from '../pair-selector.js';
import type { ItemData } from '@ever-works/contracts';

function makeItem(slug: string, category: string, opts: Partial<ItemData> = {}): ItemData {
	return {
		name: slug.charAt(0).toUpperCase() + slug.slice(1),
		description: `Description of ${slug}`,
		source_url: `https://${slug}.example.com`,
		category,
		slug,
		tags: [],
		...opts
	};
}

describe('buildPairKey', () => {
	it('should produce consistent order-independent keys', () => {
		expect(buildPairKey('vercel', 'netlify')).toBe('netlify--vercel');
		expect(buildPairKey('netlify', 'vercel')).toBe('netlify--vercel');
	});

	it('should produce different keys for different pairs', () => {
		expect(buildPairKey('a', 'b')).not.toBe(buildPairKey('a', 'c'));
	});
});

describe('selectNextPair', () => {
	const items = [
		makeItem('vercel', 'hosting'),
		makeItem('netlify', 'hosting'),
		makeItem('cloudflare', 'hosting'),
		makeItem('react', 'framework'),
		makeItem('vue', 'framework'),
		makeItem('angular', 'framework')
	];

	it('should return the first available pair when none generated', () => {
		const result = selectNextPair({
			items,
			generatedPairs: [],
			minItemsForComparison: 3,
			maxComparisons: 50
		});

		expect(result).not.toBeNull();
		expect(result!.category).toBeDefined();
		expect(result!.itemA.slug).toBeDefined();
		expect(result!.itemB.slug).toBeDefined();
	});

	it('should skip already-generated pairs', () => {
		const first = selectNextPair({
			items,
			generatedPairs: [],
			minItemsForComparison: 3,
			maxComparisons: 50
		});

		const second = selectNextPair({
			items,
			generatedPairs: [first!.pairKey],
			minItemsForComparison: 3,
			maxComparisons: 50
		});

		expect(second).not.toBeNull();
		expect(second!.pairKey).not.toBe(first!.pairKey);
	});

	it('should return null when max comparisons reached', () => {
		const result = selectNextPair({
			items,
			generatedPairs: ['some-pair'],
			minItemsForComparison: 3,
			maxComparisons: 1
		});

		expect(result).toBeNull();
	});

	it('should skip categories with fewer items than minimum', () => {
		const fewItems = [makeItem('react', 'framework'), makeItem('vue', 'framework')];

		const result = selectNextPair({
			items: fewItems,
			generatedPairs: [],
			minItemsForComparison: 3,
			maxComparisons: 50
		});

		expect(result).toBeNull();
	});

	it('should return null when all pairs exhausted', () => {
		const smallSet = [makeItem('a', 'cat'), makeItem('b', 'cat'), makeItem('c', 'cat')];

		const allPairs = [buildPairKey('a', 'b'), buildPairKey('a', 'c'), buildPairKey('b', 'c')];

		const result = selectNextPair({
			items: smallSet,
			generatedPairs: allPairs,
			minItemsForComparison: 3,
			maxComparisons: 50
		});

		expect(result).toBeNull();
	});

	it('should prioritize featured items', () => {
		const itemsWithFeatured = [
			makeItem('a', 'cat'),
			makeItem('b', 'cat', { featured: true }),
			makeItem('c', 'cat', { featured: true }),
			makeItem('d', 'cat')
		];

		const result = selectNextPair({
			items: itemsWithFeatured,
			generatedPairs: [],
			minItemsForComparison: 3,
			maxComparisons: 50
		});

		expect(result).not.toBeNull();
		const slugs = [result!.itemA.slug, result!.itemB.slug];
		// Featured items should be in the first pair
		expect(slugs).toContain('b');
		expect(slugs).toContain('c');
	});

	it('should skip items without slugs', () => {
		const itemsNoSlug = [
			{ ...makeItem('a', 'cat'), slug: undefined },
			makeItem('b', 'cat'),
			makeItem('c', 'cat'),
			makeItem('d', 'cat')
		];

		const result = selectNextPair({
			items: itemsNoSlug as ItemData[],
			generatedPairs: [],
			minItemsForComparison: 3,
			maxComparisons: 50
		});

		expect(result).not.toBeNull();
		expect(result!.itemA.slug).toBeDefined();
		expect(result!.itemB.slug).toBeDefined();
	});
});

describe('findManualPair', () => {
	const items = [makeItem('vercel', 'hosting'), makeItem('netlify', 'hosting'), makeItem('react', 'framework')];

	it('should find a pair by slugs', () => {
		const result = findManualPair(items, 'vercel', 'netlify');

		expect(result).not.toBeNull();
		expect(result!.itemA.slug).toBe('vercel');
		expect(result!.itemB.slug).toBe('netlify');
		expect(result!.category).toBe('hosting');
	});

	it('should return null if an item is not found', () => {
		expect(findManualPair(items, 'vercel', 'nonexistent')).toBeNull();
		expect(findManualPair(items, 'nonexistent', 'netlify')).toBeNull();
	});

	it('should find shared category for cross-category pairs', () => {
		const result = findManualPair(items, 'vercel', 'react');

		expect(result).not.toBeNull();
		expect(result!.category).toBeDefined();
	});
});

describe('countRemainingPairs', () => {
	const items = [makeItem('a', 'cat'), makeItem('b', 'cat'), makeItem('c', 'cat')];

	it('should return 0 when all pairs have been generated', () => {
		const allPairs = [buildPairKey('a', 'b'), buildPairKey('a', 'c'), buildPairKey('b', 'c')];

		const result = countRemainingPairs({
			items,
			generatedPairs: allPairs,
			minItemsForComparison: 3,
			maxComparisons: 50
		});

		expect(result).toBe(0);
	});

	it('should return correct count with partial generation', () => {
		const result = countRemainingPairs({
			items,
			generatedPairs: [buildPairKey('a', 'b')],
			minItemsForComparison: 3,
			maxComparisons: 50
		});

		// 3 items = 3 pairs total, 1 generated => 2 remaining
		expect(result).toBe(2);
	});

	it('should return all pairs when none generated', () => {
		const result = countRemainingPairs({
			items,
			generatedPairs: [],
			minItemsForComparison: 3,
			maxComparisons: 50
		});

		expect(result).toBe(3);
	});

	it('should respect maxComparisons cap', () => {
		const result = countRemainingPairs({
			items,
			generatedPairs: [],
			minItemsForComparison: 3,
			maxComparisons: 2
		});

		// 3 pairs available but max is 2 and 0 used, so 2 remaining
		expect(result).toBe(2);
	});

	it('should respect maxComparisons cap with existing pairs', () => {
		const result = countRemainingPairs({
			items,
			generatedPairs: [buildPairKey('a', 'b')],
			minItemsForComparison: 3,
			maxComparisons: 2
		});

		// 2 un-generated pairs but only 1 slot left (max 2, used 1)
		expect(result).toBe(1);
	});

	it('should respect minItemsForComparison', () => {
		const twoItems = [makeItem('x', 'small'), makeItem('y', 'small')];

		const result = countRemainingPairs({
			items: twoItems,
			generatedPairs: [],
			minItemsForComparison: 3,
			maxComparisons: 50
		});

		expect(result).toBe(0);
	});

	it('should count across multiple categories', () => {
		const multiCatItems = [
			makeItem('a', 'cat1'),
			makeItem('b', 'cat1'),
			makeItem('c', 'cat1'),
			makeItem('x', 'cat2'),
			makeItem('y', 'cat2'),
			makeItem('z', 'cat2')
		];

		const result = countRemainingPairs({
			items: multiCatItems,
			generatedPairs: [],
			minItemsForComparison: 3,
			maxComparisons: 50
		});

		// 3 pairs in cat1 + 3 pairs in cat2 = 6
		expect(result).toBe(6);
	});
});
