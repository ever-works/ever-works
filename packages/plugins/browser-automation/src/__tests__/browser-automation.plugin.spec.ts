import { beforeEach, describe, expect, it } from 'vitest';
import type { PluginContext } from '@ever-works/plugin';
import { BrowserAutomationNotProvisionedError, BrowserNavigationBlockedError } from '@ever-works/plugin';
import BrowserAutomationDefaultExport, { BrowserAutomationPlugin } from '../index.js';
import type { PwLocator, PwPage, PwRequest, PwResponse, PwRoute } from '../playwright.types.js';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from '../navigation-policy.js';

// ── fakes ───────────────────────────────────────────────────────────
// A real browser is never launched: the plugin loads Playwright through
// an injected module loader, so these structural fakes stand in for it.

interface NodeSpec {
	text?: string;
	html?: string;
	attributes?: Record<string, string>;
}

class FakeLocator implements PwLocator {
	constructor(
		private readonly page: FakePage,
		private readonly selector: string,
		private readonly nodes: NodeSpec[]
	) {}

	async all(): Promise<PwLocator[]> {
		return this.nodes.map((node) => new FakeLocator(this.page, this.selector, [node]));
	}
	async count(): Promise<number> {
		return this.nodes.length;
	}
	first(): PwLocator {
		return new FakeLocator(this.page, this.selector, this.nodes.slice(0, 1));
	}
	async innerText(): Promise<string> {
		return this.nodes[0]?.text ?? '';
	}
	async textContent(): Promise<string | null> {
		return this.nodes[0]?.text ?? null;
	}
	async innerHTML(): Promise<string> {
		return this.nodes[0]?.html ?? '';
	}
	async getAttribute(name: string): Promise<string | null> {
		return this.nodes[0]?.attributes?.[name] ?? null;
	}
	async click(): Promise<void> {
		this.page.performed.push(`click:${this.selector}`);
		if (this.page.clickNavigatesTo) this.page.currentUrl = this.page.clickNavigatesTo;
	}
	async fill(value: string): Promise<void> {
		this.page.performed.push(`fill:${this.selector}=${value}`);
	}
	async selectOption(values: string): Promise<string[]> {
		this.page.performed.push(`select:${this.selector}=${values}`);
		return [values];
	}
	async press(key: string): Promise<void> {
		this.page.performed.push(`press:${this.selector}:${key}`);
	}
	async hover(): Promise<void> {
		this.page.performed.push(`hover:${this.selector}`);
	}
	async waitFor(): Promise<void> {
		this.page.performed.push(`waitFor:${this.selector}`);
	}
	async screenshot(): Promise<Buffer> {
		this.page.performed.push(`screenshot:${this.selector}`);
		return Buffer.from('element-shot');
	}
}

class FakeRequest implements PwRequest {
	constructor(
		private readonly href: string,
		private readonly kind: string,
		private readonly previous: FakeRequest | null
	) {}
	url(): string {
		return this.href;
	}
	resourceType(): string {
		return this.kind;
	}
	isNavigationRequest(): boolean {
		return this.kind === 'document';
	}
	redirectedFrom(): PwRequest | null {
		return this.previous;
	}
}

class FakeRoute implements PwRoute {
	aborted: string | null = null;
	continued = false;
	constructor(private readonly req: PwRequest) {}
	request(): PwRequest {
		return this.req;
	}
	async abort(errorCode?: string): Promise<void> {
		this.aborted = errorCode ?? 'failed';
	}
	async continue(): Promise<void> {
		this.continued = true;
	}
}

class FakePage implements PwPage {
	currentUrl = 'about:blank';
	closed = false;
	defaultTimeout = 0;
	defaultNavigationTimeout = 0;
	readonly performed: string[] = [];
	readonly gotoCalls: string[] = [];
	readonly waits: number[] = [];
	routeHandler: ((route: PwRoute) => Promise<void> | void) | null = null;
	/** Hops the fake navigation "took", oldest first; last is the landing URL. */
	hops: string[] | null = null;
	/** Requests fed through the route guard while `goto` is in flight. */
	duringNavigation: { url: string; type: string }[] = [];
	/** Routes the guard saw during the last `goto`, for assertions. */
	readonly seenRoutes: FakeRoute[] = [];
	gotoError: Error | null = null;
	clickNavigatesTo: string | null = null;
	nodes: Record<string, NodeSpec[]> = {};
	documentHtml = '<html><body>fake</body></html>';
	pageTitle = 'Fake Page';
	responseStatus = 200;

