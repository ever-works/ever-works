import { spawn } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { FleetBrowserCheckPayload, FleetBrowserCheckResult, FleetJobView } from '@ever-works/contracts';
import { resolveBrowserPath, type BrowserProbeIo } from '../browser-probe';
import { buildNodeCheckEnv } from './acceptance-checks';

/**
 * The `browser-check` executor — the node's v2 job kind (audit A26).
 *
 * ## Why this exists
 *
 * The node advertises a `browser` capability tag. Until this module,
 * nothing on the machine ever launched a browser, so the tag was a
 * claim with no work behind it: the platform could route
 * browser-required jobs to a node that had never opened one, and only
 * discover the gap when the job failed for reasons nobody could see.
 *
 * A capability and the executor that honours it have to ship together.
 * `browser-check` is the smallest honest unit of browser work: load a
 * URL in the machine's REAL browser and report what it rendered.
 *
 * ## Two modes, two different proofs
 *
 * - **headless (default)** — `--headless=new --dump-dom <url>`. Chrome
 *   prints the serialized DOM to stdout, so the verdict is a real
 *   observation: bytes rendered, the document title, and an optional
 *   `expectText` substring. This is the mode a CI-style check wants.
 *
 * - **headed** — a visible window on a machine that advertises
 *   `display`. Chrome has no `--dump-dom` outside headless, so the
 *   proof here is weaker BY CONSTRUCTION: the browser opened a window
 *   against the URL and stayed alive for the settle window. Rather than
 *   pretend otherwise, a headed job that asks for `expectText` is
 *   REFUSED — quietly downgrading an assertion to "the process did not
 *   crash" would turn an unverifiable check green.
 *
 * ## Isolation
 *
 * Every run gets a throwaway `--user-data-dir`, so a job can neither
 * read the operator's real profile (cookies, saved passwords, history)
 * nor leave anything behind in it. The child environment is built by
 * `buildNodeCheckEnv` — the same scrubbed, allowlisted env the
 * acceptance-check executor uses, which notably excludes this node's
 * own fleet credential namespace.
 */

/** Wall-clock budget when the payload declares no `timeoutSec`. */
export const DEFAULT_BROWSER_TIMEOUT_SEC = 60;

/** Hard ceiling, so a typo'd `timeoutSec` cannot pin a node forever. */
export const MAX_BROWSER_TIMEOUT_SEC = 300;

/** How long a headed window must stay up to count as a successful load. */
export const HEADED_SETTLE_MS = 5_000;

/** Largest DOM we keep in memory before we stop appending. */
export const MAX_DOM_CAPTURE_BYTES = 2 * 1024 * 1024;

export class BrowserCheckPayloadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BrowserCheckPayloadError';
	}
}

/** Injected so the whole executor is testable without launching a browser. */
export interface BrowserCheckIo {
	spawnFn?: typeof spawn;
	/** Resolves the browser executable; defaults to the shared probe. */
	resolveBrowser?: () => string | null;
	/** Host facts for the default probe. */
	probe?: Partial<BrowserProbeIo>;
	/** Whether the host has a display (gates `headed`). */
	hasDisplay?: boolean;
	parentEnv?: NodeJS.ProcessEnv;
	now?: () => number;
	/** Throwaway profile directory factory; defaults to a real mkdtemp. */
	createProfileDir?: () => string;
	/** Profile cleanup; defaults to a recursive rm. */
	removeProfileDir?: (dir: string) => void;
}

/** Validated, defaulted view of the wire payload. */
export interface NormalizedBrowserCheck {
	url: string;
	headed: boolean;
	expectText: string | null;
	timeoutSec: number;
}

/**
 * Validate the wire payload.
 *
 * Refuses rather than repairs: a check pointed at the wrong URL, or one
 * whose assertion cannot be evaluated in the requested mode, must fail
 * loudly instead of reporting a verdict nobody can trust.
 */
