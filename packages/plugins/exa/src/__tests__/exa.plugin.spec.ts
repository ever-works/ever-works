import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginContext, SearchOptions, ContentExtractionOptions } from '@ever-works/plugin';

const { searchMock, getContentsMock, ExaCtorMock } = vi.hoisted(() => {
	const search = vi.fn();
	const getContents = vi.fn();
	const ctor = vi.fn().mockImplementation(() => ({ search, getContents }));
	return { searchMock: search, getContentsMock: getContents, ExaCtorMock: ctor };
});

vi.mock('exa-js', () => ({
	Exa: ExaCtorMock
}));

const { ExaSearchPlugin } = await import('../exa.plugin.js');

const buildContext = (settings: Record<string, unknown> = {}): PluginContext =>
	({
		pluginId: 'exa',
		logger: {
			log: vi.fn(),
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn()
		},
		getSettings: vi.fn().mockResolvedValue(settings)
	}) as unknown as PluginContext;

describe('ExaSearchPlugin', () => {
	let plugin: ExaSearchPlugin;

	beforeEach(() => {
		vi.clearAllMocks();
		plugin = new ExaSearchPlugin();
	});

	describe('metadata', () => {
		it('exposes stable identity fields', () => {
			expect(plugin.id).toBe('exa');
			expect(plugin.name).toBe('Exa');
			expect(plugin.version).toBe('1.0.0');
			expect(plugin.category).toBe('search');
			expect(plugin.providerName).toBe('Exa');
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
			expect(props.apiKey['x-envVar']).toBe('PLUGIN_EXA_API_KEY');
			expect(props.apiKey['x-scope']).toBe('user');
		});

		it('exposes searchType, maxResults, and category settings with bounds', () => {
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.searchType.enum).toEqual(['auto', 'neural', 'keyword']);
			expect(props.searchType.default).toBe('auto');
			expect(props.maxResults.default).toBe(10);
			expect(props.maxResults.minimum).toBe(1);
			expect(props.maxResults.maximum).toBe(100);
			expect(props.category.enum).toContain('research paper');
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
			expect(ExaCtorMock).not.toHaveBeenCalled();
		});

		it('maps SDK results to SearchResult shape', async () => {
			searchMock.mockResolvedValueOnce({
				results: [
					{
						title: 'Example',
						url: 'https://example.com',
						publishedDate: '2026-01-01',
						author: 'Alice',
						favicon: 'https://example.com/favicon.ico'
					}
				]
			});
			const r = await plugin.search(opts());

			expect(ExaCtorMock).toHaveBeenCalledWith('k');
			expect(r.results).toHaveLength(1);
			expect(r.results[0]).toMatchObject({
				title: 'Example',
				url: 'https://example.com',
				publishedDate: '2026-01-01',
				source: 'Alice',
				faviconUrl: 'https://example.com/favicon.ico',
				position: 1
			});
		});

		it('forwards numResults from limit then maxResults setting then default', async () => {
			searchMock.mockResolvedValueOnce({ results: [] });
			await plugin.search(opts({ limit: 7 }));
			expect(searchMock.mock.calls[0][1]).toMatchObject({ numResults: 7, type: 'auto' });

			searchMock.mockResolvedValueOnce({ results: [] });
			await plugin.search(opts({ settings: { apiKey: 'k', maxResults: 25 } }));
			expect(searchMock.mock.calls[1][1]).toMatchObject({ numResults: 25 });

			searchMock.mockResolvedValueOnce({ results: [] });
			await plugin.search(opts());
			expect(searchMock.mock.calls[2][1]).toMatchObject({ numResults: 10 });
		});

		it('forwards include/excludeDomains and category', async () => {
			searchMock.mockResolvedValueOnce({ results: [] });
			await plugin.search(
				opts({
					includeDomains: ['a.com'],
					excludeDomains: ['b.com'],
					settings: { apiKey: 'k', category: 'research paper' }
				})
			);
			expect(searchMock.mock.calls[0][1]).toMatchObject({
				includeDomains: ['a.com'],
				excludeDomains: ['b.com'],
				category: 'research paper'
			});
		});

		it('translates timeRange into startPublishedDate ISO string', async () => {
			searchMock.mockResolvedValueOnce({ results: [] });
			await plugin.search(opts({ timeRange: 'week' }));
			const call = searchMock.mock.calls[0][1];
			expect(call.startPublishedDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});

		it('skips date filter when timeRange is "all"', async () => {
			searchMock.mockResolvedValueOnce({ results: [] });
			await plugin.search(opts({ timeRange: 'all' }));
			expect(searchMock.mock.calls[0][1].startPublishedDate).toBeUndefined();
		});

		it('forwards the configured searchType (neural/keyword)', async () => {
			searchMock.mockResolvedValueOnce({ results: [] });
			await plugin.search(opts({ settings: { apiKey: 'k', searchType: 'neural' } }));
			expect(searchMock.mock.calls[0][1]).toMatchObject({ type: 'neural' });
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

		it('returns success with text and word count', async () => {
			getContentsMock.mockResolvedValueOnce({
				results: [{ url: 'https://example.com/post', title: 'Title', text: 'one two three' }]
			});
			const r = await plugin.extract(opts());
			expect(r.success).toBe(true);
			expect(r.title).toBe('Title');
			expect(r.content).toBe('one two three');
			expect(r.wordCount).toBe(3);
		});

		it('exposes finalUrl when SDK returns a different URL', async () => {
			getContentsMock.mockResolvedValueOnce({
				results: [{ url: 'https://example.com/redirected', title: 't', text: 'a' }]
			});
			const r = await plugin.extract(opts());
			expect(r.finalUrl).toBe('https://example.com/redirected');
		});

		it('returns failure when no results are produced', async () => {
			getContentsMock.mockResolvedValueOnce({ results: [] });
			const r = await plugin.extract(opts());
			expect(r.success).toBe(false);
			expect(r.error).toMatch(/No content extracted/);
		});

		it('returns failure when SDK throws', async () => {
			getContentsMock.mockRejectedValueOnce(new Error('extract failed'));
			const r = await plugin.extract(opts());
			expect(r.success).toBe(false);
			expect(r.error).toMatch(/extract failed/);
		});
	});

	describe('extractBatch', () => {
		it('maps results back to requested URLs by index', async () => {
			getContentsMock.mockResolvedValueOnce({
				results: [
					{ url: 'https://a.example', title: 'A', text: 'one two' },
					{ url: 'https://b.example', title: 'B', text: 'three four five' }
				]
			});
			const r = await plugin.extractBatch(['https://a.example', 'https://b.example'], {
				settings: { apiKey: 'k' }
			});
			expect(r).toHaveLength(2);
			expect(r[0]).toMatchObject({ success: true, url: 'https://a.example', wordCount: 2 });
			expect(r[1]).toMatchObject({ success: true, url: 'https://b.example', wordCount: 3 });
		});

		it('returns per-URL failures when the batch call throws', async () => {
			getContentsMock.mockRejectedValueOnce(new Error('batch failed'));
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

		it('exposes only the text format', () => {
			expect(plugin.getSupportedFormats()).toEqual(['text']);
		});
	});

	describe('lifecycle', () => {
		it('logs on load and clears context on unload', async () => {
			const ctx = buildContext();
			await plugin.onLoad(ctx);
			expect(ctx.logger.log).toHaveBeenCalledWith('Exa Plugin loaded');
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
			expect(m.id).toBe('exa');
			expect(m.category).toBe('search');
			expect(m.capabilities).toEqual(['search', 'content-extractor']);
			expect(m.builtIn).toBe(true);
		});
	});
});
