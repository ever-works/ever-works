import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BraveSearchPlugin } from '../brave.plugin.js';
import type { PluginContext, SearchOptions } from '@ever-works/plugin';

const buildContext = (settings: Record<string, unknown> = {}): PluginContext =>
	({
		pluginId: 'brave',
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

const errResponse = (status: number, body = 'rate limited'): Response =>
	({
		ok: false,
		status,
		json: () => Promise.resolve({ error: body }),
		text: () => Promise.resolve(body)
	}) as unknown as Response;

describe('BraveSearchPlugin', () => {
	let plugin: BraveSearchPlugin;
	let fetchMock: ReturnType<typeof vi.fn>;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		plugin = new BraveSearchPlugin();
		fetchMock = vi.fn();
		globalThis.fetch = fetchMock as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.clearAllMocks();
	});

	describe('metadata', () => {
		it('exposes stable identity fields', () => {
			expect(plugin.id).toBe('brave');
			expect(plugin.name).toBe('Brave Search');
			expect(plugin.version).toBe('1.0.0');
			expect(plugin.category).toBe('search');
			expect(plugin.providerName).toBe('Brave');
		});

		it('declares only the search capability', () => {
			expect(plugin.capabilities).toEqual(['search']);
		});

		it('uses hybrid configuration mode', () => {
			expect(plugin.configurationMode).toBe('hybrid');
		});
	});

	describe('settingsSchema', () => {
		it('requires apiKey and marks it as a user-scoped secret', () => {
			expect(plugin.settingsSchema.type).toBe('object');
			expect(plugin.settingsSchema.required).toContain('apiKey');
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.apiKey['x-secret']).toBe(true);
			expect(props.apiKey['x-scope']).toBe('user');
			expect(props.apiKey['x-envVar']).toBe('PLUGIN_BRAVE_API_KEY');
		});

		it('exposes a maxResults setting with sane defaults and bounds', () => {
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.maxResults.type).toBe('number');
			expect(props.maxResults.default).toBe(10);
			expect(props.maxResults.minimum).toBe(1);
			expect(props.maxResults.maximum).toBe(20);
		});
	});

	describe('search', () => {
		const searchPayload = {
			web: {
				results: [
					{
						title: 'Example',
						url: 'https://example.com',
						description: 'Example domain',
						favicon: 'https://example.com/favicon.ico',
						age: '2026-01-01',
						language: 'en',
						family_friendly: true
					}
				]
			},
			query: { more_results_available: true }
		};

		it('throws when apiKey is missing', async () => {
			const opts: SearchOptions = { query: 'test', settings: {} };
			await expect(plugin.search(opts)).rejects.toThrow(/API key not configured/i);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('returns mapped results on success and propagates pagination', async () => {
			fetchMock.mockResolvedValueOnce(okResponse(searchPayload));
			const result = await plugin.search({
				query: 'hello',
				limit: 5,
				settings: { apiKey: 'k' }
			});

			expect(result.results).toHaveLength(1);
			expect(result.results[0]).toMatchObject({
				title: 'Example',
				url: 'https://example.com',
				snippet: 'Example domain',
				faviconUrl: 'https://example.com/favicon.ico',
				position: 1
			});
			expect(result.hasMore).toBe(true);
			expect(result.nextPage).toBe(2);
			expect(typeof result.duration).toBe('number');

			const url = new URL(fetchMock.mock.calls[0][0] as string);
			expect(url.searchParams.get('q')).toBe('hello');
			expect(url.searchParams.get('count')).toBe('5');
		});

		it('caps the result count at MAX_RESULTS_LIMIT (20)', async () => {
			fetchMock.mockResolvedValueOnce(okResponse({ web: { results: [] } }));
			await plugin.search({ query: 'x', limit: 999, settings: { apiKey: 'k' } });
			const url = new URL(fetchMock.mock.calls[0][0] as string);
			expect(url.searchParams.get('count')).toBe('20');
		});

		it('encodes pagination via offset', async () => {
			fetchMock.mockResolvedValueOnce(okResponse({ web: { results: [] } }));
			await plugin.search({ query: 'x', limit: 10, page: 3, settings: { apiKey: 'k' } });
			const url = new URL(fetchMock.mock.calls[0][0] as string);
			expect(url.searchParams.get('offset')).toBe('20');
		});

		it('clamps offset at MAX_PAGE_OFFSET (9)', async () => {
			fetchMock.mockResolvedValueOnce(okResponse({ web: { results: [] } }));
			await plugin.search({ query: 'x', limit: 10, page: 50, settings: { apiKey: 'k' } });
			const url = new URL(fetchMock.mock.calls[0][0] as string);
			expect(url.searchParams.get('offset')).toBe('90');
		});

		it('forwards region, language, safeSearch, and timeRange filters', async () => {
			fetchMock.mockResolvedValueOnce(okResponse({ web: { results: [] } }));
			await plugin.search({
				query: 'x',
				region: 'US',
				language: 'en',
				safeSearch: 'strict',
				timeRange: 'week',
				settings: { apiKey: 'k' }
			});
			const url = new URL(fetchMock.mock.calls[0][0] as string);
			expect(url.searchParams.get('country')).toBe('US');
			expect(url.searchParams.get('search_lang')).toBe('en');
			expect(url.searchParams.get('safesearch')).toBe('strict');
			expect(url.searchParams.get('freshness')).toBe('pw');
		});

		it('skips freshness when timeRange is "all"', async () => {
			fetchMock.mockResolvedValueOnce(okResponse({ web: { results: [] } }));
			await plugin.search({ query: 'x', timeRange: 'all', settings: { apiKey: 'k' } });
			const url = new URL(fetchMock.mock.calls[0][0] as string);
			expect(url.searchParams.has('freshness')).toBe(false);
		});

		it('sends X-Subscription-Token header with the apiKey', async () => {
			fetchMock.mockResolvedValueOnce(okResponse({ web: { results: [] } }));
			await plugin.search({ query: 'x', settings: { apiKey: 'super-secret' } });
			const init = fetchMock.mock.calls[0][1] as RequestInit;
			expect((init.headers as Record<string, string>)['X-Subscription-Token']).toBe('super-secret');
		});

		it('throws and logs when the upstream returns non-OK', async () => {
			await plugin.onLoad(buildContext());
			fetchMock.mockResolvedValueOnce(errResponse(429, 'rate limited'));
			await expect(plugin.search({ query: 'x', settings: { apiKey: 'k' } })).rejects.toThrow(
				/Brave Search request failed \(429\)/
			);
		});
	});

	describe('isAvailable', () => {
		it('returns false when context is missing', async () => {
			expect(await plugin.isAvailable()).toBe(false);
		});

		it('returns true when settings has an apiKey', async () => {
			await plugin.onLoad(buildContext({ apiKey: 'k' }));
			expect(await plugin.isAvailable()).toBe(true);
		});

		it('returns false when settings has no apiKey', async () => {
			await plugin.onLoad(buildContext({}));
			expect(await plugin.isAvailable()).toBe(false);
		});
	});

	describe('validateConnection', () => {
		it('returns failure when apiKey is missing', async () => {
			const result = await plugin.validateConnection({});
			expect(result.success).toBe(false);
			expect(result.message).toMatch(/not configured/i);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('returns success on a 200 response', async () => {
			fetchMock.mockResolvedValueOnce(okResponse({ web: { results: [] } }));
			const result = await plugin.validateConnection({ apiKey: 'k' });
			expect(result.success).toBe(true);
		});

		it('returns failure on a non-OK response', async () => {
			fetchMock.mockResolvedValueOnce(errResponse(401, 'unauthorized'));
			const result = await plugin.validateConnection({ apiKey: 'k' });
			expect(result.success).toBe(false);
			expect(result.message).toMatch(/401/);
		});

		it('returns failure when fetch throws', async () => {
			fetchMock.mockRejectedValueOnce(new Error('boom'));
			const result = await plugin.validateConnection({ apiKey: 'k' });
			expect(result.success).toBe(false);
			expect(result.message).toMatch(/boom/);
		});
	});

	describe('getRateLimitInfo', () => {
		it('returns sentinel values when not exposed by Brave', async () => {
			const info = await plugin.getRateLimitInfo();
			expect(info.remaining).toBe(-1);
			expect(info.limit).toBe(-1);
			expect(info.period).toBe('month');
		});
	});

	describe('lifecycle', () => {
		it('logs a load message and clears context on unload', async () => {
			const ctx = buildContext();
			await plugin.onLoad(ctx);
			expect(ctx.logger.log).toHaveBeenCalledWith('Brave Search Plugin loaded');
			await plugin.onUnload();
			expect(await plugin.isAvailable()).toBe(false);
		});
	});

	describe('healthCheck + manifest', () => {
		it('reports healthy', async () => {
			const h = await plugin.healthCheck();
			expect(h.status).toBe('healthy');
			expect(h.checkedAt).toBeTypeOf('number');
		});

		it('returns a manifest matching plugin metadata', () => {
			const m = plugin.getManifest();
			expect(m.id).toBe('brave');
			expect(m.category).toBe('search');
			expect(m.capabilities).toEqual(['search']);
			expect(m.builtIn).toBe(true);
			expect(m.systemPlugin).toBe(false);
			expect(m.autoEnable).toBe(false);
			expect(m.icon?.type).toBe('svg');
		});
	});
});
