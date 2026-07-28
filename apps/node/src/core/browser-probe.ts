/**
 * Browser discovery for the node.
 *
 * One probe, two consumers:
 *
 *   - `capabilities.ts` decides whether to advertise the `browser` tag;
 *   - `executors/browser-check.ts` spawns exactly the binary this probe
 *     found.
 *
 * They MUST be the same function. A node that advertises `browser`
 * because some heuristic said so, and then cannot find anything to
 * launch when a `browser-check` job lands, is worse than a node that
 * never advertised at all: the scheduler routed real work to it on the
 * strength of a tag that was a lie (audit A22/A26).
 *
 * Everything is injected — platform, environment, an existence probe —
 * so the whole candidate matrix is unit-testable on any host.
 */

/** Environment variable that pins the browser executable explicitly. */
export const BROWSER_PATH_ENV = 'EVER_WORKS_NODE_BROWSER';

/** Names looked up on `PATH` when no absolute candidate exists. */
export const BROWSER_PATH_COMMANDS: readonly string[] = [
	'google-chrome-stable',
	'google-chrome',
	'chromium-browser',
	'chromium',
	'microsoft-edge-stable',
	'microsoft-edge',
	'brave-browser'
];

export interface BrowserProbeIo {
	/** `process.platform`. */
	platform: string;
	env: Record<string, string | undefined>;
	/** True when the path names an existing, executable file. */
	fileExists(path: string): boolean;
	/** Resolve a bare command name on `PATH`; null when absent. */
	lookupOnPath?(command: string): string | null;
}

function windowsCandidates(env: Record<string, string | undefined>): string[] {
	const roots = [
		env.PROGRAMFILES,
		env['PROGRAMFILES(X86)'],
		env.LOCALAPPDATA,
		'C:\\Program Files',
		'C:\\Program Files (x86)'
	].filter((root): root is string => typeof root === 'string' && root.length > 0);

	const suffixes = [
		'\\Google\\Chrome\\Application\\chrome.exe',
		'\\Microsoft\\Edge\\Application\\msedge.exe',
		'\\Chromium\\Application\\chrome.exe',
		'\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
	];

	const out: string[] = [];
	for (const root of roots) {
		for (const suffix of suffixes) {
			out.push(`${root.replace(/\\+$/, '')}${suffix}`);
		}
	}
	return out;
}

const DARWIN_CANDIDATES: readonly string[] = [
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/Applications/Chromium.app/Contents/MacOS/Chromium',
	'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
	'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
];

const POSIX_CANDIDATES: readonly string[] = [
	'/usr/bin/google-chrome-stable',
	'/usr/bin/google-chrome',
	'/usr/bin/chromium-browser',
	'/usr/bin/chromium',
	'/usr/bin/microsoft-edge-stable',
	'/usr/bin/microsoft-edge',
	'/usr/bin/brave-browser',
	'/snap/bin/chromium',
	'/opt/google/chrome/chrome'
];

/** Absolute paths worth probing on this platform, most-preferred first. */
export function browserCandidates(platform: string, env: Record<string, string | undefined>): string[] {
	if (platform === 'win32') {
		return windowsCandidates(env);
	}
	if (platform === 'darwin') {
		return [...DARWIN_CANDIDATES];
	}
	return [...POSIX_CANDIDATES];
}

/**
 * Resolve a usable browser executable, or null.
 *
 * Order: the explicit `EVER_WORKS_NODE_BROWSER` override (an operator
 * saying "use this one" always wins), then the platform's install
 * locations, then bare command names on `PATH`. A configured override
 * that does NOT exist resolves to null rather than falling through —
 * silently launching a different browser than the one an operator
 * pinned is how a check passes on the wrong engine.
 */
export function resolveBrowserPath(io: BrowserProbeIo): string | null {
	const override = io.env[BROWSER_PATH_ENV]?.trim();
	if (override) {
		return io.fileExists(override) ? override : null;
	}

	for (const candidate of browserCandidates(io.platform, io.env)) {
		if (io.fileExists(candidate)) {
			return candidate;
		}
	}

	if (io.lookupOnPath) {
		for (const command of BROWSER_PATH_COMMANDS) {
			const resolved = io.lookupOnPath(command);
			if (resolved) {
				return resolved;
			}
		}
	}

	return null;
}
