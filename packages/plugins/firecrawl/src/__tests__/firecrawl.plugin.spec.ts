import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginContext, SearchOptions, ContentExtractionOptions } from '@ever-works/plugin';

const { searchMock, scrapeMock, batchScrapeMock, FirecrawlAppCtorMock } = vi.hoisted(() => {
	const search = vi.fn();
	const scrape = vi.fn();
	const batchScrape = vi.fn();
	const ctor = vi.fn().mockImplementation(() => ({ search, scrape, batchScrape }));
	return {
		searchMock: search,
		scrapeMock: scrape,
		batchScrapeMock: batchScrape,
		FirecrawlAppCtorMock: ctor
	};
});

vi.mock('@mendable/firecrawl-js', () => ({
	default: FirecrawlAppCtorMock
}));

const { FirecrawlPlugin } = await import('../firecrawl.plugin.js');

const buildContext = (settings: Record<string, unknown> = {}): PluginContext =>
	({
		pluginId: 'firecrawl',
		logger: {
			log: vi.fn(),
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn()
		},
		getSettings: vi.fn().mockResolvedValue(settings)
	}) as unknown as PluginContext;

describe('FirecrawlPlugin', () => {
	let plugin: FirecrawlPlugin;

	beforeEach(() => {
		vi.clearAllMocks();
		plugin = new FirecrawlPlugin();
	});

	describe('metadata', () => {
		it('exposes stable identity fields', () => {
			expect(plugin.id).toBe('firecrawl');
			expect(plugin.name).toBe('Firecrawl');
			expect(plugin.version).toBe('1.0.0');
			expect(plugin.category).toBe('search');
			expect(plugin.providerName).toBe('Firecrawl');
		});

		it('declares both search and content-extractor capabilities', () => {
			expect(plugin.capabilities).toEqual(['search', 'content-extractor']);
		});

		it('uses hybrid configuration mode', () => {
			expect(plugin.configurationMode).toBe('hybrid');
		});
	});

	describe('settingsSchema', () => {
		it('requires apiKey and marks it as user-scoped secret', () => {
			expect(plugin.settingsSchema.required).toContain('apiKey');
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.apiKey['x-secret']).toBe(true);
			expect(props.apiKey['x-envVar']).toBe('PLUGIN_FIRECRAWL_API_KEY');
		});
	});

	describe('search', () => {
		const opts = (overrides: Partial<SearchOptions> = {}): SearchOptions => ({
			query: 'hello',
			settings: { apiKey: 'k' },
			...overrides
		});

		it('throws when apiKey is missing', async () => {
			await expect(plugin.search({ query: 'hello', settings: {} })).rejects.toThrow(/API key not configured/i);
			expect(FirecrawlAppCtorMock).not.toHaveBeenCalled();
		});

		it('maps web results with description+title and derives source hostname', async () => {
			searchMock.mockResolvedValueOnce({
				web: [
					{
						title: 'Example',
						url: 'https://www.example.com/page',
						description: 'Example description'
					}
				]
			});
			const r = await plugin.search(opts({ limit: 5 }));

			expect(FirecrawlAppCtorMock).toHaveBeenCalledWith({ apiKey: 'k' });
			expect(searchMock).toHaveBeenCalledWith('hello', { limit: 5 });
			expect(r.results).toHaveLength(1);
			expect(r.results[0]).toMatchObject({
				title: 'Example',
				url: 'https://www.example.com/page',
				snippet: 'Example description',
				position: 1,
				source: 'www.example.com'
			});
		});

		it('falls back to markdown when description is absent', async () => {
			searchMock.mockResolvedValueOnce({
				web: [{ title: 't', url: 'https://example.com', markdown: '# header' }]
			});
			const r = await plugin.search(opts());
			expect(r.results[0].snippet).toBe('# header');
		});

		it('handles missing fields gracefully', async () => {
			searchMock.mockResolvedValueOnce({ web: [{}] });
			const r = await plugin.search(opts());
			expect(r.results[0]).toMatchObject({ title: '', url: '', snippet: '' });
		});

		it('returns an empty result list when web is missing', async () => {
			searchMock.mockResolvedValueOnce({});
			const r = await plugin.search(opts());
			expect(r.results).toEqual([]);
		});

		it('logs and rethrows on SDK failure', async () => {
			const ctx = buildContext();
			await plugin.onLoad(ctx);
			searchMock.mockRejectedValueOnce(new Error('boom'));
			await expect(plugin.search(opts())).rejects.toThrow(/boom/);
			expect(ctx.logger.error).toHaveBeenCalled();
		});
	});

	describe('extract', () => {
		const opts = (overrides: Partial<ContentExtractionOptions> = {}): ContentExtractionOptions => ({
			url: 'https://example.com/post',
			settings: { apiKey: 'k' },
			...overrides
		});

		it('returns success with markdown, title, wordCount, readingTime', async () => {
			scrapeMock.mockResolvedValueOnce({
				markdown: 'one two three four five',
				metadata: { title: 'Title', url: 'https://example.com/post' }
			});
			const r = await plugin.extract(opts());
			expect(scrapeMock).toHaveBeenCalledWith('https://example.com/post', { formats: ['markdown'] });
			expect(r.success).toBe(true);
			expect(r.title).toBe('Title');
			expect(r.markdown).toBe('one two three four five');
			expect(r.wordCount).toBe(5);
			expect(r.readingTime).toBe(1);
		});

		it('exposes finalUrl when metadata.url differs', async () => {
			scrapeMock.mockResolvedValueOnce({
				markdown: 'hi',
				metadata: { title: 't', url: 'https://example.com/redirected' }
			});
			const r = await plugin.extract(opts());
			expect(r.finalUrl).toBe('https://example.com/redirected');
		});

		it('returns failure when markdown is empty', async () => {
			scrapeMock.mockResolvedValueOnce({ markdown: '', metadata: {} });
			const r = await plugin.extract(opts());
			expect(r.success).toBe(false);
			expect(r.error).toMatch(/No content extracted/);
		});

		it('returns failure when SDK throws', async () => {
			scrapeMock.mockRejectedValueOnce(new Error('extract failed'));
			const r = await plugin.extract(opts());
			expect(r.success).toBe(false);
			expect(r.error).toMatch(/extract failed/);
		});
	});

	describe('extractBatch', () => {
		it('uses batch API when available', async () => {
			batchScrapeMock.mockResolvedValueOnce({
				data: [
					{ markdown: 'one two', metadata: { title: 'A', url: 'https://a' } },
					{ markdown: 'three four five', metadata: { title: 'B', url: 'https://b' } }
				]
			});
			const r = await plugin.extractBatch(['https://a', 'https://b'], { settings: { apiKey: 'k' } });
			expect(r).toHaveLength(2);
			expect(r[0]).toMatchObject({ success: true, url: 'https://a', wordCount: 2 });
			expect(r[1]).toMatchObject({ success: true, url: 'https://b', wordCount: 3 });
		});

		it('falls back to sequential extract when batch API throws', async () => {
			batchScrapeMock.mockRejectedValueOnce(new Error('batch unavailable'));
			scrapeMock
				.mockResolvedValueOnce({ markdown: 'one two', metadata: { title: 'A', url: 'https://a' } })
				.mockResolvedValueOnce({ markdown: 'three', metadata: { title: 'B', url: 'https://b' } });

			const r = await plugin.extractBatch(['https://a', 'https://b'], { settings: { apiKey: 'k' } });
			expect(r).toHaveLength(2);
			expect(r[0]).toMatchObject({ success: true, wordCount: 2 });
			expect(r[1]).toMatchObject({ success: true, wordCount: 1 });
		});

		it('reports per-item failure when batch returns empty markdown', async () => {
			batchScrapeMock.mockResolvedValueOnce({
				data: [{ markdown: '', metadata: { url: 'https://a' } }]
			});
			const r = await plugin.extractBatch(['https://a'], { settings: { apiKey: 'k' } });
			expect(r[0].success).toBe(false);
		});
	});

	describe('isAvailable', () => {
		it('returns false without context', async () => {
			expect(await plugin.isAvailable()).toBe(false);
		});

		it('reflects whether settings has an apiKey', async () => {
			await plugin.onLoad(buildContext({ apiKey: 'k' }));
			expect(await plugin.isAvailable()).toBe(true);

			await plugin.onLoad(buildContext({}));
			expect(await plugin.isAvailable()).toBe(false);
		});
	});

	describe('validateConnection', () => {
		it('fails fast without apiKey', async () => {
			const r = await plugin.validateConnection({});
			expect(r.success).toBe(false);
			expect(r.message).toMatch(/not configured/i);
		});

		it('returns success when SDK search works', async () => {
			searchMock.mockResolvedValueOnce({ web: [] });
			const r = await plugin.validateConnection({ apiKey: 'k' });
			expect(r.success).toBe(true);
		});

		it('returns failure when SDK throws', async () => {
			searchMock.mockRejectedValueOnce(new Error('bad key'));
			const r = await plugin.validateConnection({ apiKey: 'k' });
			expect(r.success).toBe(false);
		});
	});

	describe('canExtract / getSupportedFormats', () => {
		it('accepts http and https URLs', async () => {
			expect(await plugin.canExtract('https://example.com')).toBe(true);
			expect(await plugin.canExtract('http://example.com')).toBe(true);
		});

		it('rejects non-http schemes and invalid URLs', async () => {
			expect(await plugin.canExtract('ftp://example.com')).toBe(false);
			expect(await plugin.canExtract('garbage')).toBe(false);
		});

		it('exposes only the markdown format', () => {
			expect(plugin.getSupportedFormats()).toEqual(['markdown']);
		});
	});

	describe('lifecycle', () => {
		it('logs on load and clears context on unload', async () => {
			const ctx = buildContext();
			await plugin.onLoad(ctx);
			expect(ctx.logger.log).toHaveBeenCalledWith('Firecrawl Plugin loaded');
			await plugin.onUnload();
			expect(await plugin.isAvailable()).toBe(false);
		});
	});

	describe('healthCheck + manifest', () => {
		it('reports healthy', async () => {
			const h = await plugin.healthCheck();
			expect(h.status).toBe('healthy');
		});

		it('returns a manifest aligned with plugin metadata', () => {
			const m = plugin.getManifest();
			expect(m.id).toBe('firecrawl');
			expect(m.category).toBe('search');
			expect(m.capabilities).toEqual(['search', 'content-extractor']);
			expect(m.builtIn).toBe(true);
		});
	});
});
