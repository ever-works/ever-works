import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginContext, SearchOptions } from '@ever-works/plugin';

const { searchCreateMock, PerplexityCtorMock } = vi.hoisted(() => {
	const create = vi.fn();
	const ctor = vi.fn().mockImplementation(() => ({ search: { create } }));
	return { searchCreateMock: create, PerplexityCtorMock: ctor };
});

vi.mock('@perplexity-ai/perplexity_ai', () => ({
	default: PerplexityCtorMock
}));

const { PerplexitySearchPlugin } = await import('../perplexity.plugin.js');

const buildContext = (settings: Record<string, unknown> = {}): PluginContext =>
	({
		pluginId: 'perplexity',
		logger: {
			log: vi.fn(),
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn()
		},
		getSettings: vi.fn().mockResolvedValue(settings)
	}) as unknown as PluginContext;

describe('PerplexitySearchPlugin', () => {
	let plugin: PerplexitySearchPlugin;

	beforeEach(() => {
		vi.clearAllMocks();
		plugin = new PerplexitySearchPlugin();
	});

	describe('metadata', () => {
		it('exposes stable identity fields', () => {
			expect(plugin.id).toBe('perplexity');
			expect(plugin.name).toBe('Perplexity');
			expect(plugin.version).toBe('1.0.0');
			expect(plugin.category).toBe('search');
			expect(plugin.providerName).toBe('Perplexity');
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
			expect(props.apiKey['x-envVar']).toBe('PLUGIN_PERPLEXITY_API_KEY');
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
			expect(PerplexityCtorMock).not.toHaveBeenCalled();
		});

		it('maps SDK results to SearchResult shape with derived hostname source', async () => {
			searchCreateMock.mockResolvedValueOnce({
				results: [
					{
						title: 'Example',
						url: 'https://www.example.com/page',
						snippet: 'Example snippet'
					}
				]
			});
			const r = await plugin.search(opts());

			expect(PerplexityCtorMock).toHaveBeenCalledWith({ apiKey: 'k' });
			expect(r.results).toHaveLength(1);
			expect(r.results[0]).toMatchObject({
				title: 'Example',
				url: 'https://www.example.com/page',
				snippet: 'Example snippet',
				position: 1,
				source: 'www.example.com'
			});
			expect(r.totalResults).toBe(1);
			expect(r.hasMore).toBe(false);
		});

		it('handles malformed result URLs without throwing', async () => {
			searchCreateMock.mockResolvedValueOnce({
				results: [{ title: 't', url: 'not-a-url', snippet: 's' }]
			});
			const r = await plugin.search(opts());
			expect(r.results[0].source).toBeUndefined();
		});

		it('forwards limit as max_results', async () => {
			searchCreateMock.mockResolvedValueOnce({ results: [] });
			await plugin.search(opts({ limit: 7 }));
			expect(searchCreateMock).toHaveBeenCalledWith(expect.objectContaining({ query: 'hello', max_results: 7 }));
		});

		it('uses search_domain_filter for includeDomains', async () => {
			searchCreateMock.mockResolvedValueOnce({ results: [] });
			await plugin.search(opts({ includeDomains: ['a.com', 'b.com'] }));
			expect(searchCreateMock.mock.calls[0][0]).toMatchObject({
				search_domain_filter: ['a.com', 'b.com']
			});
		});

		it('uses negated search_domain_filter for excludeDomains when no include is set', async () => {
			searchCreateMock.mockResolvedValueOnce({ results: [] });
			await plugin.search(opts({ excludeDomains: ['c.com'] }));
			expect(searchCreateMock.mock.calls[0][0]).toMatchObject({
				search_domain_filter: ['-c.com']
			});
		});

		it('forwards search_recency_filter for timeRange', async () => {
			searchCreateMock.mockResolvedValueOnce({ results: [] });
			await plugin.search(opts({ timeRange: 'week' }));
			expect(searchCreateMock.mock.calls[0][0]).toMatchObject({ search_recency_filter: 'week' });
		});

		it('omits search_recency_filter for timeRange "all"', async () => {
			searchCreateMock.mockResolvedValueOnce({ results: [] });
			await plugin.search(opts({ timeRange: 'all' }));
			expect(searchCreateMock.mock.calls[0][0].search_recency_filter).toBeUndefined();
		});

		it('logs and rethrows on SDK failure', async () => {
			const ctx = buildContext();
			await plugin.onLoad(ctx);
			searchCreateMock.mockRejectedValueOnce(new Error('boom'));
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
			searchCreateMock.mockResolvedValueOnce({ results: [] });
			const r = await plugin.validateConnection({ apiKey: 'k' });
			expect(r.success).toBe(true);
		});

		it('returns failure when SDK rejects', async () => {
			searchCreateMock.mockRejectedValueOnce(new Error('bad key'));
			const r = await plugin.validateConnection({ apiKey: 'k' });
			expect(r.success).toBe(false);
			expect(r.message).toMatch(/bad key/);
		});
	});

	describe('getRateLimitInfo', () => {
		it('returns minute-period sentinel values', async () => {
			const info = await plugin.getRateLimitInfo();
			expect(info.period).toBe('minute');
		});
	});

	describe('lifecycle', () => {
		it('logs on load and clears context on unload', async () => {
			const ctx = buildContext();
			await plugin.onLoad(ctx);
			expect(ctx.logger.log).toHaveBeenCalledWith('Perplexity Plugin loaded');
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
			expect(m.id).toBe('perplexity');
			expect(m.category).toBe('search');
			expect(m.capabilities).toEqual(['search']);
			expect(m.builtIn).toBe(true);
		});
	});
});
