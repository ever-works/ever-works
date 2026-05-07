import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PluginContext, ScreenshotOptions, ContentExtractionOptions } from '@ever-works/plugin';

const { scrapeMock, ClientCtorMock, ScrapeConfigCtorMock } = vi.hoisted(() => {
	const scrape = vi.fn();
	const client = vi.fn().mockImplementation(() => ({ scrape }));
	const scrapeConfig = vi.fn().mockImplementation((cfg: unknown) => ({ __cfg: cfg }));
	return { scrapeMock: scrape, ClientCtorMock: client, ScrapeConfigCtorMock: scrapeConfig };
});

vi.mock('scrapfly-sdk', () => ({
	ScrapflyClient: ClientCtorMock,
	ScrapeConfig: ScrapeConfigCtorMock
}));

const { ScrapflyPlugin } = await import('../scrapfly.plugin.js');

const buildContext = (settings: Record<string, unknown> = {}): PluginContext =>
	({
		pluginId: 'scrapfly',
		logger: {
			log: vi.fn(),
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn()
		},
		getSettings: vi.fn().mockResolvedValue(settings)
	}) as unknown as PluginContext;

describe('ScrapflyPlugin', () => {
	let plugin: ScrapflyPlugin;
	let fetchMock: ReturnType<typeof vi.fn>;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.clearAllMocks();
		plugin = new ScrapflyPlugin();
		fetchMock = vi.fn();
		globalThis.fetch = fetchMock as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	describe('metadata', () => {
		it('exposes stable identity fields', () => {
			expect(plugin.id).toBe('scrapfly');
			expect(plugin.name).toBe('Scrapfly');
			expect(plugin.version).toBe('1.0.0');
			expect(plugin.category).toBe('content-extractor');
			expect(plugin.providerName).toBe('Scrapfly');
		});

		it('declares screenshot and content-extractor capabilities', () => {
			expect(plugin.capabilities).toEqual(['screenshot', 'content-extractor']);
		});
	});

	describe('settingsSchema', () => {
		it('requires apiKey and marks it as user-scoped secret', () => {
			expect(plugin.settingsSchema.required).toContain('apiKey');
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.apiKey['x-secret']).toBe(true);
			expect(props.apiKey['x-envVar']).toBe('PLUGIN_SCRAPFLY_API_KEY');
		});
	});

	describe('capture (screenshot)', () => {
		const opts = (overrides: Partial<ScreenshotOptions> = {}): ScreenshotOptions => ({
			url: 'https://example.com',
			settings: { apiKey: 'k' },
			...overrides
		});

		it('rejects when apiKey is missing (getApiKey runs before try/catch)', async () => {
			await expect(plugin.capture({ url: 'https://example.com', settings: {} })).rejects.toThrow(
				/API key not configured/i
			);
			expect(ClientCtorMock).not.toHaveBeenCalled();
		});

		it('returns success with imageUrl, dimensions, and fileSize', async () => {
			scrapeMock.mockResolvedValueOnce({
				result: {
					screenshots: {
						main: { url: 'https://shot.example/main.png', size: 1234 }
					}
				}
			});
			const r = await plugin.capture(opts({ viewportWidth: 1920, viewportHeight: 1080 }));
			expect(ClientCtorMock).toHaveBeenCalledWith({ key: 'k' });
			expect(r).toMatchObject({
				success: true,
				imageUrl: 'https://shot.example/main.png',
				width: 1920,
				height: 1080,
				fileSize: 1234
			});
		});

		it('returns failure when no screenshot data is returned', async () => {
			scrapeMock.mockResolvedValueOnce({ result: { screenshots: {} } });
			const r = await plugin.capture(opts());
			expect(r.success).toBe(false);
			expect(r.error).toMatch(/No screenshot data/);
		});

		it('returns failure and logs when SDK throws', async () => {
			const ctx = buildContext();
			await plugin.onLoad(ctx);
			scrapeMock.mockRejectedValueOnce(new Error('shot failed'));
			const r = await plugin.capture(opts());
			expect(r.success).toBe(false);
			expect(r.error).toMatch(/shot failed/);
			expect(ctx.logger.error).toHaveBeenCalled();
		});
	});

	describe('getScreenshotUrl', () => {
		it('returns the imageUrl from a successful capture', async () => {
			scrapeMock.mockResolvedValueOnce({
				result: { screenshots: { main: { url: 'https://shot.example/main.png' } } }
			});
			const url = await plugin.getScreenshotUrl({
				url: 'https://example.com',
				settings: { apiKey: 'k' }
			});
			expect(url).toBe('https://shot.example/main.png');
		});

		it('returns null when capture fails', async () => {
			scrapeMock.mockResolvedValueOnce({ result: { screenshots: {} } });
			const url = await plugin.getScreenshotUrl({
				url: 'https://example.com',
				settings: { apiKey: 'k' }
			});
			expect(url).toBeNull();
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
			fetchMock.mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK' } as Response);
			const r = await plugin.validateConnection({ apiKey: 'k' });
			expect(r.success).toBe(true);
			const url = fetchMock.mock.calls[0][0] as string;
			expect(url).toContain('https://api.scrapfly.io/account?key=k');
		});

		it('returns failure on a non-OK response', async () => {
			fetchMock.mockResolvedValueOnce({
				ok: false,
				status: 401,
				statusText: 'Unauthorized'
			} as Response);
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

	describe('getMaxDimensions', () => {
		it('returns 4K dimensions', () => {
			const d = plugin.getMaxDimensions();
			expect(d).toEqual({ width: 3840, height: 2160 });
		});
	});

	describe('extract', () => {
		const opts = (overrides: Partial<ContentExtractionOptions> = {}): ContentExtractionOptions => ({
			url: 'https://example.com/post',
			settings: { apiKey: 'k' },
			...overrides
		});

		it('rejects when apiKey is missing (getApiKey runs before try/catch)', async () => {
			await expect(plugin.extract({ url: 'https://example.com', settings: {} })).rejects.toThrow(
				/API key not configured/i
			);
		});

		it('returns success with markdown, wordCount, readingTime', async () => {
			scrapeMock.mockResolvedValueOnce({ result: { content: 'one two three four' } });
			const r = await plugin.extract(opts());
			expect(r.success).toBe(true);
			expect(r.markdown).toBe('one two three four');
			expect(r.wordCount).toBe(4);
			expect(r.readingTime).toBe(1);
		});

		it('returns failure when content is empty', async () => {
			scrapeMock.mockResolvedValueOnce({ result: { content: '' } });
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
		it('chunks URLs into batches of 5', async () => {
			const urls = Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`);
			for (let i = 0; i < urls.length; i++) {
				scrapeMock.mockResolvedValueOnce({ result: { content: 'a b' } });
			}
			const r = await plugin.extractBatch(urls, { settings: { apiKey: 'k' } });
			expect(r).toHaveLength(6);
			expect(r.every((x) => x.success === true)).toBe(true);
			expect(scrapeMock).toHaveBeenCalledTimes(6);
		});
	});

	describe('canExtract', () => {
		it('accepts http and https URLs', async () => {
			expect(await plugin.canExtract('https://example.com')).toBe(true);
			expect(await plugin.canExtract('http://example.com')).toBe(true);
		});

		it('rejects non-http schemes and invalid URLs', async () => {
			expect(await plugin.canExtract('ftp://example.com')).toBe(false);
			expect(await plugin.canExtract('garbage')).toBe(false);
		});
	});

	describe('lifecycle', () => {
		it('logs on load and clears context on unload', async () => {
			const ctx = buildContext();
			await plugin.onLoad(ctx);
			expect(ctx.logger.log).toHaveBeenCalledWith('Scrapfly Plugin loaded');
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
			expect(m.id).toBe('scrapfly');
			expect(m.category).toBe('content-extractor');
			expect(m.capabilities).toEqual(['screenshot', 'content-extractor']);
			expect(m.builtIn).toBe(true);
		});
	});
});