	async route(_pattern: string, handler: (route: PwRoute) => Promise<void> | void): Promise<void> {
		this.routeHandler = handler;
	}
	async goto(url: string): Promise<PwResponse | null> {
		this.gotoCalls.push(url);
		// Playwright fires the route handler for every request the page
		// makes mid-navigation, redirect hops included.
		for (const pending of this.duringNavigation) {
			const route = new FakeRoute(new FakeRequest(pending.url, pending.type, null));
			await this.routeHandler?.(route);
			this.seenRoutes.push(route);
		}
		if (this.gotoError) throw this.gotoError;
		const chain = this.hops ?? [url];
		this.currentUrl = chain[chain.length - 1];
		let request: FakeRequest | null = null;
		for (const hop of chain) {
			request = new FakeRequest(hop, 'document', request);
		}
		const finalRequest = request as FakeRequest;
		const status = this.responseStatus;
		return {
			url: () => this.currentUrl,
			status: () => status,
			request: () => finalRequest
		};
	}
	url(): string {
		return this.currentUrl;
	}
	async title(): Promise<string> {
		return this.pageTitle;
	}
	async content(): Promise<string> {
		return this.documentHtml;
	}
	locator(selector: string): PwLocator {
		if (selector === 'body' && !this.nodes.body) {
			return new FakeLocator(this, 'body', [{ text: 'body text' }]);
		}
		return new FakeLocator(this, selector, this.nodes[selector] ?? []);
	}
	setDefaultTimeout(timeout: number): void {
		this.defaultTimeout = timeout;
	}
	setDefaultNavigationTimeout(timeout: number): void {
		this.defaultNavigationTimeout = timeout;
	}
	async screenshot(options?: { type?: 'png' | 'jpeg'; fullPage?: boolean }): Promise<Buffer> {
		this.performed.push(`page-screenshot:${options?.type ?? 'png'}:${options?.fullPage === true}`);
		return Buffer.from('page-shot');
	}
	async waitForTimeout(timeout: number): Promise<void> {
		this.waits.push(timeout);
	}
	async close(): Promise<void> {
		this.closed = true;
	}
}

class FakeContext {
	closed = false;
	readonly pages: FakePage[] = [];
	constructor(readonly options: unknown) {}
	async newPage(): Promise<PwPage> {
		const page = new FakePage();
		this.pages.push(page);
		return page;
	}
	async close(): Promise<void> {
		this.closed = true;
	}
}

class FakeBrowser {
	closed = false;
	readonly contexts: FakeContext[] = [];
	constructor(readonly launchOptions: Record<string, unknown>) {}
	async newContext(options?: unknown): Promise<FakeContext> {
		const context = new FakeContext(options);
		this.contexts.push(context);
		return context;
	}
	async close(): Promise<void> {
		this.closed = true;
	}
	isConnected(): boolean {
		return !this.closed;
	}
}

class FakePlaywright {
	readonly browsers: FakeBrowser[] = [];
	launchError: Error | null = null;
	readonly chromium = {
		launch: async (options?: Record<string, unknown>) => {
			if (this.launchError) throw this.launchError;
			const browser = new FakeBrowser(options ?? {});
			this.browsers.push(browser);
			return browser;
		}
	};
}

const publicDns = { dnsResolver: async () => [{ address: '93.184.216.34', family: 4 }] };

function makePlugin(): { plugin: BrowserAutomationPlugin; playwright: FakePlaywright } {
	const playwright = new FakePlaywright();
	const plugin = new BrowserAutomationPlugin(async () => playwright, publicDns);
	return { plugin, playwright };
}

function lastPage(playwright: FakePlaywright): FakePage {
	const browser = playwright.browsers[playwright.browsers.length - 1];
	const context = browser.contexts[browser.contexts.length - 1];
	return context.pages[context.pages.length - 1];
}

const ALLOW_EXAMPLE = { allowedHosts: ['example.com', '*.example.com'] };

const silentContext = (): PluginContext =>
	({
		logger: { log: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }
	}) as unknown as PluginContext;

// The deployment-level allowlist env var must never leak into these
// specs — default-deny is exactly what several of them assert.
beforeEach(() => {
	delete process.env.PLUGIN_BROWSER_AUTOMATION_ALLOWED_HOSTS;
});

