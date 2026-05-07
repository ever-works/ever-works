import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TavilySearchPlugin } from '../tavily.plugin.js';
import type { PluginContext, SearchOptions, ContentExtractionOptions } from '@ever-works/plugin';

const searchMock = vi.fn();
const extractMock = vi.fn();
const tavilyFactoryMock = vi.fn(() => ({
	search: searchMock,
	extract: extractMock
}));

vi.mock('@tavily/core', () => ({
	tavily: (opts: { apiKey: string }) => tavilyFactoryMock(opts)
}));

const buildContext = (settings: Record<string, unknown> = {}): PluginContext =>
	({
		pluginId: 'tavily',
		logger: {
			log: vi.fn(),
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn()
		},
		getSettings: vi.fn().mockResolvedValue(settings)
	}) as unknown as PluginContext;

describe('TavilySearchPlugin', () => {
	let plugin: TavilySearchPlugin;

	beforeEach(() => {
		vi.clearAllMocks();
		plugin = new TavilySearchPlugin();
	});

	describe('metadata', () => {
		it('exposes stable identity fields', () => {
			expect(plugin.id).toBe('tavily');
			expect(plugin.name).toBe('Tavily');
			expect(plugin.version).toBe('1.0.0');
			expect(plugin.category).toBe('search');
			expect(plugin.providerName).toBe('Tavily');
		});

		it('declares both search and content-extractor capabilities', () => {
			expect(plugin.capabilities).toEqual(['search', 'content-extractor']);
		});

		it('uses hybrid configuration mode', () => {
			expect(plugin.configurationMode).toBe('hybrid');
		});
	});

	describe('settingsSchema', () => {
		it('requires apiKey and marks it as a user-scoped secret', () => {
			expect(plugin.settingsSchema.required).toContain('apiKey');
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.apiKey['x-secret']).toBe(true);
			expect(props.apiKey['x-scope']).toBe('user');
			expect(props.apiKey['x-envVar']).toBe('PLUGIN_TAVILY_API_KEY');
		});
	});

	describe('search', () => {
		const opts = (overrides: Partial<SearchOptions> = {}): SearchOptions => ({
			query: 'hello',
			settings: { apiKey: 'k' },
			...overrides
		});

		it('throws when apiKey is missing', async () => {
			await expect(plugin.search({ query: 'hello', settings: {} })).rejects.toThrow(
				/API key not configured/i
			);
			expect(tavilyFactoryMock).not.toHaveBeenCalled();
		});

		it('maps SDK results to SearchResult shape', async () => {
			searchMock.mockResolvedValueOnce({
				results: [
					{
						title: 'Example',
						url: 'https://example.com',
						content: 'content snippet',
						score: 0.9,
						publishedDate: '2026-01-01',
						rawContent: 'raw'
					}
				]
			});
			const r = await plugin.search(opts());

			expect(tavilyFactoryMock).toHaveBeenCalledWith({ apiKey: 'k' });
			expect(r.results).toHaveLength(1);
			expect(r.results[0]).toMatchObject({
				title: 'Example',
				url: 'https://example.com',
				snippet: 'content snippet',
				position: 1,
				publishedDate: '2026-01-01'
			});
			expect(r.results[0].metadata).toMatchObject({ score: 0.9, rawContent: 'raw' });
			expect(r.totalResults).toBe(1);
			expect(r.hasMore).toBe(false);
			expect(typeof r.duration).toBe('number');
		});

		it('forwards limit (default 20), include/excludeDomains, and advanced depth', async () => {
			searchMock.mockResolvedValueOnce({ results: [] });
			await plugin.search(
				opts({
					limit: 5,
					includeDomains: ['a.com'],
					excludeDomains: ['b.com']
				})
			);
			expect(searchMock).toHaveBeenCalledWith('hello', {
				searchDepth: 'advanced',
				maxResults: 5,
				includeDomains: ['a.com'],
				excludeDomains: ['b.com']
			});
		});

		it('uses default maxResults=20 when limit is omitted', async () => {
			searchMock.mockResolvedValueOnce({ results: [] });
			await plugin.search(opts());
			expect(searchMock.mock.calls[0][1]).toMatchObject({ maxResults: 20 });
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
			extractMock.mockResolvedValueOnce({
				results: [{ url: 'https://example.com/post', rawContent: 'one two three four' }]
			});
			const r = await plugin.extract(opts());
			expect(r.success).toBe(true);
			expect(r.markdown).toBe('one two three four');
			expect(r.wordCount).toBe(4);
		});

		it('exposes finalUrl when SDK returns a different URL', async () => {
			extractMock.mockResolvedValueOnce({
				results: [{ url: 'https://example.com/redirected', rawContent: 'body' }]
			});
			const r = await plugin.extract(opts());
			expect(r.finalUrl).toBe('https://example.com/redirected');
		});

		it('returns failure when no results are produced', async () => {
			extractMock.mockResolvedValueOnce({ results: [] });
			const r = await plugin.extract(opts());
			expect(r.success).toBe(false);
			expect(r.error).toMatch(/No content extracted/);
		});

		it('returns failure when SDK throws', async () => {
			extractMock.mockRejectedValueOnce(new Error('extract failed'));
			const r = await plugin.extract(opts());
			expect(r.success).toBe(false);
			expect(r.error).toMatch(/extract failed/);
		});
	});

	describe('extractBatch', () => {
		it('maps results back to requested URLs by index', async () => {
			extractMock.mockResolvedValueOnce({
				results: [
					{ url: 'https://a.example', rawContent: 'one two' },
					{ url: 'https://b.example', rawContent: 'three four five' }
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
			extractMock.mockRejectedValueOnce(new Error('batch failed'));
			const r = await plugin.extractBatch(['https://a.example', 'https://b.example'], {
				settings: { apiKey: 'k' }
			});
			expect(r).toHaveLength(2);
			expect(r.every((x) => x.success === false)).toBe(true);
			expect(r[0].error).toMatch(/batch failed/);
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
			expect(ctx.logger.log).toHaveBeenCalledWith('Tavily Plugin loaded');
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
			expect(m.id).toBe('tavily');
			expect(m.category).toBe('search');
			expect(m.capabilities).toEqual(['search', 'content-extractor']);
			expect(m.builtIn).toBe(true);
			expect(m.systemPlugin).toBe(true);
			expect(m.autoEnable).toBe(true);
			expect(m.defaultForCapabilities).toContain('search');
		});
	});
});
