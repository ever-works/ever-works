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

class BrowserPageSource implements CaptureSource {
	private stopped = false;

	private constructor(
		private readonly cdp: CdpConnection,
		private readonly launched: ChildProcess | null,
		private readonly sessionId: string
	) {}

	static async create(cdp: CdpConnection, launched: ChildProcess | null): Promise<BrowserPageSource> {
		try {
			const targets = await cdp.send('Target.getTargets');
			const infos = Array.isArray(targets.targetInfos)
				? (targets.targetInfos as Array<Record<string, unknown>>)
				: [];
			let targetId = infos.find((info) => info.type === 'page' && typeof info.targetId === 'string')?.targetId as
				| string
				| undefined;
			if (!targetId) {
				const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
				targetId = typeof created.targetId === 'string' ? created.targetId : undefined;
			}
			if (!targetId) throw new Error('The browser has no page to show');
			const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
			if (typeof attached.sessionId !== 'string') throw new Error('Could not attach to the browser page');
			return new BrowserPageSource(cdp, launched, attached.sessionId);
		} catch (error) {
			cdp.close();
			throw error;
		}
	}

	async capture(request: CaptureRequest): Promise<CapturedPicture> {
		if (this.stopped) throw new Error('Capture source is stopped');
		const metrics = await this.cdp.send('Page.getLayoutMetrics', {}, this.sessionId);
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
			this.sessionId
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
			const match = DEVTOOLS_LISTENING_PATTERN.exec(stderr);
			if (match) finish(null, match[1]);
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