// ── specs ───────────────────────────────────────────────────────────

describe('plugin shape', () => {
	it('has a DEFAULT EXPORT (the loader rejects a plugin without one)', () => {
		expect(BrowserAutomationDefaultExport).toBe(BrowserAutomationPlugin);
		expect(typeof BrowserAutomationDefaultExport).toBe('function');
	});

	it('declares the browser-automation capability and a settings schema', () => {
		const { plugin } = makePlugin();
		expect(plugin.id).toBe('browser-automation');
		expect(plugin.category).toBe('utility');
		expect(plugin.capabilities).toContain('browser-automation');
		expect(plugin.settingsSchema.properties?.allowedHosts).toBeDefined();
		expect(plugin.settingsSchema.properties?.timeoutMs).toBeDefined();
		expect(plugin.settingsSchema.properties?.headless).toBeDefined();
	});

	it('reports a manifest that matches the instance', () => {
		const { plugin } = makePlugin();
		const manifest = plugin.getManifest();
		expect(manifest.id).toBe(plugin.id);
		expect(manifest.capabilities).toEqual(['browser-automation']);
		expect(manifest.defaultForCapabilities).toEqual(['browser-automation']);
	});
});

describe('open', () => {
	it('launches HEADLESS by default', async () => {
		const { plugin, playwright } = makePlugin();
		await plugin.open({ settings: ALLOW_EXAMPLE });
		expect(playwright.browsers[0].launchOptions.headless).toBe(true);
	});

	it('only runs headed when settings explicitly say so', async () => {
		const { plugin, playwright } = makePlugin();
		await plugin.open({ settings: { ...ALLOW_EXAMPLE, headless: false } });
		expect(playwright.browsers[0].launchOptions.headless).toBe(false);
	});

	it('surfaces the resolved policy on the handle', async () => {
		const { plugin } = makePlugin();
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE, timeoutMs: 5_000 });
		expect(handle.policy).toEqual({
			allowedHosts: ['example.com', '*.example.com'],
			subresourcePolicy: 'public-only',
			allowPrivateNetwork: false,
			timeoutMs: 5_000,
			headless: true
		});
		expect(handle.sessionId).toEqual(expect.any(String));
	});

	it('applies the clamped timeout to the page defaults', async () => {
		const { plugin, playwright } = makePlugin();
		await plugin.open({ settings: ALLOW_EXAMPLE, timeoutMs: 999_999 });
		const page = lastPage(playwright);
		expect(page.defaultTimeout).toBe(MAX_TIMEOUT_MS);
		expect(page.defaultNavigationTimeout).toBe(MAX_TIMEOUT_MS);
	});

	it('reuses one browser across sessions and closes it with the last one', async () => {
		const { plugin, playwright } = makePlugin();
		const a = await plugin.open({ settings: ALLOW_EXAMPLE });
		const b = await plugin.open({ settings: ALLOW_EXAMPLE });
		expect(playwright.browsers).toHaveLength(1);

		await plugin.close(a);
		expect(playwright.browsers[0].closed).toBe(false);
		await plugin.close(b);
		expect(playwright.browsers[0].closed).toBe(true);
	});

	it('degrades LOUDLY when Playwright is not installed', async () => {
		const plugin = new BrowserAutomationPlugin(async () => {
			throw new Error('Cannot find module');
		}, publicDns);
		await expect(plugin.open({ settings: ALLOW_EXAMPLE })).rejects.toBeInstanceOf(
			BrowserAutomationNotProvisionedError
		);
	});

	it('degrades LOUDLY when the module exposes no chromium launcher', async () => {
		const plugin = new BrowserAutomationPlugin(async () => ({}), publicDns);
		await expect(plugin.open({ settings: ALLOW_EXAMPLE })).rejects.toBeInstanceOf(
			BrowserAutomationNotProvisionedError
		);
	});

	it('accepts a CJS-interop module wrapped in `default`', async () => {
		const playwright = new FakePlaywright();
		const plugin = new BrowserAutomationPlugin(async () => ({ default: playwright }), publicDns);
		await expect(plugin.open({ settings: ALLOW_EXAMPLE })).resolves.toBeDefined();
	});

	it('degrades LOUDLY when Chromium refuses to launch', async () => {
		const { plugin, playwright } = makePlugin();
		playwright.launchError = new Error('no sandbox');
		await expect(plugin.open({ settings: ALLOW_EXAMPLE })).rejects.toBeInstanceOf(
			BrowserAutomationNotProvisionedError
		);
	});
});

