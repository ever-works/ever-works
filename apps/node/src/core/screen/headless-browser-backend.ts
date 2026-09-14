import { spawn, type ChildProcess } from 'child_process';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { buildNodeCheckEnv } from '../executors/acceptance-checks';
import { BROWSER_NO_SANDBOX_ENV } from '../executors/browser-check';
import {
	HEADLESS_BROWSER_CAPTURE_AVAILABILITY,
	type CaptureBackend,
	type CaptureEnvironment,
	type CapturedPicture,
	type CaptureRequest,
	type CaptureSource,
	type CaptureStartInput
} from './capture-backend';
import { CdpConnection, defaultWebSocketFactory, type WebSocketFactory } from './cdp-connection';

/**
 * Agent computers — the first capture backend: the Agent's own browser,
 * pictured over the browser debugging protocol.
 *
 * On `start` it looks for the Agent's browser ALREADY running in the Agent's
 * profile directory (a Chromium browser started with a debugging port writes
 * `DevToolsActivePort` into its profile) and attaches to it, so the owner
 * sees the page the Agent is actually on. When none is running it launches
 * the machine's browser — the one `browser-probe.ts` resolved, the same
 * binary the `browser` and `screen` tags stand on — headless, in that same
 * profile directory, so sign-ins persist for that Agent and no other.
 *
 * It only ever TAKES PICTURES: it never navigates, types or clicks, and a
 * browser it attached to is left running when the view ends (it belongs to
 * the Agent). A browser it launched is stopped with the view.
 *
 * Every picture is a full keyframe scaled DOWN to the preset width (never up)
 * from the page's visible viewport, so the Agent's own window size is never
 * changed by someone watching it.
 */

export const HEADLESS_BROWSER_START_TIMEOUT_MS = 20_000;
/** The profile file a debugging-enabled Chromium browser writes with its port. */
export const DEVTOOLS_ACTIVE_PORT_FILE = 'DevToolsActivePort';

const DEVTOOLS_LISTENING_PATTERN = /DevTools listening on (ws:\/\/[^\s]+)/;

export interface HeadlessBrowserCaptureIo {
	/** The resolved browser executable (from the shared probe). */
	browserPath: string;
	spawnFn?: typeof spawn;
	parentEnv?: NodeJS.ProcessEnv;
	webSocketFactory?: WebSocketFactory | null;
	/** Reads a text file, null when absent. */
	readTextFile?: (path: string) => Promise<string | null>;
	startTimeoutMs?: number;
}

export class HeadlessBrowserCaptureBackend implements CaptureBackend {
	readonly id = HEADLESS_BROWSER_CAPTURE_AVAILABILITY.id;

	constructor(private readonly io: HeadlessBrowserCaptureIo) {}

	isAvailable(environment: CaptureEnvironment): boolean {
		return HEADLESS_BROWSER_CAPTURE_AVAILABILITY.isAvailable(environment);
	}

	async start(input: CaptureStartInput): Promise<CaptureSource> {
		const factory = this.io.webSocketFactory === undefined ? defaultWebSocketFactory() : this.io.webSocketFactory;
		if (!factory) {
			throw new Error('This Node.js runtime has no WebSocket client; live view needs Node 22 or newer');
		}
		const attached = await this.tryAttach(input.profileDir, factory);
		if (attached) return attached;
		return this.launch(input, factory);
	}

	/** The Agent's own browser, when it is already running with a debugging port in its profile. */
	private async tryAttach(profileDir: string, factory: WebSocketFactory): Promise<CaptureSource | null> {
		const read = this.io.readTextFile ?? defaultReadTextFile;
		const endpoint = parseDevToolsActivePort(await read(join(profileDir, DEVTOOLS_ACTIVE_PORT_FILE)));
		if (!endpoint) return null;
		try {
			const cdp = await CdpConnection.open(endpoint, factory, { timeoutMs: 3000 });
			return await BrowserPageSource.create(cdp, null);
		} catch {
			// A stale file from a browser that is gone — launch our own instead.
			return null;
		}
	}

