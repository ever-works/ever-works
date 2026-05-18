import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginContext, ContentExtractionOptions } from '@ever-works/plugin';

const { axiosGetMock, axiosDefaultMock } = vi.hoisted(() => {
	const get = vi.fn();
	return { axiosGetMock: get, axiosDefaultMock: { get } };
});

vi.mock('axios', () => ({
	default: axiosDefaultMock
}));

const { LocalContentExtractorPlugin } = await import('../local-content-extractor.plugin.js');

const buildContext = (): PluginContext =>
	({
		pluginId: 'local-content-extractor',
		logger: {
			log: vi.fn(),
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn()
		},
		getSettings: vi.fn().mockResolvedValue({})
	}) as unknown as PluginContext;

const buildHtml = (body: string, head = ''): string =>
	`<!DOCTYPE html><html lang="en"><head><title>Test Page</title>${head}</head><body>${body}</body></html>`;

const articleHtml = buildHtml(
	`<article>
		<h1>The Title</h1>
		<p>${'word '.repeat(120)}</p>
		<img src="/img.png" alt="Sample">
		<a href="https://external.example.com/page" rel="nofollow">External link</a>
		<a href="/internal" title="Internal">Internal link</a>
	</article>`,
	`<meta name="description" content="An article description for testing.">
	 <meta name="author" content="Alice">
	 <meta property="og:title" content="OG Title">`
);

const okHtmlResponse = (html: string, finalUrl?: string) =>
	({
		data: html,
		headers: { 'content-type': 'text/html; charset=utf-8' },
		request: finalUrl ? { res: { responseUrl: finalUrl } } : undefined
	}) as unknown;

