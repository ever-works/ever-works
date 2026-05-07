import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LinkupSearchPlugin } from '../linkup.plugin.js';
import type { PluginContext, SearchOptions, ContentExtractionOptions } from '@ever-works/plugin';

const buildContext = (settings: Record<string, unknown> = {}): PluginContext =>
	({
		pluginId: 'linkup',
		logger: {
			log: vi.fn(),
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn()
		},
		getSettings: vi.fn().mockResolvedValue(settings)
	}) as unknown as PluginContext;

const okResponse = (body: unknown): Response =>
	({
		ok: true,
		status: 200,
		json: () => Promise.resolve(body),
		text: () => Promise.resolve(JSON.stringify(body))
	}) as unknown as Response;

const errResponse = (status: number, body = 'error'): Response =>
	({
		ok: false,
		status,
		json: () => Promise.resolve({ error: body }),
		text: () => Promise.resolve(body)
	}) as unknown as Response;

describe('LinkupSearchPlugin', () => {
	let plugin: LinkupSearchPlugin;
	let fetchMock: ReturnType<typeof vi.fn>;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		plugin = new LinkupSearchPlugin();
		fetchMock = vi.fn();
		globalThis.fetch = fetchMock as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.clearAllMocks();
	});

	describe('metadata', () => {
		it('exposes stable identity fields', () => {
			expect(plugin.id).toBe('linkup');
			expect(plugin.name).toBe('Linkup');
			expect(plugin.category).toBe('search');
			expect(plugin.providerName).toBe('Linkup');
			expect(plugin.version).toBe('1.0.0');
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
			expect(props.apiKey['x-envVar']).toBe('PLUGIN_LINKUP_API_KEY');
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
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('returns mapped results from data.results on success', async () => {
			fetchMock.mockResolvedValueOnce(
				okResponse({
					results: [
						{ name: 'Result A', url: 'https://a.example', content: 'snippet a' },
						{ name: 'Result B', url: 'https://b.example', content: 'snippet b' }
					]
				})
			);
			const r = await plugin.search(opts());
			expect(r.results).toHaveLength(2);
			expect(r.results[0]).toMatchObject({
				title: 'Result A',
				url: 'https://a.example',
				snippet: 'snippet a',
				position: 1
			});
			expect(r.totalResults).toBe(2);
			expect(r.hasMore).toBe(false);
			expect(typeof r.duration).toBe('number');
		});

		it('falls back to data.sources when results is missing', async () => {
			fetchMock.mockResolvedValueOnce(
				okResponse({
					sources: [{ name: 'Source A', url: 'https://s.example', snippet: 'src snippet' }]
				})
			);
			const r = await plugin.search(opts());
			expect(r.results).toHaveLength(1);
			expect(r.results[0]).toMatchObject({
				title: 'Source A',
				url: 'https://s.example',
				snippet: 'src snippet'
			});
		});

		it('forwards Bearer apiKey and JSON body with includeDomains/excludeDomains', async () => {
			fetchMock.mockResolvedValueOnce(okResponse({ results: [] }));
			await plugin.search(
				opts({
					includeDomains: ['a.com'],
					excludeDomains: ['b.com']
				})
			);
			const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(url).toBe('https://api.linkup.so/v1/search');
			expect(init.method).toBe('POST');
			expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
			const body = JSON.parse(init.body as string);
			expect(body.q).toBe('hello');
			expect(body.depth).toBe('deep');
			expect(body.outputType).toBe('searchResults');
			expect(body.includeDomains).toEqual(['a.com']);
			expect(body.excludeDomains).toEqual(['b.com']);
		});

		it('throws and logs when the upstream returns non-OK', async () => {
			await plugin.onLoad(buildContext());
			fetchMock.mockResolvedValueOnce(errResponse(500, 'oops'));
			await expect(plugin.search(opts())).rejects.toThrow(/Linkup search failed with status 500/);
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
		it('fails fast without an apiKey', async () => {
			const r = await plugin.validateConnection({});
			expect(r.success).toBe(false);
			expect(r.message).toMatch(/not configured/i);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('returns success on a 200 response', async () => {
			fetchMock.mockResolvedValueOnce(okResponse({ results: [] }));
			const r = await plugin.validateConnection({ apiKey: 'k' });
			expect(r.success).toBe(true);
		});

		it('returns failure on a non-OK response', async () => {
			fetchMock.mockResolvedValueOnce(errResponse(401, 'unauthorized'));
			const r = await plugin.validateConnection({ apiKey: 'k' });
			expect(r.success).toBe(false);
			expect(r.message).toMatch(/401/);
		});

		it('returns failure when fetch throws', async () => {
			fetchMock.mockRejectedValueOnce(new Error('network down'));
			const r = await plugin.validateConnection({ apiKey: 'k' });
			expect(r.success).toBe(false);
			expect(r.message).toMatch(/network down/);
		});
	});

	describe('getRateLimitInfo', () => {
		it('reports the documented Linkup rate limit', async () => {
			const info = await plugin.getRateLimitInfo();
			expect(info.remaining).toBe(-1);
			expect(info.limit).toBe(10);
			expect(info.period).toBe('second');
		});
	});

	describe('extract', () => {
		const opts = (overrides: Partial<ContentExtractionOptions> = {}): ContentExtractionOptions => ({
			url: 'https://example.com/post',
			settings: { apiKey: 'k' },
			...overrides
		});

		it('returns success with markdown and word count', async () => {
			fetchMock.mockResolvedValueOnce(okResponse({ markdown: 'one two three' }));
			const r = await plugin.extract(opts());
			expect(r.success).toBe(true);
			expect(r.url).toBe('https://example.com/post');
			expect(r.markdown).toBe('one two three');
			expect(r.wordCount).toBe(3);
		});

		it('returns failure when markdown is missing', async () => {
			fetchMock.mockResolvedValueOnce(okResponse({}));
			const r = await plugin.extract(opts());
			expect(r.success).toBe(false);
			expect(r.error).toMatch(/No content extracted/);
		});

		it('returns failure on a non-OK fetch response', async () => {
			fetchMock.mockResolvedValueOnce(errResponse(503, 'unavailable'));
			const r = await plugin.extract(opts());
			expect(r.success).toBe(false);
			expect(r.error).toMatch(/Linkup fetch failed with status 503/);
		});

		it('returns failure when fetch throws', async () => {
			fetchMock.mockRejectedValueOnce(new Error('boom'));
			const r = await plugin.extract(opts());
			expect(r.success).toBe(false);
			expect(r.error).toMatch(/boom/);
		});
	});

	describe('extractBatch', () => {
		it('runs each URL through extract', async () => {
			fetchMock
				.mockResolvedValueOnce(okResponse({ markdown: 'a' }))
				.mockResolvedValueOnce(okResponse({ markdown: 'b' }));
			const r = await plugin.extractBatch(['https://a', 'https://b'], { settings: { apiKey: 'k' } });
			expect(r).toHaveLength(2);
			expect(r[0].success).toBe(true);
			expect(r[1].success).toBe(true);
		});
	});

	describe('canExtract / getSupportedFormats', () => {
		it('accepts http and https URLs', async () => {
			expect(await plugin.canExtract('https://example.com')).toBe(true);
			expect(await plugin.canExtract('http://example.com')).toBe(true);
		});

		it('rejects non-http schemes and invalid URLs', async () => {
			expect(await plugin.canExtract('ftp://example.com')).toBe(false);
			expect(await plugin.canExtract('not a url')).toBe(false);
		});

		it('exposes text + markdown formats', () => {
			expect(plugin.getSupportedFormats()).toEqual(['text', 'markdown']);
		});
	});

	describe('lifecycle', () => {
		it('logs on load and clears context on unload', async () => {
			const ctx = buildContext();
			await plugin.onLoad(ctx);
			expect(ctx.logger.log).toHaveBeenCalledWith('Linkup Plugin loaded');
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
			expect(m.id).toBe('linkup');
			expect(m.category).toBe('search');
			expect(m.capabilities).toEqual(['search', 'content-extractor']);
			expect(m.builtIn).toBe(true);
			expect(m.systemPlugin).toBe(false);
			expect(m.autoEnable).toBe(false);
		});
	});
});
