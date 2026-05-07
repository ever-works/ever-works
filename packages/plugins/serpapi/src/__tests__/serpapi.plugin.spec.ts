import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SerpApiSearchPlugin } from '../serpapi.plugin.js';
import type { PluginContext, SearchOptions } from '@ever-works/plugin';

const buildContext = (settings: Record<string, unknown> = {}): PluginContext =>
	({
		pluginId: 'serpapi',
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

describe('SerpApiSearchPlugin', () => {
	let plugin: SerpApiSearchPlugin;
	let fetchMock: ReturnType<typeof vi.fn>;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		plugin = new SerpApiSearchPlugin();
		fetchMock = vi.fn();
		globalThis.fetch = fetchMock as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.clearAllMocks();
	});

	describe('metadata', () => {
		it('exposes stable identity fields', () => {
			expect(plugin.id).toBe('serpapi');
			expect(plugin.name).toBe('SerpAPI');
			expect(plugin.version).toBe('1.0.0');
			expect(plugin.category).toBe('search');
			expect(plugin.providerName).toBe('SerpAPI');
		});

		it('declares only the search capability', () => {
			expect(plugin.capabilities).toEqual(['search']);
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
			expect(props.apiKey['x-envVar']).toBe('PLUGIN_SERPAPI_API_KEY');
		});

		it('exposes engine enum and maxResults bounds', () => {
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.engine.enum).toEqual(['google', 'bing', 'yahoo', 'duckduckgo', 'baidu', 'yandex']);
			expect(props.engine.default).toBe('google');
			expect(props.maxResults.default).toBe(10);
			expect(props.maxResults.minimum).toBe(1);
			expect(props.maxResults.maximum).toBe(100);
		});
	});

	const samplePayload = {
		organic_results: [
			{
				title: 'Example',
				link: 'https://example.com',
				snippet: 'Example snippet',
				displayed_link: 'example.com',
				favicon: 'https://example.com/favicon.ico',
				source: 'example.com',
				position: 1,
				date: '2026-01-01'
			}
		],
		related_searches: [{ query: 'related one' }],
		serpapi_pagination: { next: 'https://serpapi.com/...' }
	};

	describe('search', () => {
		const opts = (overrides: Partial<SearchOptions> = {}): SearchOptions => ({
			query: 'hello',
			settings: { apiKey: 'k' },
			...overrides
		});

		it('throws when apiKey is missing', async () => {
			await expect(plugin.search({ query: 'hello', settings: {} })).rejects.toThrow(/API key not configured/i);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('returns mapped results, related searches, and pagination', async () => {
			fetchMock.mockResolvedValueOnce(okResponse(samplePayload));
			const r = await plugin.search(opts({ limit: 5 }));

			expect(r.results).toHaveLength(1);
			expect(r.results[0]).toMatchObject({
				title: 'Example',
				url: 'https://example.com',
				snippet: 'Example snippet',
				displayUrl: 'example.com',
				faviconUrl: 'https://example.com/favicon.ico',
				source: 'example.com',
				position: 1,
				publishedDate: '2026-01-01'
			});
			expect(r.relatedSearches).toEqual(['related one']);
			expect(r.hasMore).toBe(true);
			expect(r.nextPage).toBe(2);

			const url = new URL(fetchMock.mock.calls[0][0] as string);
			expect(url.searchParams.get('engine')).toBe('google');
			expect(url.searchParams.get('q')).toBe('hello');
			expect(url.searchParams.get('api_key')).toBe('k');
			expect(url.searchParams.get('num')).toBe('5');
		});

		it('uses configured engine and maxResults from settings', async () => {
			fetchMock.mockResolvedValueOnce(okResponse({ organic_results: [] }));
			await plugin.search(opts({ settings: { apiKey: 'k', engine: 'bing', maxResults: 25 } }));
			const url = new URL(fetchMock.mock.calls[0][0] as string);
			expect(url.searchParams.get('engine')).toBe('bing');
			expect(url.searchParams.get('num')).toBe('25');
		});

		it('builds site: and filetype: prefixes into the query', async () => {
			fetchMock.mockResolvedValueOnce(okResponse({ organic_results: [] }));
			await plugin.search(opts({ site: 'example.com', fileType: 'pdf' }));
			const url = new URL(fetchMock.mock.calls[0][0] as string);
			expect(url.searchParams.get('q')).toBe('filetype:pdf site:example.com hello');
		});

		it('encodes pagination via start parameter', async () => {
			fetchMock.mockResolvedValueOnce(okResponse({ organic_results: [] }));
			await plugin.search(opts({ limit: 10, page: 4 }));
			const url = new URL(fetchMock.mock.calls[0][0] as string);
			expect(url.searchParams.get('start')).toBe('30');
		});

		it('forwards region (gl), language (hl), and safe-search mapping', async () => {
			fetchMock.mockResolvedValueOnce(okResponse({ organic_results: [] }));
			await plugin.search(
				opts({
					region: 'us',
					language: 'en',
					safeSearch: 'strict'
				})
			);
			const url = new URL(fetchMock.mock.calls[0][0] as string);
			expect(url.searchParams.get('gl')).toBe('us');
			expect(url.searchParams.get('hl')).toBe('en');
			expect(url.searchParams.get('safe')).toBe('active');
		});

		it('throws and logs when the upstream returns non-OK', async () => {
			await plugin.onLoad(buildContext());
			fetchMock.mockResolvedValueOnce(errResponse(500, 'oops'));
			await expect(plugin.search(opts())).rejects.toThrow(/SerpAPI request failed \(500\)/);
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
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('returns success on a 200 response', async () => {
			fetchMock.mockResolvedValueOnce(okResponse({ organic_results: [] }));
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
			fetchMock.mockRejectedValueOnce(new Error('boom'));
			const r = await plugin.validateConnection({ apiKey: 'k' });
			expect(r.success).toBe(false);
			expect(r.message).toMatch(/boom/);
		});
	});

	describe('getRateLimitInfo', () => {
		it('returns sentinel values', async () => {
			const info = await plugin.getRateLimitInfo();
			expect(info.remaining).toBe(-1);
			expect(info.limit).toBe(-1);
			expect(info.period).toBe('month');
		});
	});

	describe('lifecycle', () => {
		it('logs on load and clears context on unload', async () => {
			const ctx = buildContext();
			await plugin.onLoad(ctx);
			expect(ctx.logger.log).toHaveBeenCalledWith('SerpAPI Plugin loaded');
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
			expect(m.id).toBe('serpapi');
			expect(m.category).toBe('search');
			expect(m.capabilities).toEqual(['search']);
			expect(m.builtIn).toBe(true);
		});
	});
});