	private async launch(input: CaptureStartInput, factory: WebSocketFactory): Promise<CaptureSource> {
		const parentEnv = this.io.parentEnv ?? process.env;
		const noSandbox = String(parentEnv[BROWSER_NO_SANDBOX_ENV] ?? '').trim() === '1';
		const args = buildHeadlessCaptureArgs(input.profileDir, { noSandbox });
		const child = (this.io.spawnFn ?? spawn)(this.io.browserPath, args, {
			windowsHide: true,
			// The same scrubbed, allowlisted environment every browser this node
			// starts gets — never this node's own credential namespace.
			env: buildNodeCheckEnv(null, parentEnv)
		});
		try {
			const endpoint = await waitForDevToolsEndpoint(
				child,
				this.io.startTimeoutMs ?? HEADLESS_BROWSER_START_TIMEOUT_MS,
				input.signal
			);
			const cdp = await CdpConnection.open(endpoint, factory);
			return await BrowserPageSource.create(cdp, child);
		} catch (error) {
			killQuietly(child);
			throw error;
		}
	}
}

/** Command line for a capture browser: the Agent's profile, headless, no port picked by us. */
export function buildHeadlessCaptureArgs(profileDir: string, options: { noSandbox: boolean }): string[] {
	const args = [
		`--user-data-dir=${profileDir}`,
		'--headless=new',
		'--remote-debugging-port=0',
		'--no-first-run',
		'--no-default-browser-check',
		'--window-size=1280,800'
	];
	if (options.noSandbox) args.push('--no-sandbox', '--disable-dev-shm-usage');
	args.push('about:blank');
	return args;
}

/** `DevToolsActivePort` → a loopback endpoint, or null for anything else. */
export function parseDevToolsActivePort(content: string | null): string | null {
	if (typeof content !== 'string') return null;
	const [portLine, pathLine] = content.split(/\r?\n/);
	const port = Number.parseInt((portLine ?? '').trim(), 10);
	const path = (pathLine ?? '').trim();
	if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
	if (!/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(path)) return null;
	// Loopback only — this never reaches another machine.
	return `ws://127.0.0.1:${port}${path}`;
}

/**
 * The endpoint a browser we launched announced on stderr, held to the same
 * shape {@link parseDevToolsActivePort} accepts: plain `ws:` to loopback,
 * a real port, and a `/devtools/browser/<id>` path. Anything else is null,
 * so a debugging connection is never opened to another host.
 */