export function normalizeBrowserCheck(raw: unknown): NormalizedBrowserCheck {
	if (!raw || typeof raw !== 'object') {
		throw new BrowserCheckPayloadError('Job payload is missing');
	}
	const payload = raw as FleetBrowserCheckPayload;

	const url = typeof payload.url === 'string' ? payload.url.trim() : '';
	if (!url) {
		throw new BrowserCheckPayloadError('Job payload has no url');
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new BrowserCheckPayloadError(`Job payload url is not a valid URL: ${url}`);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		// `file:` would turn a browser check into an arbitrary local-file
		// read, and the exotic schemes (`chrome://`, `javascript:`) are
		// browser-internal surfaces, not things a platform job may drive.
		throw new BrowserCheckPayloadError('Job payload url must be http(s)');
	}

	const headed = payload.headed === true;
	const expectText = typeof payload.expectText === 'string' && payload.expectText ? payload.expectText : null;
	if (headed && expectText) {
		throw new BrowserCheckPayloadError(
			'expectText cannot be verified in headed mode — the browser only exposes the DOM when headless'
		);
	}

	const requested =
		typeof payload.timeoutSec === 'number' && payload.timeoutSec > 0
			? payload.timeoutSec
			: DEFAULT_BROWSER_TIMEOUT_SEC;

	return {
		url: parsed.toString(),
		headed,
		expectText,
		timeoutSec: Math.min(requested, MAX_BROWSER_TIMEOUT_SEC)
	};
}

/** Extract `<title>` from a serialized DOM, or null. */
export function extractTitle(dom: string): string | null {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(dom);
	if (!match) {
		return null;
	}
	const title = match[1].replace(/\s+/g, ' ').trim();
	return title ? title.slice(0, 200) : null;
}

/**
 * Command line for one run.
 *
 * Every flag here is either isolation (`--user-data-dir`, no first-run
 * wizard, no background networking) or determinism (`--no-default-*`).
 * `--no-sandbox` is NOT added by default — it is a real weakening of
 * the browser's own protections and is only correct inside an already
 * isolated container, so it is opt-in through the environment.
 */
export function buildBrowserArgs(
	check: NormalizedBrowserCheck,
	profileDir: string,
	options: { noSandbox: boolean }
): string[] {
	const args = [
		`--user-data-dir=${profileDir}`,
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-background-networking',
		'--disable-extensions',
		'--disable-sync',
		'--window-size=1280,900'
	];
	if (options.noSandbox) {
		args.push('--no-sandbox', '--disable-dev-shm-usage');
	}
	if (check.headed) {
		args.push('--new-window', check.url);
		return args;
	}
	args.push(
		'--headless=new',
		'--disable-gpu',
		// Fast-forwards timers so a page whose load event is gated on a
		// setTimeout does not burn the whole budget.
		`--virtual-time-budget=${Math.min(check.timeoutSec, 30) * 1000}`,
		'--dump-dom',
		check.url
	);
	return args;
}

/** Env var that opts a containerized node into `--no-sandbox`. */
export const BROWSER_NO_SANDBOX_ENV = 'EVER_WORKS_NODE_BROWSER_NO_SANDBOX';

function defaultProfileDir(): string {
	return mkdtempSync(join(tmpdir(), 'ever-works-node-browser-'));
}

function defaultRemoveProfileDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// A leftover temp profile is untidy, not a failure of the check.
	}
}

/**
 * Run one `browser-check` job to a verdict.
 *
 * Throws only on a payload or a host the node CANNOT honour (no browser
 * installed, headed asked for on a machine with no display). A page
 * that fails to render is a normal RESULT — that is the verdict the
 * platform asked for.
 */
export async function runBrowserCheckJob(job: FleetJobView, io: BrowserCheckIo = {}): Promise<FleetBrowserCheckResult> {
	const check = normalizeBrowserCheck(job.payload);

	const browserPath = (io.resolveBrowser ?? (() => defaultResolveBrowser(io)))();
	if (!browserPath) {
		throw new BrowserCheckPayloadError(
			'No browser executable found on this node — it should not be advertising the `browser` capability'
		);
	}
	if (check.headed && io.hasDisplay === false) {
		throw new BrowserCheckPayloadError('A headed browser check needs a display; this node has none');
	}

	const parentEnv = io.parentEnv ?? process.env;
	const now = io.now ?? (() => Date.now());
	const createProfileDir = io.createProfileDir ?? defaultProfileDir;
	const removeProfileDir = io.removeProfileDir ?? defaultRemoveProfileDir;
	const profileDir = createProfileDir();
	const noSandbox = String(parentEnv[BROWSER_NO_SANDBOX_ENV] ?? '').trim() === '1';
	const args = buildBrowserArgs(check, profileDir, { noSandbox });

	try {
		return await launch(browserPath, args, check, { spawnFn: io.spawnFn ?? spawn, parentEnv, now });
	} finally {
		removeProfileDir(profileDir);
	}
}

