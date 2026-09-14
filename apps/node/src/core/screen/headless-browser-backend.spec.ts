import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { spawn } from 'child_process';
import {
	isScreenCaptureAvailable,
	selectCaptureBackend,
	type CaptureBackend,
	type CaptureEnvironment
} from './capture-backend';
import type { WebSocketLike } from './cdp-connection';
import {
	buildHeadlessCaptureArgs,
	countSessionCookieSites,
	HeadlessBrowserCaptureBackend,
	parseDevToolsActivePort,
	scaleForWidth
} from './headless-browser-backend';

const env = (overrides: Partial<CaptureEnvironment> = {}): CaptureEnvironment => ({
	platform: 'linux',
	hasDisplay: false,
	browserPath: null,
	...overrides
});

/** A fake browser debugging endpoint answering the calls a capture makes. */
function fakeBrowserSocket(onCall: (method: string) => void = () => undefined): WebSocketLike {
	const socket: WebSocketLike = {
		readyState: 1,
		onopen: null,
		onmessage: null,
		onerror: null,
		onclose: null,
		send: (raw: string) => {
			const { id, method } = JSON.parse(raw) as { id: number; method: string };
			onCall(method);
			const results: Record<string, unknown> = {
				'Target.getTargets': { targetInfos: [{ type: 'page', targetId: 'page-1' }] },
				'Target.attachToTarget': { sessionId: 'session-1' },
				'Page.getLayoutMetrics': { cssVisualViewport: { clientWidth: 1920, clientHeight: 1080 } },
				'Page.captureScreenshot': { data: 'QUJD' },
				'Storage.getCookies': {
					cookies: [
						{ domain: '.mail.example.com', secure: true, httpOnly: true },
						{ domain: 'example.com', secure: true, httpOnly: true },
						{ domain: 'tracker.test', secure: false, httpOnly: false }
					]
				}
			};
			queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ id, result: results[method] ?? {} }) }));
		},
		close: () => socket.onclose?.({})
	};
	queueMicrotask(() => socket.onopen?.({}));
	return socket;
}

function fakeChild() {
	const child = new EventEmitter() as EventEmitter & {
		stderr: EventEmitter;
		exitCode: number | null;
		killed: boolean;
		kill: ReturnType<typeof vi.fn>;
	};
	child.stderr = new EventEmitter();
	child.exitCode = null;
	child.killed = false;
	child.kill = vi.fn(() => {
		child.killed = true;
		return true;
	});
	return child;
}

describe('capture backend selection', () => {
	it('makes the screen capturable exactly when a browser was resolved — no display needed', () => {
		expect(isScreenCaptureAvailable(env())).toBe(false);
		expect(isScreenCaptureAvailable(env({ browserPath: '' }))).toBe(false);
		expect(isScreenCaptureAvailable(env({ browserPath: '/usr/bin/chromium' }))).toBe(true);
	});

	it('picks the first available backend in preference order, and survives one that throws', () => {
		const broken: CaptureBackend = {
			id: 'broken',
			isAvailable: () => {
				throw new Error('probe failed');
			},
			start: vi.fn()
		};
		const desktop: CaptureBackend = { id: 'desktop', isAvailable: (e) => e.hasDisplay, start: vi.fn() };
		const headless = new HeadlessBrowserCaptureBackend({ browserPath: '/usr/bin/chromium' });
		expect(selectCaptureBackend([broken, desktop, headless], env({ browserPath: '/b' }))?.id).toBe(
			'headless-browser'
		);
		expect(
			selectCaptureBackend([broken, desktop, headless], env({ hasDisplay: true, browserPath: '/b' }))?.id
		).toBe('desktop');
		expect(selectCaptureBackend([broken, headless], env())).toBeNull();
	});
});

describe('headless browser backend — pure helpers', () => {
	it('opens only the Agent’s own profile, headless, with a debugging port chosen by the browser', () => {
		const args = buildHeadlessCaptureArgs('/profiles/abc/browser', { noSandbox: false });
		expect(args).toContain('--user-data-dir=/profiles/abc/browser');
		expect(args).toContain('--headless=new');
		expect(args).toContain('--remote-debugging-port=0');
		expect(args).not.toContain('--no-sandbox');
		expect(buildHeadlessCaptureArgs('/p', { noSandbox: true })).toContain('--no-sandbox');
	});

	it('reads a DevToolsActivePort file into a loopback endpoint and refuses anything else', () => {
		expect(parseDevToolsActivePort('9222\n/devtools/browser/abc-123\n')).toBe(
			'ws://127.0.0.1:9222/devtools/browser/abc-123'
		);
		expect(parseDevToolsActivePort(null)).toBeNull();
		expect(parseDevToolsActivePort('99999\n/devtools/browser/x')).toBeNull();
		expect(parseDevToolsActivePort('9222\n/evil?host=elsewhere')).toBeNull();
	});

	it('scales a viewport down to the preset width and never up', () => {
		expect(scaleForWidth(1920, 1080, 1280)).toEqual({ scale: 1280 / 1920, width: 1280, height: 720 });
		expect(scaleForWidth(800, 600, 1280)).toEqual({ scale: 1, width: 800, height: 600 });
	});

	it('counts distinct sites holding a secure, script-inaccessible cookie', () => {
		expect(
			countSessionCookieSites([
				{ domain: '.mail.example.com', secure: true, httpOnly: true },
				{ domain: 'example.com', secure: true, httpOnly: true },
				{ domain: 'tracker.test', secure: false, httpOnly: false },
				{ domain: 'bank.test', secure: true, httpOnly: true }
			])
		).toBe(2);
		expect(countSessionCookieSites('nonsense')).toBe(0);
	});
});