export function parseDevToolsListeningLine(output: string): string | null {
	const match = DEVTOOLS_LISTENING_PATTERN.exec(output);
	if (!match) return null;
	let url: URL;
	try {
		url = new URL(match[1]);
	} catch {
		return null;
	}
	if (url.protocol !== 'ws:' || (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]')) return null;
	if (url.search || url.hash || url.username || url.password) return null;
	const port = Number.parseInt(url.port, 10);
	if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
	if (!/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(url.pathname)) return null;
	return `ws://${url.hostname}:${port}${url.pathname}`;
}

/** Scale a viewport down to a preset width, never up. */
export function scaleForWidth(
	viewportWidth: number,
	viewportHeight: number,
	targetWidth: number
): { scale: number; width: number; height: number } {
	const safeWidth = Math.max(1, Math.floor(viewportWidth));
	const safeHeight = Math.max(1, Math.floor(viewportHeight));
	const scale = Math.min(1, Math.max(1, targetWidth) / safeWidth);
	return {
		scale,
		width: Math.max(1, Math.round(safeWidth * scale)),
		height: Math.max(1, Math.round(safeHeight * scale))
	};
}

/**
 * Count distinct sites holding a cookie shaped like a session: `secure` and
 * inaccessible to page script (`httpOnly`). An approximation — the browser
 * does not label a cookie "signed in" — biased toward cookies that carry
 * authentication rather than every tracking cookie a page sets.
 */
export function countSessionCookieSites(cookies: unknown): number {
	if (!Array.isArray(cookies)) return 0;
	const sites = new Set<string>();
	for (const cookie of cookies) {
		if (!cookie || typeof cookie !== 'object') continue;
		const { domain, secure, httpOnly } = cookie as { domain?: unknown; secure?: unknown; httpOnly?: unknown };
		if (typeof domain !== 'string' || secure !== true || httpOnly !== true) continue;
		const labels = domain.replace(/^\./, '').toLowerCase().split('.').filter(Boolean);
		if (labels.length === 0) continue;
		sites.add(labels.slice(-2).join('.'));
	}
	return sites.size;
}

/** A page target this connection is attached to. */
interface AttachedPage {
	targetId: string;
	sessionId: string;
}

/** How a page reports whether it is on screen: `visibilityState:hasFocus`. */
const FOREGROUND_PROBE_EXPRESSION = "document.visibilityState + ':' + document.hasFocus()";

/**
 * How much a page is the one on screen: 2 visible and focused, 1 visible,
 * 0 hidden (a background tab) or unreadable (a tab that closed mid-probe).
 */
async function foregroundScore(cdp: CdpConnection, sessionId: string): Promise<number> {
	try {
		const probe = await cdp.send(
			'Runtime.evaluate',
			{ expression: FOREGROUND_PROBE_EXPRESSION, returnByValue: true },
			sessionId
		);
		const value = (probe.result as { value?: unknown } | undefined)?.value;
		if (typeof value !== 'string' || !value.startsWith('visible:')) return 0;
		return value === 'visible:true' ? 2 : 1;
	} catch {
		return 0;
	}
}

async function attachToPage(cdp: CdpConnection, targetId: string): Promise<AttachedPage> {
	const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
	if (typeof attached.sessionId !== 'string') throw new Error('Could not attach to the browser page');
	return { targetId, sessionId: attached.sessionId };
}

async function detachQuietly(cdp: CdpConnection, sessionId: string): Promise<void> {
	try {
		await cdp.send('Target.detachFromTarget', { sessionId });
	} catch {
		// the tab is already gone
	}
}

/**
 * The page the Agent has on screen, attached. A browser with ONE tab shows
 * that tab. With several, every tab is asked whether it is visible (and
 * focused), and only the foreground one is ever pictured: the first tab in
 * the target list is often a background page the Agent is not looking at.
 * When no tab is in the foreground this refuses rather than guess.
 *
 * `current` is reused (never re-attached) when it is still the answer, and
 * every session this opened or held that is not the answer is detached.
 */
async function attachForegroundPage(cdp: CdpConnection, current: AttachedPage | null): Promise<AttachedPage> {
	const targets = await cdp.send('Target.getTargets');
	const infos = Array.isArray(targets.targetInfos) ? (targets.targetInfos as Array<Record<string, unknown>>) : [];
	const pageIds = infos
		.filter((info) => info.type === 'page' && typeof info.targetId === 'string')
		.map((info) => info.targetId as string);
	const release = async (keep: AttachedPage | null, sessions: AttachedPage[]): Promise<void> => {
		for (const page of sessions) {
			if (page.sessionId !== keep?.sessionId) await detachQuietly(cdp, page.sessionId);
		}
	};

	if (pageIds.length === 0) {
		const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
		if (typeof created.targetId !== 'string') throw new Error('The browser has no page to show');
		const page = await attachToPage(cdp, created.targetId);
		await release(page, current ? [current] : []);
		return page;
	}
	if (pageIds.length === 1) {
		const page = current?.targetId === pageIds[0] ? current : await attachToPage(cdp, pageIds[0]);
		await release(page, current ? [current] : []);
		return page;
	}

	const probed: AttachedPage[] = [];
	let best: { page: AttachedPage; score: number } | null = null;
	try {
		for (const targetId of pageIds) {
			const page = current?.targetId === targetId ? current : await attachToPage(cdp, targetId);
			probed.push(page);
			const score = await foregroundScore(cdp, page.sessionId);
			if (score > (best?.score ?? 0)) best = { page, score };
			if (score === 2) break;
		}
	} catch (error) {
		await release(null, current && !probed.includes(current) ? [...probed, current] : probed);
		throw error;
	}
	const chosen = best?.page ?? null;
	await release(chosen, current && !probed.includes(current) ? [...probed, current] : probed);
	if (!chosen) throw new Error('No tab of the browser is in the foreground to show');
	return chosen;
}

class BrowserPageSource implements CaptureSource {
	private stopped = false;

	private constructor(
		private readonly cdp: CdpConnection,
		private readonly launched: ChildProcess | null,
		private page: AttachedPage
	) {}

	static async create(cdp: CdpConnection, launched: ChildProcess | null): Promise<BrowserPageSource> {
		try {
			return new BrowserPageSource(cdp, launched, await attachForegroundPage(cdp, null));
		} catch (error) {
			cdp.close();
			throw error;
		}
	}

	/**
	 * The session of the page on screen NOW. The Agent may have switched tabs
	 * (or closed this one) since the last picture, so a page that is no longer
	 * visible is re-resolved before anything of it is captured.
	 */
	private async foregroundSession(): Promise<string> {
		if ((await foregroundScore(this.cdp, this.page.sessionId)) > 0) return this.page.sessionId;
		this.page = await attachForegroundPage(this.cdp, this.page);
		return this.page.sessionId;
	}

	async capture(request: CaptureRequest): Promise<CapturedPicture> {
		if (this.stopped) throw new Error('Capture source is stopped');
		const sessionId = await this.foregroundSession();
		const metrics = await this.cdp.send('Page.getLayoutMetrics', {}, sessionId);
		const viewport = (metrics.cssVisualViewport ?? metrics.cssLayoutViewport ?? metrics.layoutViewport) as
			| { clientWidth?: number; clientHeight?: number }
			| undefined;
		const size = scaleForWidth(viewport?.clientWidth ?? 1280, viewport?.clientHeight ?? 800, request.width);
		const shot = await this.cdp.send(
			'Page.captureScreenshot',
			{
				format: 'jpeg',
				quality: Math.min(100, Math.max(1, Math.round(request.quality))),
				fromSurface: true,
				clip: {
					x: 0,
					y: 0,
					width: Math.max(1, Math.floor(viewport?.clientWidth ?? 1280)),
					height: Math.max(1, Math.floor(viewport?.clientHeight ?? 800)),
					scale: size.scale
				}
			},
			sessionId
		);
		if (typeof shot.data !== 'string' || shot.data.length === 0) {
			throw new Error('The browser returned an empty picture');
		}
		return { mime: 'image/jpeg', width: size.width, height: size.height, data: shot.data };
	}

	async countSignedInSites(): Promise<number | null> {
		if (this.stopped) return null;
		try {
			const result = await this.cdp.send('Storage.getCookies');
			return countSessionCookieSites(result.cookies);
		} catch {
			return null;
		}
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		if (this.launched) {
			// Ours: ask the browser to close cleanly (flushes the profile's
			// cookies to disk), then make sure the process is gone.
			try {
				await this.cdp.send('Browser.close');
			} catch {
				// fall through to the kill
			}
			killQuietly(this.launched);
		}
		this.cdp.close();
	}
}

function waitForDevToolsEndpoint(child: ChildProcess, timeoutMs: number, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		let stderr = '';
		let settled = false;
		const finish = (error: Error | null, endpoint?: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			if (error) reject(error);
			else resolve(endpoint as string);
		};
		const onAbort = (): void => finish(new Error('Starting the browser was cancelled'));
		const timer = setTimeout(() => finish(new Error('The browser did not start in time')), timeoutMs);
		signal?.addEventListener('abort', onAbort, { once: true });
		child.stderr?.on('data', (chunk: Buffer | string) => {
			stderr = (stderr + chunk.toString()).slice(-4096);
			const endpoint = parseDevToolsListeningLine(stderr);
			if (endpoint) finish(null, endpoint);
		});
		child.once('error', (error: Error) => finish(new Error(`The browser could not start: ${error.message}`)));
		child.once('exit', (code: number | null) =>
			finish(new Error(`The browser exited before it was ready (code ${code})`))
		);
	});
}

function killQuietly(child: ChildProcess): void {
	try {
		if (child.exitCode === null && !child.killed) child.kill();
	} catch {
		// already gone
	}
}

async function defaultReadTextFile(path: string): Promise<string | null> {
	try {
		return await fsp.readFile(path, 'utf8');
	} catch {
		return null;
	}
}