describe('navigate', () => {
	let plugin: BrowserAutomationPlugin;
	let playwright: FakePlaywright;

	beforeEach(() => {
		({ plugin, playwright } = makePlugin());
	});

	it('navigates to an allowlisted URL and reports where it landed', async () => {
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		const result = await plugin.navigate(handle, 'https://example.com/start');
		expect(result.url).toBe('https://example.com/start');
		expect(result.status).toBe(200);
		expect(result.title).toBe('Fake Page');
		expect(result.redirectChain).toEqual(['https://example.com/start']);
	});

	it('reports the full redirect chain when every hop is allowlisted', async () => {
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		lastPage(playwright).hops = ['https://example.com/a', 'https://www.example.com/b'];
		const result = await plugin.navigate(handle, 'https://example.com/a');
		expect(result.redirectChain).toEqual(['https://example.com/a', 'https://www.example.com/b']);
		expect(result.url).toBe('https://www.example.com/b');
	});

	// ── SSRF / allowlist refusals ───────────────────────────────────
	it('REFUSES an off-allowlist URL before the browser touches the network', async () => {
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		await expect(plugin.navigate(handle, 'https://evil.test/')).rejects.toMatchObject({
			name: 'BrowserNavigationBlockedError',
			code: 'not_allowlisted'
		});
		expect(lastPage(playwright).gotoCalls).toEqual([]);
	});

	it('REFUSES an internal host even with a wildcard allowlist (SSRF)', async () => {
		const handle = await plugin.open({ settings: { allowedHosts: ['*'] } });
		await expect(plugin.navigate(handle, 'http://169.254.169.254/latest/meta-data/')).rejects.toMatchObject({
			code: 'private_address'
		});
		expect(lastPage(playwright).gotoCalls).toEqual([]);
	});

	it('REFUSES everything when nothing is allowlisted (default-deny)', async () => {
		const handle = await plugin.open({ settings: {} });
		await expect(plugin.navigate(handle, 'https://example.com/')).rejects.toMatchObject({
			code: 'not_allowlisted'
		});
	});

	it('REFUSES a hostname that resolves to a private address (DNS rebinding)', async () => {
		const rebinding = new BrowserAutomationPlugin(async () => new FakePlaywright(), {
			dnsResolver: async () => [{ address: '127.0.0.1', family: 4 }]
		});
		const handle = await rebinding.open({ settings: { allowedHosts: ['*'] } });
		await expect(rebinding.navigate(handle, 'https://rebind.example.test/')).rejects.toMatchObject({
			code: 'dns_private_ip'
		});
	});

	it('NEVER lands on a redirect hop outside the allowlist', async () => {
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		lastPage(playwright).hops = ['https://example.com/a', 'https://evil.test/pwned'];
		await expect(plugin.navigate(handle, 'https://example.com/a')).rejects.toMatchObject({
			name: 'BrowserNavigationBlockedError',
			code: 'not_allowlisted'
		});
	});

	it('NEVER lands on an internal redirect hop', async () => {
		const handle = await plugin.open({ settings: { allowedHosts: ['*'] } });
		lastPage(playwright).hops = ['https://example.com/a', 'http://169.254.169.254/latest/'];
		await expect(plugin.navigate(handle, 'https://example.com/a')).rejects.toMatchObject({
			code: 'private_address'
		});
	});

	it('reports the route guard reason when an aborted redirect surfaces as a goto failure', async () => {
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		const page = lastPage(playwright);
		// The guard aborts the redirect hop, so Chromium reports the whole
		// navigation as a network failure.
		page.duringNavigation = [{ url: 'https://evil.test/pwned', type: 'document' }];
		page.gotoError = new Error('net::ERR_FAILED');

		const error = await plugin.navigate(handle, 'https://example.com/a').catch((err: unknown) => err);
		expect(error).toBeInstanceOf(BrowserNavigationBlockedError);
		expect((error as BrowserNavigationBlockedError).code).toBe('not_allowlisted');
	});

	it('rethrows a genuine navigation failure untouched', async () => {
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		lastPage(playwright).gotoError = new Error('net::ERR_CONNECTION_RESET');
		await expect(plugin.navigate(handle, 'https://example.com/a')).rejects.toThrow('net::ERR_CONNECTION_RESET');
	});

	it('throws for an unknown/closed session handle', async () => {
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		await plugin.close(handle);
		await expect(plugin.navigate(handle, 'https://example.com/')).rejects.toBeInstanceOf(
			BrowserAutomationNotProvisionedError
		);
	});
});

