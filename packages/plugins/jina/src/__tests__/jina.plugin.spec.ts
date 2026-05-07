import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JinaReaderPlugin } from '../jina.plugin.js';
import type { PluginContext, SearchOptions, ContentExtractionOptions } from '@ever-works/plugin';

const buildContext = (settings: Record<string, unknown> = {}): PluginContext =>
	({
		pluginId: 'jina',
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
		statusText: 'OK',
		json: () => Promise.resolve(body),
		text: () => Promise.resolve(JSON.stringify(body))
	}) as unknown as Response;

const errResponse = (status: number, statusText = 'error'): Response =>
	({
		ok: false,
		status,
		statusText,
		json: () => Promise.resolve({}),
		text: () => Promise.resolve(statusText)
	}) as unknown as Response;

describe('JinaReaderPlugin', () => {
	let plugin: JinaReaderPlugin;
	let fetchMock: ReturnType<typeof vi.fn>;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		plugin = new JinaReaderPlugin();
		fetchMock = vi.fn();
		globalThis.fetch = fetchMock as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.clearAllMocks();
	});

	describe('metadata', () => {
		it('exposes stable identity fields', () => {
			expect(plugin.id).toBe('jina');
			expect(plugin.name).toBe('Jina AI');
			expect(plugin.version).toBe('1.0.0');
			expect(plugin.category).toBe('content-extractor');
			expect(plugin.providerName).toBe('Jina');
		});

		it('declares both search and content-extractor capabilities', () => {
			expect(plugin.capabilities).toEqual(['search', 'content-extractor']);
		});
	});

	describe('settingsSchema', () => {
		it('requires apiKey and marks it as user-scoped secret', () => {
			expect(plugin.settingsSchema.required).toContain('apiKey');
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.apiKey['x-secret']).toBe(true);
			expect(props.apiKey['x-envVar']).toBe('PLUGIN_JINA_API_KEY');
		});
	});

	describe('search', () => {
		const opts = (overrides: Partial<SearchOptions> = {}): SearchOptions => ({
			query: 'hello',
			settings: { apiKey: 'k' },
			...overrides
		});

		it('returns mapped results with derived hostname source', async () => {
			fetchMock.mockResolvedValueOnce(
				okResponse({
					data: [
						{
							title: 'Example',
							url: 'https://www.example.com/post',
							description: 'snippet here',
							date: '2026-01-01'
						}
					]
				})
			);

			const r = await plugin.search(opts({ limit: 5, region: 'us', language: 'en' }));

			expect(r.results).toHaveLength(1);
			expect(r.results[0]).toMatchObject({
				title: 'Example',
				url: 'https://www.example.com/post',
				snippet: 'snippet here',
				position: 1,
				publishedDate: '2026-01-01',
				source: 'www.example.com'
			});

			const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(url).toBe('https://s.jina.ai/');
			expect(init.method).toBe('POST');
			expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
			const body = JSON.parse(init.body as string);
			expect(body.q).toBe('hello');
			expect(body.num).toBe(5);
			expect(body.gl).toBe('us');
			expect(body.hl).toBe('en');
		});

		it('forwards X-Site header for the first includeDomain', async () => {
			fetchMock.mockResolvedValueOnce(okResponse({ data: [] }));
			await plugin.search(opts({ includeDomains: ['a.com', 'b.com'] }));
			const init = fetchMock.mock.calls[0][1] as RequestInit;
			expect((init.headers as Record<string, string>)['X-Site']).toBe('a.com');
		});

		it('handles missing data array safely', async () => {
			fetchMock.mockResolvedValueOnce(okResponse({}));
			const r = await plugin.search(opts());
			expect(r.results).toEqual([]);
			expect(r.totalResults).toBe(0);
		});

		it('throws and logs on non-OK upstream', async () => {
			await plugin.onLoad(buildContext());
			fetchMock.mockResolvedValueOnce(errResponse(503, 'Service Unavailable'));
			await expect(plugin.search(opts())).rejects.toThrow(/Jina Search API returned 503/);
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
			fetchMock.mockResolvedValueOnce(okResponse({ data: [] }));
			const r = await plugin.validateConnection({ apiKey: 'k' });
			expect(r.success).toBe(true);
		});

		it('returns failure on a non-OK response', async () => {
			fetchMock.mockResolvedValueOnce(errResponse(401, 'Unauthorized'));
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

	describe('extract', () => {
		const opts = (overrides: Partial<ContentExtractionOptions> = {}): ContentExtractionOptions => ({
			url: 'https://example.com/post',
			settings: { apiKey: 'k' },
			...overrides
		});

		it('returns success with title, content, images, links, metadata, wordCount, readingTime', async () => {
			fetchMock.mockResolvedValueOnce(
				okResponse({
					data: {
						title: 'Title',
						url: 'https://example.com/post',
						content: 'one two three four five',
						description: 'desc',
						publishedTime: '2026-01-01',
						images: { 'alt one': 'https://img/1.png' },
						links: { 'link one': 'https://target.example' },
						metadata: { lang: 'en' }
					}
				})
			);

			const r = await plugin.extract(opts());
			expect(r.success).toBe(true);
			expect(r.title).toBe('Title');
			expect(r.markdown).toBe('one two three four five');
			expect(r.wordCount).toBe(5);
			expect(r.readingTime).toBe(1);
			expect(r.images).toHaveLength(1);
			expect(r.images?.[0]).toMatchObject({ src: 'https://img/1.png', alt: 'alt one' });
			expect(r.links?.[0]).toMatchObject({ href: 'https://target.example', text: 'link one' });
			expect(r.metadata).toMatchObject({
				description: 'desc',
				publishedDate: '2026-01-01',
				language: 'en'
			});
		});

		it('exposes finalUrl when SDK returns a different URL', async () => {
			fetchMock.mockResolvedValueOnce(
				okResponse({
					data: {
						title: 't',
						url: 'https://example.com/redirected',
						content: 'hi'
					}
				})
			);
			const r = await plugin.extract(opts());
			expect(r.finalUrl).toBe('https://example.com/redirected');
		});

		it('returns failure when content is missing', async () => {
			fetchMock.mockResolvedValueOnce(okResponse({ data: { title: 't', url: 'u' } }));
			const r = await plugin.extract(opts());
			expect(r.success).toBe(false);
			expect(r.error).toMatch(/No content/);
		});

		it('returns failure when upstream returns non-OK', async () => {
			fetchMock.mockResolvedValueOnce(errResponse(429, 'Too Many Requests'));
			const r = await plugin.extract(opts());
			expect(r.success).toBe(false);
			expect(r.error).toMatch(/429/);
		});

		it('omits images when includeImages is false', async () => {
			fetchMock.mockResolvedValueOnce(
				okResponse({
					data: {
						title: 't',
						url: 'u',
						content: 'hi',
						images: { foo: 'https://i' }
					}
				})
			);
			const r = await plugin.extract(opts({ includeImages: false }));
			expect(r.images).toBeUndefined();
		});
	});

	describe('extractBatch', () => {
		it('chunks URLs into batches of 5', async () => {
			const urls = Array.from({ length: 7 }, (_, i) => `https://example.com/${i}`);
			for (const u of urls) {
				fetchMock.mockResolvedValueOnce(okResponse({ data: { title: 't', url: u, content: 'a b' } }));
			}
			const r = await plugin.extractBatch(urls, { settings: { apiKey: 'k' } });
			expect(r).toHaveLength(7);
			expect(r.every((x) => x.success === true)).toBe(true);
			expect(fetchMock).toHaveBeenCalledTimes(7);
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
			expect(ctx.logger.log).toHaveBeenCalledWith('Jina AI Reader Plugin loaded');
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
			expect(m.id).toBe('jina');
			expect(m.category).toBe('content-extractor');
			expect(m.capabilities).toEqual(['search', 'content-extractor']);
			expect(m.builtIn).toBe(true);
		});
	});
});