describe('HeadlessBrowserCaptureBackend.start', () => {
	it('attaches to the Agent’s browser already running in its profile instead of launching one', async () => {
		const spawnFn = vi.fn();
		const backend = new HeadlessBrowserCaptureBackend({
			browserPath: '/usr/bin/chromium',
			spawnFn: spawnFn as unknown as typeof spawn,
			readTextFile: async () => '9222\n/devtools/browser/abc\n',
			webSocketFactory: () => fakeBrowserSocket()
		});
		const source = await backend.start({ profileDir: '/profiles/abc/browser' });
		const picture = await source.capture({ width: 1280, quality: 70 });
		expect(spawnFn).not.toHaveBeenCalled();
		expect(picture).toEqual({ mime: 'image/jpeg', width: 1280, height: 720, data: 'QUJD' });
		expect(await source.countSignedInSites?.()).toBe(1);
		await source.stop();
	});

	it('launches the resolved browser in the Agent’s profile when none is running, and stops it with the view', async () => {
		const child = fakeChild();
		const calls: string[] = [];
		const spawnFn = vi.fn(() => {
			queueMicrotask(() =>
				child.stderr.emit('data', 'DevTools listening on ws://127.0.0.1:41234/devtools/browser/xyz\n')
			);
			return child;
		});
		const backend = new HeadlessBrowserCaptureBackend({
			browserPath: '/usr/bin/chromium',
			spawnFn: spawnFn as unknown as typeof spawn,
			parentEnv: { PATH: '/usr/bin', EVER_WORKS_NODE_SECRET: 'must-not-leak' },
			readTextFile: async () => null,
			webSocketFactory: () => fakeBrowserSocket((method) => calls.push(method))
		});
		const source = await backend.start({ profileDir: '/profiles/abc/browser' });
		const [, args, options] = spawnFn.mock.calls[0] as unknown as [
			string,
			string[],
			{ env: Record<string, string> }
		];
		expect(args).toContain('--user-data-dir=/profiles/abc/browser');
		expect(options.env).not.toHaveProperty('EVER_WORKS_NODE_SECRET');
		await source.stop();
		expect(calls).toContain('Browser.close');
		expect(child.kill).toHaveBeenCalled();
	});

	it('refuses to start without a WebSocket client, and kills a browser that never became ready', async () => {
		const noSocket = new HeadlessBrowserCaptureBackend({ browserPath: '/b', webSocketFactory: null });
		await expect(noSocket.start({ profileDir: '/p' })).rejects.toThrow(/WebSocket/);

		const child = fakeChild();
		const spawnFn = vi.fn(() => {
			queueMicrotask(() => child.emit('exit', 1));
			return child;
		});
		const backend = new HeadlessBrowserCaptureBackend({
			browserPath: '/b',
			spawnFn: spawnFn as unknown as typeof spawn,
			readTextFile: async () => null,
			webSocketFactory: () => fakeBrowserSocket()
		});
		await expect(backend.start({ profileDir: '/p' })).rejects.toThrow(/exited before it was ready/);
	});
});

/**
 * A browser with several tabs. `visibility` maps a tab to what its page
 * reports (`visible:true` = on screen and focused, `hidden:false` = a
 * background tab); a test flips it to switch tabs. Every call is recorded
 * with the session it was sent to.
 */