describe('route guard', () => {
	it('aborts an off-allowlist DOCUMENT request and records it as a navigation refusal', async () => {
		const { plugin, playwright } = makePlugin();
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		const page = lastPage(playwright);
		page.duringNavigation = [{ url: 'https://evil.test/', type: 'document' }];

		const result = await plugin.navigate(handle, 'https://example.com/ok');
		expect(page.seenRoutes[0].aborted).toBe('blockedbyclient');
		expect(page.seenRoutes[0].continued).toBe(false);
		expect(result.blockedRequests).toEqual([
			{ url: 'https://evil.test/', reason: 'not_allowlisted', navigation: true }
		]);
	});

	it('allows a PUBLIC sub-resource under the default public-only policy', async () => {
		const { plugin, playwright } = makePlugin();
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		const page = lastPage(playwright);
		page.duringNavigation = [{ url: 'https://cdn.other.test/app.js', type: 'script' }];

		const result = await plugin.navigate(handle, 'https://example.com/ok');
		expect(page.seenRoutes[0].continued).toBe(true);
		expect(page.seenRoutes[0].aborted).toBeNull();
		expect(result.blockedRequests).toEqual([]);
	});

	it('aborts an INTERNAL sub-resource even under public-only (SSRF)', async () => {
		const { plugin, playwright } = makePlugin();
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		lastPage(playwright).duringNavigation = [{ url: 'http://127.0.0.1:9200/_cat/indices', type: 'xhr' }];

		const result = await plugin.navigate(handle, 'https://example.com/ok');
		expect(result.blockedRequests).toEqual([
			{ url: 'http://127.0.0.1:9200/_cat/indices', reason: 'private_address', navigation: false }
		]);
	});

	it('aborts a cross-host sub-resource when the policy is allowlist-strict', async () => {
		const { plugin, playwright } = makePlugin();
		const handle = await plugin.open({ settings: { ...ALLOW_EXAMPLE, subresourcePolicy: 'allowlist' } });
		lastPage(playwright).duringNavigation = [{ url: 'https://cdn.other.test/app.js', type: 'script' }];

		const result = await plugin.navigate(handle, 'https://example.com/ok');
		expect(result.blockedRequests).toEqual([
			{ url: 'https://cdn.other.test/app.js', reason: 'not_allowlisted', navigation: false }
		]);
	});

	it('redacts credentials out of a recorded refusal', async () => {
		const { plugin, playwright } = makePlugin();
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		lastPage(playwright).duringNavigation = [{ url: 'https://user:secret@evil.test/', type: 'document' }];

		const result = await plugin.navigate(handle, 'https://example.com/ok');
		expect(result.blockedRequests[0].url).not.toContain('secret');
	});

	it('drains recorded refusals so they are reported exactly once', async () => {
		const { plugin, playwright } = makePlugin();
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		lastPage(playwright).duringNavigation = [{ url: 'https://evil.test/', type: 'document' }];

		const first = await plugin.navigate(handle, 'https://example.com/ok');
		expect(first.blockedRequests).toHaveLength(1);
		const second = await plugin.act(handle, []);
		expect(second.blockedRequests).toEqual([]);
	});
});

