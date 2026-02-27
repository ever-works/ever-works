import { buildSearchQueries, researchPair } from '../comparison-researcher';
import type { ResearchDependencies } from '../comparison-researcher';
import type { ComparisonPair } from '../types';
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

function makePair(slugA: string, slugB: string, category = 'hosting'): ComparisonPair {
	return {
		itemA: makeItem(slugA, category),
		itemB: makeItem(slugB, category),
		category,
		pairKey: [slugA, slugB].sort().join('--')
	};
}

function makeDeps(overrides: Partial<ResearchDependencies> = {}): ResearchDependencies {
	return {
		search: jest.fn().mockResolvedValue([]),
		extractContent: jest.fn().mockResolvedValue(null),
		...overrides
	};
}

describe('buildSearchQueries', () => {
	const pair = makePair('vercel', 'netlify');

	it('should return 4 queries', () => {
		const queries = buildSearchQueries(pair);
		expect(queries).toHaveLength(4);
	});

	it('should contain both item names in every query', () => {
		const queries = buildSearchQueries(pair);
		for (const q of queries) {
			expect(q.toLowerCase()).toContain('vercel');
			expect(q.toLowerCase()).toContain('netlify');
		}
	});

	it('should include vs keyword', () => {
		const queries = buildSearchQueries(pair);
		expect(queries.some((q) => q.includes('vs'))).toBe(true);
	});

	it('should include compare keyword', () => {
		const queries = buildSearchQueries(pair);
		expect(queries.some((q) => q.includes('compare'))).toBe(true);
	});

	it('should include alternative keyword', () => {
		const queries = buildSearchQueries(pair);
		expect(queries.some((q) => q.includes('alternative'))).toBe(true);
	});

	it('should include which is better keyword', () => {
		const queries = buildSearchQueries(pair);
		expect(queries.some((q) => q.includes('which is better'))).toBe(true);
	});
});

describe('researchPair', () => {
	const pair = makePair('vercel', 'netlify');

	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('should call search with each query', async () => {
		const search = jest.fn().mockResolvedValue([]);
		const deps = makeDeps({ search });

		await researchPair(pair, deps);

		// Default maxQueries is 3, so 3 of the 4 queries are used
		expect(search).toHaveBeenCalledTimes(3);
	});

	it('should deduplicate URLs across queries', async () => {
		const sharedResult = { url: 'https://example.com/shared', snippet: 'shared result' };
		const search = jest.fn().mockResolvedValue([sharedResult]);
		const extractContent = jest.fn().mockResolvedValue('content');
		const deps = makeDeps({ search, extractContent });

		const result = await researchPair(pair, deps);

		// Even though 3 queries each return the same URL, it should appear once
		expect(result.sources).toHaveLength(1);
		expect(result.sources[0]).toBe('https://example.com/shared');
	});

	it('should call extractContent for top results', async () => {
		const results = [
			{ url: 'https://a.com', snippet: 'A' },
			{ url: 'https://b.com', snippet: 'B' }
		];
		const search = jest.fn().mockResolvedValue(results);
		const extractContent = jest.fn().mockResolvedValue('extracted');
		const deps = makeDeps({ search, extractContent });

		await researchPair(pair, deps);

		expect(extractContent).toHaveBeenCalledWith('https://a.com');
		expect(extractContent).toHaveBeenCalledWith('https://b.com');
	});

	it('should handle search failure gracefully and continue', async () => {
		let callCount = 0;
		const search = jest.fn().mockImplementation(() => {
			callCount++;
			if (callCount === 1) return Promise.reject(new Error('Network error'));
			return Promise.resolve([{ url: 'https://ok.com', snippet: 'ok' }]);
		});
		const deps = makeDeps({ search });

		const result = await researchPair(pair, deps);

		// Should not throw, and should still have results from successful queries
		expect(result.sources).toContain('https://ok.com');
	});

	it('should fall back to snippet when extraction fails', async () => {
		const search = jest.fn().mockResolvedValue([{ url: 'https://fail.com', snippet: 'fallback snippet' }]);
		const extractContent = jest.fn().mockRejectedValue(new Error('Extraction error'));
		const deps = makeDeps({ search, extractContent });

		const result = await researchPair(pair, deps);

		expect(result.content).toContain('fallback snippet');
	});

	it('should trim content longer than 2000 chars', async () => {
		const longContent = 'x'.repeat(3000);
		const search = jest.fn().mockResolvedValue([{ url: 'https://long.com', snippet: '' }]);
		const extractContent = jest.fn().mockResolvedValue(longContent);
		const deps = makeDeps({ search, extractContent });

		const result = await researchPair(pair, deps);

		// Content should be trimmed to ~2000 chars + "..."
		expect(result.content).toContain('...');
		expect(result.content.length).toBeLessThan(3000);
	});

	it('should respect maxQueries option', async () => {
		const search = jest.fn().mockResolvedValue([]);
		const deps = makeDeps({ search });

		await researchPair(pair, deps, { maxQueries: 2 });

		expect(search).toHaveBeenCalledTimes(2);
	});

	it('should respect maxResultsPerQuery option', async () => {
		const search = jest.fn().mockResolvedValue([]);
		const deps = makeDeps({ search });

		await researchPair(pair, deps, { maxResultsPerQuery: 10 });

		expect(search).toHaveBeenCalledWith(expect.any(String), 10);
	});

	it('should respect maxExtractions option', async () => {
		const manyResults = Array.from({ length: 10 }, (_, i) => ({
			url: `https://r${i}.com`,
			snippet: `snippet ${i}`
		}));
		const search = jest.fn().mockResolvedValue(manyResults);
		const extractContent = jest.fn().mockResolvedValue('content');
		const deps = makeDeps({ search, extractContent });

		await researchPair(pair, deps, { maxQueries: 1, maxExtractions: 3 });

		expect(extractContent).toHaveBeenCalledTimes(3);
	});

	it('should return sources array with all processed URLs', async () => {
		const results = [
			{ url: 'https://a.com', snippet: 'A' },
			{ url: 'https://b.com', snippet: 'B' },
			{ url: 'https://c.com', snippet: 'C' }
		];
		const search = jest.fn().mockResolvedValue(results);
		const deps = makeDeps({ search });

		const result = await researchPair(pair, deps, { maxQueries: 1, maxExtractions: 3 });

		expect(result.sources).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
	});
});