function fakeTabbedBrowser(visibility: Record<string, string>) {
	const calls: Array<{ method: string; sessionId?: string; params?: Record<string, unknown> }> = [];
	const sessionOf = new Map<string, string>();
	const tabOf = new Map<string, string>();
	let nextSession = 1;
	const socket: WebSocketLike = {
		readyState: 1,
		onopen: null,
		onmessage: null,
		onerror: null,
		onclose: null,
		send: (raw: string) => {
			const { id, method, params, sessionId } = JSON.parse(raw) as {
				id: number;
				method: string;
				params?: Record<string, unknown>;
				sessionId?: string;
			};
			calls.push({ method, ...(sessionId ? { sessionId } : {}), ...(params ? { params } : {}) });
			let result: Record<string, unknown> = {};
			if (method === 'Target.getTargets') {
				result = { targetInfos: Object.keys(visibility).map((targetId) => ({ type: 'page', targetId })) };
			} else if (method === 'Target.attachToTarget') {
				const targetId = String(params?.targetId);
				const session = `session-${nextSession++}`;
				sessionOf.set(targetId, session);
				tabOf.set(session, targetId);
				result = { sessionId: session };
			} else if (method === 'Runtime.evaluate') {
				const tab = sessionId ? tabOf.get(sessionId) : undefined;
				result = { result: { value: tab ? visibility[tab] : undefined } };
			} else if (method === 'Page.getLayoutMetrics') {
				result = { cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } };
			} else if (method === 'Page.captureScreenshot') {
				const tab = sessionId ? tabOf.get(sessionId) : undefined;
				result = { data: Buffer.from(`picture-of-${tab}`).toString('base64') };
			}
			queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ id, result }) }));
		},
		close: () => socket.onclose?.({})
	};
	const open = (): WebSocketLike => {
		queueMicrotask(() => socket.onopen?.({}));
		return socket;
	};
	const pictured = () =>
		calls
			.filter((call) => call.method === 'Page.captureScreenshot')
			.map((call) => (call.sessionId ? tabOf.get(call.sessionId) : undefined));
	return { open, calls, sessionOf, pictured };
}

describe('HeadlessBrowserCaptureBackend — which tab is pictured', () => {
	const attachTo = (browser: ReturnType<typeof fakeTabbedBrowser>) =>
		new HeadlessBrowserCaptureBackend({
			browserPath: '/usr/bin/chromium',
			readTextFile: async () => '9222\n/devtools/browser/abc\n',
			webSocketFactory: () => browser.open()
		});

	it('pictures the foreground tab, never the first background tab in the target list', async () => {
		const browser = fakeTabbedBrowser({ 'tab-mail': 'hidden:false', 'tab-work': 'visible:true' });
		const source = await attachTo(browser).start({ profileDir: '/profiles/abc/browser' });
		await source.capture({ width: 1280, quality: 70 });
		expect(browser.pictured()).toEqual(['tab-work']);
		// The background tab was only asked whether it is on screen, then let go.
		expect(browser.calls).toContainEqual(
			expect.objectContaining({
				method: 'Target.detachFromTarget',
				params: { sessionId: browser.sessionOf.get('tab-mail') }
			})
		);
		await source.stop();
	});

	it('follows the Agent to the tab it switches to', async () => {
		const tabs = { 'tab-mail': 'hidden:false', 'tab-work': 'visible:true' };
		const browser = fakeTabbedBrowser(tabs);
		const source = await attachTo(browser).start({ profileDir: '/profiles/abc/browser' });
		await source.capture({ width: 1280, quality: 70 });

		tabs['tab-work'] = 'hidden:false';
		tabs['tab-mail'] = 'visible:true';
		await source.capture({ width: 1280, quality: 70 });

		expect(browser.pictured()).toEqual(['tab-work', 'tab-mail']);
		await source.stop();
	});

	it('prefers the focused tab when several windows each show one', async () => {
		const browser = fakeTabbedBrowser({ 'tab-a': 'visible:false', 'tab-b': 'visible:true' });
		const source = await attachTo(browser).start({ profileDir: '/profiles/abc/browser' });
		await source.capture({ width: 1280, quality: 70 });
		expect(browser.pictured()).toEqual(['tab-b']);
		await source.stop();
	});

	it('refuses to picture anything when none of several tabs is in the foreground', async () => {
		const tabs = { 'tab-a': 'visible:true', 'tab-b': 'hidden:false' };
		const browser = fakeTabbedBrowser(tabs);
		const source = await attachTo(browser).start({ profileDir: '/profiles/abc/browser' });
		tabs['tab-a'] = 'hidden:false';
		await expect(source.capture({ width: 1280, quality: 70 })).rejects.toThrow(/foreground/);
		expect(browser.pictured()).toEqual([]);
		await source.stop();
	});

	it('keeps picturing a single tab even when it reports hidden (it is the only page the Agent has)', async () => {
		const browser = fakeTabbedBrowser({ 'tab-only': 'hidden:false' });
		const source = await attachTo(browser).start({ profileDir: '/profiles/abc/browser' });
		await source.capture({ width: 1280, quality: 70 });
		await source.capture({ width: 1280, quality: 70 });
		expect(browser.pictured()).toEqual(['tab-only', 'tab-only']);
		expect(browser.calls.filter((call) => call.method === 'Target.attachToTarget')).toHaveLength(1);
		await source.stop();
	});
});