describe('extract', () => {
	it('returns per-node text for a selector', async () => {
		const { plugin, playwright } = makePlugin();
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		lastPage(playwright).nodes = { h2: [{ text: 'One' }, { text: 'Two' }] };
		await expect(plugin.extract(handle, { selector: 'h2', format: 'text' })).resolves.toEqual({
			values: ['One', 'Two'],
			truncated: false
		});
	});

	it('returns inner HTML per node', async () => {
		const { plugin, playwright } = makePlugin();
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		lastPage(playwright).nodes = { '.card': [{ html: '<b>hi</b>' }] };
		await expect(plugin.extract(handle, { selector: '.card', format: 'html' })).resolves.toEqual({
			values: ['<b>hi</b>'],
			truncated: false
		});
	});

	it('returns an attribute per node and empty string for a missing one', async () => {
		const { plugin, playwright } = makePlugin();
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		lastPage(playwright).nodes = { a: [{ attributes: { href: '/x' } }, {}] };
		await expect(
			plugin.extract(handle, { selector: 'a', format: 'attribute', attribute: 'href' })
		).resolves.toEqual({ values: ['/x', ''], truncated: false });
	});

	it('honours the limit and flags truncation', async () => {
		const { plugin, playwright } = makePlugin();
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		lastPage(playwright).nodes = { li: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] };
		await expect(plugin.extract(handle, { selector: 'li', format: 'text', limit: 2 })).resolves.toEqual({
			values: ['a', 'b'],
			truncated: true
		});
	});

	it('falls back to the whole document when no selector is given', async () => {
		const { plugin, playwright } = makePlugin();
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		lastPage(playwright).documentHtml = '<html>doc</html>';
		await expect(plugin.extract(handle, { format: 'html' })).resolves.toEqual({
			values: ['<html>doc</html>'],
			truncated: false
		});
		await expect(plugin.extract(handle, { format: 'text' })).resolves.toEqual({
			values: ['body text'],
			truncated: false
		});
	});

	it('rejects an attribute query with no attribute name or no selector', async () => {
		const { plugin } = makePlugin();
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		await expect(plugin.extract(handle, { selector: 'a', format: 'attribute' })).rejects.toBeInstanceOf(TypeError);
		await expect(plugin.extract(handle, { format: 'attribute', attribute: 'href' })).rejects.toBeInstanceOf(
			TypeError
		);
	});
});

describe('screenshot', () => {
	it('captures the page as base64 PNG by default', async () => {
		const { plugin } = makePlugin();
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		const shot = await plugin.screenshot(handle);
		expect(shot.contentType).toBe('image/png');
		expect(Buffer.from(shot.base64, 'base64').toString()).toBe('page-shot');
		expect(shot.bytes).toBe(Buffer.from('page-shot').byteLength);
	});

	it('captures JPEG with a clamped quality and honours fullPage', async () => {
		const { plugin, playwright } = makePlugin();
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		await plugin.screenshot(handle, { format: 'jpeg', quality: 5_000, fullPage: true });
		expect(lastPage(playwright).performed).toContain('page-screenshot:jpeg:true');
	});

	it('captures a single element when a selector is given', async () => {
		const { plugin, playwright } = makePlugin();
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		lastPage(playwright).nodes = { '#hero': [{}] };
		const shot = await plugin.screenshot(handle, { selector: '#hero' });
		expect(Buffer.from(shot.base64, 'base64').toString()).toBe('element-shot');
	});
});

describe('act', () => {
	it('runs each step in order', async () => {
		const { plugin, playwright } = makePlugin();
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		const page = lastPage(playwright);
		page.currentUrl = 'https://example.com/form';
		page.nodes = { '#q': [{}], '#go': [{}], '#sel': [{}] };

		const result = await plugin.act(handle, [
			{ kind: 'fill', selector: '#q', value: 'hello' },
			{ kind: 'select', selector: '#sel', value: 'b' },
			{ kind: 'press', selector: '#q', key: 'Enter' },
			{ kind: 'hover', selector: '#go' },
			{ kind: 'click', selector: '#go' },
			{ kind: 'wait', selector: '#go' }
		]);

		expect(result.performed).toBe(6);
		expect(page.performed).toEqual([
			'fill:#q=hello',
			'select:#sel=b',
			'press:#q:Enter',
			'hover:#go',
			'click:#go',
			'waitFor:#go'
		]);
	});

	it('treats a selector-less wait as a plain delay clamped by the policy', async () => {
		const { plugin, playwright } = makePlugin();
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		lastPage(playwright).currentUrl = 'https://example.com/';
		await plugin.act(handle, [{ kind: 'wait', timeoutMs: 999_999 }]);
		expect(lastPage(playwright).waits).toEqual([MAX_TIMEOUT_MS]);
	});

	it('returns early for an empty step list', async () => {
		const { plugin, playwright } = makePlugin();
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		lastPage(playwright).currentUrl = 'https://example.com/';
		await expect(plugin.act(handle, [])).resolves.toMatchObject({ performed: 0 });
	});

	it('rejects more steps than the cap allows', async () => {
		const { plugin } = makePlugin();
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		const steps = Array.from({ length: 51 }, () => ({ kind: 'click' as const, selector: '#x' }));
		await expect(plugin.act(handle, steps)).rejects.toBeInstanceOf(RangeError);
	});

	it('rejects steps missing their required inputs', async () => {
		const { plugin, playwright } = makePlugin();
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		lastPage(playwright).nodes = { '#x': [{}] };
		await expect(plugin.act(handle, [{ kind: 'click' }])).rejects.toBeInstanceOf(TypeError);
		await expect(plugin.act(handle, [{ kind: 'select', selector: '#x' }])).rejects.toBeInstanceOf(TypeError);
		await expect(plugin.act(handle, [{ kind: 'press', selector: '#x' }])).rejects.toBeInstanceOf(TypeError);
	});

	it('REFUSES the result when a click navigated off the allowlist', async () => {
		const { plugin, playwright } = makePlugin();
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		const page = lastPage(playwright);
		page.currentUrl = 'https://example.com/';
		page.nodes = { '#out': [{}] };
		page.clickNavigatesTo = 'http://127.0.0.1:8080/admin';

		await expect(plugin.act(handle, [{ kind: 'click', selector: '#out' }])).rejects.toMatchObject({
			name: 'BrowserNavigationBlockedError',
			code: 'private_address'
		});
	});
});