function defaultResolveBrowser(io: BrowserCheckIo): string | null {
	const probe = io.probe ?? {};
	return resolveBrowserPath({
		platform: probe.platform ?? process.platform,
		env: (probe.env ?? process.env) as Record<string, string | undefined>,
		fileExists: probe.fileExists ?? ((path: string) => existsSync(path)),
		...(probe.lookupOnPath ? { lookupOnPath: probe.lookupOnPath } : {})
	});
}

function launch(
	browserPath: string,
	args: string[],
	check: NormalizedBrowserCheck,
	deps: { spawnFn: typeof spawn; parentEnv: NodeJS.ProcessEnv; now: () => number }
): Promise<FleetBrowserCheckResult> {
	const startedAt = deps.now();

	return new Promise<FleetBrowserCheckResult>((resolve) => {
		let settled = false;
		let dom = '';
		let stderrTail = '';
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settleTimer: ReturnType<typeof setTimeout> | undefined;

		const finish = (ok: boolean, error?: string): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (settleTimer) clearTimeout(settleTimer);
			const result: FleetBrowserCheckResult = {
				ok,
				browserPath,
				headless: !check.headed,
				domBytes: Buffer.byteLength(dom, 'utf8'),
				title: check.headed ? null : extractTitle(dom),
				durationMs: deps.now() - startedAt
			};
			if (!ok && error) {
				result.error = error;
			}
			resolve(result);
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = deps.spawnFn(browserPath, args, {
				windowsHide: !check.headed,
				// Never inherit: a browser check is user-authored input and
				// a fleet node is somebody's actual machine.
				env: buildNodeCheckEnv(null, deps.parentEnv)
			});
		} catch (error) {
			finish(false, error instanceof Error ? error.message : String(error));
			return;
		}

		timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill('SIGKILL');
			} catch {
				// Already gone — the close handler settles.
			}
		}, check.timeoutSec * 1000);

		child.stdout?.on('data', (chunk: Buffer | string) => {
			if (dom.length < MAX_DOM_CAPTURE_BYTES) {
				dom += chunk.toString();
			}
		});
		child.stderr?.on('data', (chunk: Buffer | string) => {
			stderrTail = (stderrTail + chunk.toString()).slice(-2048);
		});

		child.on('error', (error: Error) => {
			finish(false, error.message);
		});

		if (check.headed) {
			// A window that is still up after the settle window is the
			// strongest signal headed mode can give us. Kill it then, so
			// a check does not leave a browser open on someone's desktop.
			settleTimer = setTimeout(() => {
				try {
					child.kill();
				} catch {
					// Already gone — the close handler settles.
				}
				finish(true);
			}, HEADED_SETTLE_MS);
		}

		child.on('close', (code: number | null) => {
			if (timedOut) {
				finish(false, `Browser did not finish within ${check.timeoutSec}s`);
				return;
			}
			if (check.headed) {
				// Reaching close BEFORE the settle timer means the browser
				// exited early — a crash or a refusal to start.
				finish(false, `Browser window closed after ${deps.now() - startedAt}ms: ${stderrTail.trim()}`.trim());
				return;
			}
			if (code !== 0) {
				finish(false, `Browser exited with code ${code}: ${stderrTail.trim()}`.trim());
				return;
			}
			if (dom.trim().length === 0) {
				finish(false, 'Browser produced an empty document');
				return;
			}
			if (check.expectText && !dom.includes(check.expectText)) {
				finish(false, 'Rendered document did not contain the expected text');
				return;
			}
			finish(true);
		});
	});
}
