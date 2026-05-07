import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginContext, SearchOptions, ContentExtractionOptions } from '@ever-works/plugin';

const { searchMock, scrapeMock, BdClientCtorMock } = vi.hoisted(() => {
	const search = vi.fn();
	const scrape = vi.fn();
	const ctor = vi.fn().mockImplementation(() => ({ search, scrape }));
	return { searchMock: search, scrapeMock: scrape, BdClientCtorMock: ctor };
});

vi.mock('@brightdata/sdk', () => ({
	bdclient: BdClientCtorMock
}));

const { BrightDataPlugin } = await import('../brightdata.plugin.js');

const buildContext = (settings: Record<string, unknown> = {}): PluginContext =>
	({
		pluginId: 'brightdata',
		logger: {
			log: vi.fn(),
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn()
		},
		getSettings: vi.fn().mockResolvedValue(settings)
	}) as unknown as PluginContext;

describe('BrightDataPlugin', () => {
	let plugin: BrightDataPlugin;

	beforeEach(() => {
		vi.clearAllMocks();
		plugin = new BrightDataPlugin();
	});

	describe('metadata', () => {
		it('exposes stable identity fields', () => {
			expect(plugin.id).toBe('brightdata');
			expect(plugin.name).toBe('Bright Data');
			expect(plugin.version).toBe('1.0.0');
			expect(plugin.category).toBe('search');
			expect(plugin.providerName).toBe('Bright Data');
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
			expect(props.apiKey['x-envVar']).toBe('PLUGIN_BRIGHTDATA_API_KEY');
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
			expect(BdClientCtorMock).not.toHaveBeenCalled();
		});

		it('parses parsed.organic[] and maps results', async () => {
			searchMock.mockResolvedValueOnce({
				body: JSON.stringify({
					organic: [
						{
							title: 'Example',
							url: 'https://www.example.com/post',
							description: 'snippet'
						}
					]
				})
			});
			const r = await plugin.search(opts());
			expect(r.results).toHaveLength(1);
			expect(r.results[0]).toMatchObject({
				title: 'Example',
				url: 'https://www.example.com/post',
				snippet: 'snippet',
				position: 1,
				source: 'www.example.com'
			});
		});

		it('falls back to parsed.results then top-level array', async () => {
			searchMock.mockResolvedValueOnce({
				body: JSON.stringify({
					results: [{ title: 'A', link: 'https://a', snippet: 's' }]
				})
			});
			let r = await plugin.search(opts());
			expect(r.results[0]).toMatchObject({ title: 'A', url: 'https://a', snippet: 's' });

			searchMock.mockResolvedValueOnce({
				body: JSON.stringify([{ title: 'B', url: 'https://b', description: 's2' }])
			});
			r = await plugin.search(opts());
			expect(r.results[0]).toMatchObject({ title: 'B', url: 'https://b', snippet: 's2' });
		});

		it('warns and returns empty results when body is non-JSON', async () => {
			const ctx = buildContext();
			await plugin.onLoad(ctx);
			searchMock.mockResolvedValueOnce({ body: 'not-json' });
			const r = await plugin.search(opts());
			expect(r.results).toEqual([]);
			expect(ctx.logger.warn).toHaveBeenCalledWith('Bright Data search returned non-JSON body');
		});

		it('appends site: filters from includeDomains and -site: from excludeDomains', async () => {
			searchMock.mockResolvedValueOnce({ body: JSON.stringify({ organic: [] }) });
			await plugin.search(opts({ includeDomains: ['a.com', 'b.com'], excludeDomains: ['c.com'] }));
			expect(searchMock.mock.calls[0][0]).toBe('hello (site:a.com OR site:b.com) -site:c.com');
		});

		it('forwards country code from region', async () => {
			searchMock.mockResolvedValueOnce({ body: JSON.stringify({ organic: [] }) });
			await plugin.search(opts({ region: 'US' }));
			expect(searchMock.mock.calls[0][1]).toMatchObject({ country: 'US', format: 'json' });
		});

		it('caps the result count at the requested limit (default 20)', async () => {
			const longList = Array.from({ length: 50 }, (_, i) => ({
				title: `t${i}`,
				url: `https://x/${i}`
			}));
			searchMock.mockResolvedValueOnce({ body: JSON.stringify({ organic: longList }) });
			let r = await plugin.search(opts());
			expect(r.results).toHaveLength(20);

			searchMock.mockResolvedValueOnce({ body: JSON.stringify({ organic: longList }) });
			r = await plugin.search(opts({ limit: 5 }));
			expect(r.results).toHaveLength(5);
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
			searchMock.mockResolvedValueOnce({ body: JSON.stringify({ organic: [] }) });
			const r = await plugin.validateConnection({ apiKey: 'k' });
			expect(r.success).toBe(true);
		});

		it('returns failure when SDK throws', async () => {
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

		it('returns success with markdown, wordCount, readingTime', async () => {
			scrapeMock.mockResolvedValueOnce('one two three four five six');
			const r = await plugin.extract(opts());
			expect(scrapeMock).toHaveBeenCalledWith('https://example.com/post', { dataFormat: 'markdown' });
			expect(r.success).toBe(true);
			expect(r.markdown).toBe('one two three four five six');
			expect(r.wordCount).toBe(6);
			expect(r.readingTime).toBe(1);
		});

		it('returns failure when scrape returns empty', async () => {
			scrapeMock.mockResolvedValueOnce('');
			const r = await plugin.extract(opts());
			expect(r.success).toBe(false);
			expect(r.error).toMatch(/No content/);
		});

		it('returns failure when SDK throws', async () => {
			scrapeMock.mockRejectedValueOnce(new Error('extract failed'));
			const r = await plugin.extract(opts());
			expect(r.success).toBe(false);
			expect(r.error).toMatch(/extract failed/);
		});
	});

	describe('extractBatch', () => {
		it('maps batch responses by index, handling Error entries', async () => {
			const err = new Error('per-url failure');
			scrapeMock.mockResolvedValueOnce(['one two', err, 'three four five']);
			const r = await plugin.extractBatch(['https://a', 'https://b', 'https://c'], {
				settings: { apiKey: 'k' }
			});
			expect(r).toHaveLength(3);
			expect(r[0]).toMatchObject({ success: true, url: 'https://a', wordCount: 2 });
			expect(r[1]).toMatchObject({ success: false, url: 'https://b', error: 'per-url failure' });
			expect(r[2]).toMatchObject({ success: true, url: 'https://c', wordCount: 3 });
		});

		it('returns per-URL failures when batch call throws', async () => {
			scrapeMock.mockRejectedValueOnce(new Error('batch failed'));
			const r = await plugin.extractBatch(['https://a', 'https://b'], { settings: { apiKey: 'k' } });
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

		it('exposes text + html + markdown formats', () => {
			expect(plugin.getSupportedFormats()).toEqual(['text', 'html', 'markdown']);
		});
	});

	describe('lifecycle', () => {
		it('logs on load and clears context on unload', async () => {
			const ctx = buildContext();
			await plugin.onLoad(ctx);
			expect(ctx.logger.log).toHaveBeenCalledWith('Bright Data Plugin loaded');
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
			expect(m.id).toBe('brightdata');
			expect(m.category).toBe('search');
			expect(m.capabilities).toEqual(['search', 'content-extractor']);
			expect(m.builtIn).toBe(true);
		});
	});
});