describe('close / lifecycle', () => {
	it('closes the page and context, and is a no-op for an unknown handle', async () => {
		const { plugin, playwright } = makePlugin();
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		const page = lastPage(playwright);
		const context = playwright.browsers[0].contexts[0];

		await plugin.close(handle);
		expect(page.closed).toBe(true);
		expect(context.closed).toBe(true);

		await expect(plugin.close(handle)).resolves.toBeUndefined();
	});

	it('onUnload tears every session down', async () => {
		const { plugin, playwright } = makePlugin();
		await plugin.onLoad(silentContext());
		await plugin.open({ settings: ALLOW_EXAMPLE });
		await plugin.open({ settings: ALLOW_EXAMPLE });
		await plugin.onUnload();
		expect(playwright.browsers[0].closed).toBe(true);
		expect(playwright.browsers[0].contexts.every((ctx) => ctx.closed)).toBe(true);
	});

	it('probe reports the empty-allowlist posture as not-ok', async () => {
		const { plugin } = makePlugin();
		await expect(plugin.probe({})).resolves.toMatchObject({ ok: false });
		await expect(plugin.probe(ALLOW_EXAMPLE)).resolves.toMatchObject({ ok: true });
	});

	it('probe reports a missing Playwright install as not-ok', async () => {
		const plugin = new BrowserAutomationPlugin(async () => {
			throw new Error('Cannot find module');
		}, publicDns);
		await expect(plugin.probe(ALLOW_EXAMPLE)).resolves.toMatchObject({ ok: false });
	});

	it('healthCheck degrades rather than throwing', async () => {
		const { plugin } = makePlugin();
		const health = await plugin.healthCheck();
		expect(health.status).toBe('degraded');
		expect(health.checkedAt).toEqual(expect.any(Number));
	});
});

describe('validateSettings', () => {
	it('accepts a sane configuration', () => {
		const { plugin } = makePlugin();
		expect(plugin.validateSettings({ allowedHosts: ['example.com', '*.example.com'] })).toMatchObject({
			valid: true
		});
	});

	it('rejects malformed host patterns', () => {
		const { plugin } = makePlugin();
		const result = plugin.validateSettings({ allowedHosts: ['https://example.com'] });
		expect(result.valid).toBe(false);
		expect(result.errors?.[0]).toMatchObject({ path: 'allowedHosts', code: 'invalid_host_pattern' });
	});

	it('rejects the wildcard combined with private-network access', () => {
		const { plugin } = makePlugin();
		const result = plugin.validateSettings({ allowedHosts: ['*'], allowPrivateNetwork: true });
		expect(result.valid).toBe(false);
		expect(result.errors?.[0]).toMatchObject({ code: 'wildcard_with_private_network' });
	});

	it('warns (but does not fail) on an empty allowlist and on headed mode', () => {
		const { plugin } = makePlugin();
		const result = plugin.validateSettings({ allowedHosts: [], headless: false });
		expect(result.valid).toBe(true);
		expect(result.warnings?.map((warning) => warning.code)).toEqual(['empty_allowlist', 'headed_browser']);
	});
});

describe('defaults', () => {
	it('uses the documented default timeout when nothing is configured', async () => {
		const { plugin } = makePlugin();
		const handle = await plugin.open({ settings: ALLOW_EXAMPLE });
		expect(handle.policy.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
	});
});
