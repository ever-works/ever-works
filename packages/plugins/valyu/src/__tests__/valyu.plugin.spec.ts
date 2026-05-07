import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginContext, SearchOptions, ContentExtractionOptions } from '@ever-works/plugin';

const { searchMock, contentsMock, ValyuCtorMock } = vi.hoisted(() => {
	const search = vi.fn();
	const contents = vi.fn();
	const ctor = vi.fn().mockImplementation(() => ({ search, contents }));
	return { searchMock: search, contentsMock: contents, ValyuCtorMock: ctor };
});

vi.mock('valyu-js', () => ({
	Valyu: ValyuCtorMock
}));

const { ValyuSearchPlugin } = await import('../valyu.plugin.js');

const buildContext = (settings: Record<string, unknown> = {}): PluginContext =>
	({
		pluginId: 'valyu',
		logger: {
			log: vi.fn(),
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn()
		},
		getSettings: vi.fn().mockResolvedValue(settings)
	}) as unknown as PluginContext;

describe('ValyuSearchPlugin', () => {
	let plugin: ValyuSearchPlugin;

	beforeEach(() => {
		vi.clearAllMocks();
		plugin = new ValyuSearchPlugin();
	});

	describe('metadata', () => {
		it('exposes stable identity fields', () => {
			expect(plugin.id).toBe('valyu');
			expect(plugin.name).toBe('Valyu');
			expect(plugin.version).toBe('1.0.0');
			expect(plugin.category).toBe('search');
			expect(plugin.providerName).toBe('Valyu');
		});

		it('declares both search and content-extractor capabilities', () => {
			expect(plugin.capabilities).toEqual(['search', 'content-extractor']);
		});

		it('uses hybrid configuration mode', () => {
			expect(plugin.configurationMode).toBe('hybrid');
		});
	});

	describe('settingsSchema', () => {
		it('requires apiKey and exposes a responseLength enum', () => {
			expect(plugin.settingsSchema.required).toContain('apiKey');
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.apiKey['x-secret']).toBe(true);
			expect(props.apiKey['x-envVar']).toBe('PLUGIN_VALYU_API_KEY');
			expect(props.responseLength.default).toBe('medium');
			expect(props.responseLength.enum).toEqual(['short', 'medium', 'large', 'max']);
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
			expect(ValyuCtorMock).not.toHaveBeenCalled();
		});

		it('maps SDK results to SearchResult shape', async () => {
			searchMock.mockResolvedValueOnce({
				results: [
					{
						title: 'Example',
						url: 'https://example.com',
						content: 'snippet text',
						relevance_score: 0.7,
						source: 'web',
						description: 'desc',
						publication_date: '2026-01-01'
					}
				]
			});
			const r = await plugin.search(opts());

			expect(ValyuCtorMock).toHaveBeenCalledWith('k');
			expect(r.results).toHaveLength(1);
			expect(r.results[0]).toMatchObject({
				title: 'Example',
				url: 'https://example.com',
				snippet: 'snippet text',
				position: 1,
				publishedDate: '2026-01-01'
			});
			expect(r.results[0].metadata).toMatchObject({
				relevanceScore: 0.7,
				source: 'web',
				description: 'desc'
			});
			expect(r.totalResults).toBe(1);
			expect(r.hasMore).toBe(false);
		});

		it('coerces non-string content to string', async () => {
			searchMock.mockResolvedValueOnce({
				results: [{ title: 't', url: 'https://e', content: { foo: 'bar' } }]
			});
			const r = await plugin.search(opts());
			expect(typeof r.results[0].snippet).toBe('string');
		});

		it('forwards limit, responseLength, and country code', async () => {
			searchMock.mockResolvedValueOnce({ results: [] });
			await plugin.search(
				opts({
					limit: 7,
					region: 'us',
					settings: { apiKey: 'k', responseLength: 'large' }
				})
			);
			expect(searchMock).toHaveBeenCalledWith(
				'hello',
				expect.objectContaining({
					searchType: 'all',
					maxNumResults: 7,
					responseLength: 'large',
					countryCode: 'US'
				})
			);
		});

		it('uses includedSources when includeDomains is set', async () => {
			searchMock.mockResolvedValueOnce({ results: [] });
			await plugin.search(opts({ includeDomains: ['a.com'] }));
			expect(searchMock.mock.calls[0][1]).toMatchObject({ includedSources: ['a.com'] });
		});

		it('uses excludeSources when only excludeDomains is set', async () => {
			searchMock.mockResolvedValueOnce({ results: [] });
			await plugin.search(opts({ excludeDomains: ['b.com'] }));
			expect(searchMock.mock.calls[0][1]).toMatchObject({ excludeSources: ['b.com'] });
		});

		it('translates timeRange into start/end ISO date strings', async () => {
			searchMock.mockResolvedValueOnce({ results: [] });
			await plugin.search(opts({ timeRange: 'week' }));
			const call = searchMock.mock.calls[0][1];
			expect(call.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(call.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		it('skips date filters when timeRange is "all"', async () => {
			searchMock.mockResolvedValueOnce({ results: [] });
			await plugin.search(opts({ timeRange: 'all' }));
			const call = searchMock.mock.calls[0][1];
			expect(call.startDate).toBeUndefined();
			expect(call.endDate).toBeUndefined();
		});

		it('logs and rethrows on SDK failure', async () => {
			const ctx = buildContext();
			await plugin.onLoad(ctx);
			searchMock.mockRejectedValueOnce(new Error('boom'));
			await expect(plugin.search(opts())).rejects.toThrow(/boom/);
			expect(ctx.logger.error).toHaveBeenCalled();
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
			searchMock.mockResolvedValueOnce({ results: [] });
			const r = await plugin.validateConnection({ apiKey: 'k' });
			expect(r.success).toBe(true);
		});

		it('returns failure when SDK search rejects', async () => {
			searchMock.mockRejectedValueOnce(new Error('bad key'));
			const r = await plugin.validateConnection({ apiKey: 'k' });
			expect(r.success).toBe(false);
			expect(r.message).toMatch(/bad key/);
		});
	});

	describe('extract', () => {
		const opts = (overrides: Partial<ContentExtractionOptions> = {}): ContentExtractionOptions => ({
			url: 'https://example.com/post',
			settings: { apiKey: 'k' },
			...overrides
		});

		it('returns success with markdown and word count', async () => {
			contentsMock.mockResolvedValueOnce({
				results: [
					{
						url: 'https://example.com/post',
						title: 'Title',
						content: 'one two three'
					}
				]
			});
			const r = await plugin.extract(opts());
			expect(r.success).toBe(true);
			expect(r.title).toBe('Title');
			expect(r.markdown).toBe('one two three');
			expect(r.wordCount).toBe(3);
		});

		it('returns failure when no results are produced', async () => {
			contentsMock.mockResolvedValueOnce({ results: [] });
			const r = await plugin.extract(opts());
			expect(r.success).toBe(false);
			expect(r.error).toMatch(/No content extracted/);
		});

		it('returns failure when SDK throws', async () => {
			contentsMock.mockRejectedValueOnce(new Error('extract failed'));
			const r = await plugin.extract(opts());
			expect(r.success).toBe(false);
			expect(r.error).toMatch(/extract failed/);
		});
	});

	describe('extractBatch', () => {
		it('chunks URLs into batches of 10 and aggregates results', async () => {
			const urls = Array.from({ length: 12 }, (_, i) => `https://example.com/${i}`);
			contentsMock
				.mockResolvedValueOnce({
					results: urls.slice(0, 10).map((u) => ({ url: u, title: 't', content: 'a b' }))
				})
				.mockResolvedValueOnce({
					results: urls.slice(10).map((u) => ({ url: u, title: 't', content: 'c d e' }))
				});

			const r = await plugin.extractBatch(urls, { settings: { apiKey: 'k' } });
			expect(contentsMock).toHaveBeenCalledTimes(2);
			expect(r).toHaveLength(12);
			expect(r[0]).toMatchObject({ success: true, wordCount: 2 });
			expect(r[10]).toMatchObject({ success: true, wordCount: 3 });
		});

		it('returns per-URL failures when the batch call throws', async () => {
			contentsMock.mockRejectedValueOnce(new Error('batch failed'));
			const r = await plugin.extractBatch(['https://a', 'https://b'], { settings: { apiKey: 'k' } });
			expect(r).toHaveLength(2);
			expect(r.every((x) => x.success === false)).toBe(true);
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

		it('exposes text + markdown formats', () => {
			expect(plugin.getSupportedFormats()).toEqual(['text', 'markdown']);
		});
	});

	describe('lifecycle', () => {
		it('logs on load and clears context on unload', async () => {
			const ctx = buildContext();
			await plugin.onLoad(ctx);
			expect(ctx.logger.log).toHaveBeenCalledWith('Valyu Plugin loaded');
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
			expect(m.id).toBe('valyu');
			expect(m.category).toBe('search');
			expect(m.capabilities).toEqual(['search', 'content-extractor']);
			expect(m.builtIn).toBe(true);
			expect(m.systemPlugin).toBe(false);
			expect(m.autoEnable).toBe(false);
		});
	});
});