describe('LocalContentExtractorPlugin', () => {
	let plugin: InstanceType<typeof LocalContentExtractorPlugin>;

	beforeEach(() => {
		vi.clearAllMocks();
		plugin = new LocalContentExtractorPlugin();
	});

	describe('metadata', () => {
		it('exposes stable identity fields', () => {
			expect(plugin.id).toBe('local-content-extractor');
			expect(plugin.name).toBe('Local Content Processor');
			expect(plugin.version).toBe('1.0.0');
			expect(plugin.category).toBe('content-extractor');
			expect(plugin.providerName).toBe('Local (Readability)');
		});

		it('declares only the content-extractor capability', () => {
			expect(plugin.capabilities).toEqual(['content-extractor']);
		});

		it('flags itself as a system plugin', () => {
			expect(plugin.systemPlugin).toBe(true);
		});
	});

	describe('settingsSchema', () => {
		it('exposes timeout, minContentLength, and userAgent with defaults and bounds', () => {
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.timeout.default).toBe(15000);
			expect(props.timeout.minimum).toBe(1000);
			expect(props.timeout.maximum).toBe(60000);
			expect(props.minContentLength.default).toBe(200);
			expect(typeof props.userAgent.default).toBe('string');
			expect(props.timeout['x-hidden']).toBe(true);
			expect(props.userAgent['x-hidden']).toBe(true);
		});
	});

	describe('isAvailable', () => {
		it('always returns true (no API key needed)', async () => {
			expect(await plugin.isAvailable()).toBe(true);
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

	describe('getSupportedFormats', () => {
		it('exposes text + html + markdown', () => {
			expect(plugin.getSupportedFormats()).toEqual(['text', 'html', 'markdown']);
		});
	});

	describe('extract', () => {
		const opts = (overrides: Partial<ContentExtractionOptions> = {}): ContentExtractionOptions => ({
			url: 'https://example.com/post',
			...overrides
		});

		it('returns success with content + metadata + word count for a typical article', async () => {
			axiosGetMock.mockResolvedValueOnce(okHtmlResponse(articleHtml));
			const r = await plugin.extract(opts());
			expect(r.success).toBe(true);
			expect(typeof r.content).toBe('string');
			expect((r.content as string).length).toBeGreaterThan(0);
			expect(typeof r.markdown).toBe('string');
			expect(r.wordCount).toBeGreaterThan(50);
			expect(r.readingTime).toBeGreaterThanOrEqual(1);
			expect(r.metadata?.description).toBe('An article description for testing.');
		});

		it('rejects non-supported content types early', async () => {
			axiosGetMock.mockResolvedValueOnce({
				data: 'PDF binary',
				headers: { 'content-type': 'application/pdf' },
				request: undefined
			});
			const r = await plugin.extract(opts());
			expect(r.success).toBe(false);
			expect(r.error).toMatch(/Unsupported content type: application\/pdf/);
		});

		it('falls back to meta description when Readability content is too short', async () => {
			const html = buildHtml(
				'<p>tiny</p>',
				'<meta name="description" content="A reasonably long description with more than fifty characters of content here.">'
			);
			axiosGetMock.mockResolvedValueOnce(okHtmlResponse(html));
			const r = await plugin.extract(opts({ settings: { minContentLength: 9999 } }));
			expect(r.success).toBe(true);
			expect(r.content).toMatch(/reasonably long description/);
		});

		it('exposes finalUrl when the response was redirected', async () => {
			axiosGetMock.mockResolvedValueOnce(okHtmlResponse(articleHtml, 'https://example.com/redirected'));
			const r = await plugin.extract(opts());
			expect(r.finalUrl).toBe('https://example.com/redirected');
		});

		it('returns failure when axios throws (HTTP error)', async () => {
			const err = Object.assign(new Error('Request failed'), {
				response: { status: 404 },
				message: 'Not Found'
			});
			axiosGetMock.mockRejectedValueOnce(err);
			const r = await plugin.extract(opts());
			expect(r.success).toBe(false);
			expect(r.error).toMatch(/HTTP 404/);
		});

		it('returns failure when axios throws (network error)', async () => {
			axiosGetMock.mockRejectedValueOnce(new Error('ENOTFOUND'));
			const r = await plugin.extract(opts());
			expect(r.success).toBe(false);
			expect(r.error).toMatch(/ENOTFOUND/);
		});

		it('handles array Content-Type header gracefully', async () => {
			axiosGetMock.mockResolvedValueOnce({
				data: articleHtml,
				headers: { 'content-type': ['text/html; charset=utf-8', 'extra'] },
				request: undefined
			});
			const r = await plugin.extract(opts());
			expect(r.success).toBe(true);
		});

		it('forwards configured timeout, userAgent, and headers', async () => {
			axiosGetMock.mockResolvedValueOnce(okHtmlResponse(articleHtml));
			await plugin.extract(opts({ settings: { timeout: 5000, userAgent: 'CustomAgent/1.0' } }));
			const [, config] = axiosGetMock.mock.calls[0];
			expect(config.timeout).toBe(5000);
			expect(config.headers['User-Agent']).toBe('CustomAgent/1.0');
		});

		it.each([
			['http://127.0.0.1/foo', 'loopback'],
			['http://169.254.169.254/latest/meta-data/', 'AWS/GCP/Azure IMDS link-local'],
			['http://10.0.0.1/', 'RFC1918 private']
		])('rejects SSRF-blocked URLs (%s — %s) without making an HTTP request', async (blockedUrl) => {
			const r = await plugin.extract(opts({ url: blockedUrl }));
			expect(r.success).toBe(false);
			expect(r.url).toBe(blockedUrl);
			expect(r.error).toMatch(/SSRF guard blocked/);
			expect(r.error).toContain(blockedUrl);
			expect(axiosGetMock).not.toHaveBeenCalled();
		});
	});

	describe('extractBatch', () => {
		it('runs each URL through extract and aggregates results', async () => {
			axiosGetMock
				.mockResolvedValueOnce(okHtmlResponse(articleHtml))
				.mockResolvedValueOnce(okHtmlResponse(articleHtml));
			const r = await plugin.extractBatch(['https://a.example', 'https://b.example']);
			expect(r).toHaveLength(2);
			expect(r.every((x) => x.success === true)).toBe(true);
		});
	});

	describe('lifecycle', () => {
		it('logs on load and clears context on unload without error', async () => {
			const ctx = buildContext();
			await plugin.onLoad(ctx);
			expect(ctx.logger.log).toHaveBeenCalledWith('Local Content Processor Plugin loaded');
			await expect(plugin.onUnload()).resolves.toBeUndefined();
		});
	});

	describe('healthCheck + manifest', () => {
		it('reports healthy', async () => {
			const h = await plugin.healthCheck();
			expect(h.status).toBe('healthy');
			expect(h.message).toMatch(/ready/i);
		});

		it('returns a manifest aligned with plugin metadata', () => {
			const m = plugin.getManifest();
			expect(m.id).toBe('local-content-extractor');
			expect(m.category).toBe('content-extractor');
			expect(m.builtIn).toBe(true);
			expect(m.systemPlugin).toBe(true);
			expect(m.autoEnable).toBe(true);
			expect(m.defaultForCapabilities).toContain('content-extractor');
		});
	});
});
