import { describe, expect, it } from 'vitest';
import { BROWSER_PATH_ENV, browserCandidates, resolveBrowserPath } from './browser-probe';

/** Probe IO whose "installed" set is an explicit list of paths. */
function io(options: {
	platform?: string;
	env?: Record<string, string | undefined>;
	installed?: string[];
	onPath?: Record<string, string>;
}) {
	const installed = new Set(options.installed ?? []);
	return {
		platform: options.platform ?? 'linux',
		env: options.env ?? {},
		fileExists: (path: string) => installed.has(path),
		lookupOnPath: (command: string) => options.onPath?.[command] ?? null
	};
}

describe('browserCandidates', () => {
	it('offers the per-platform install locations', () => {
		expect(browserCandidates('linux', {})).toContain('/usr/bin/google-chrome');
		expect(browserCandidates('darwin', {})).toContain(
			'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
		);
		const windows = browserCandidates('win32', { PROGRAMFILES: 'C:\\Program Files' });
		expect(windows).toContain('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
	});

	it('falls back to conventional Windows roots when the env is empty', () => {
		const windows = browserCandidates('win32', {});
		expect(windows.some((path) => path.startsWith('C:\\Program Files'))).toBe(true);
	});

	it('treats an unknown platform as POSIX rather than returning nothing', () => {
		expect(browserCandidates('freebsd', {}).length).toBeGreaterThan(0);
	});
});

describe('resolveBrowserPath', () => {
	it('finds an installed browser at a platform location', () => {
		expect(resolveBrowserPath(io({ installed: ['/usr/bin/chromium'] }))).toBe('/usr/bin/chromium');
	});

	it('returns null when nothing is installed — this is what keeps the `browser` tag honest', () => {
		expect(resolveBrowserPath(io({}))).toBeNull();
	});

	it('prefers an explicit override over anything installed', () => {
		const resolved = resolveBrowserPath(
			io({
				env: { [BROWSER_PATH_ENV]: '/opt/custom/browser' },
				installed: ['/opt/custom/browser', '/usr/bin/chromium']
			})
		);
		expect(resolved).toBe('/opt/custom/browser');
	});

	it('a pinned override that does not exist disables the capability rather than falling through', () => {
		// Silently launching a different engine than the one an operator
		// chose is how a check passes for the wrong reason.
		const resolved = resolveBrowserPath(
			io({ env: { [BROWSER_PATH_ENV]: '/opt/missing' }, installed: ['/usr/bin/chromium'] })
		);
		expect(resolved).toBeNull();
	});

	it('falls back to PATH lookup when no absolute candidate exists', () => {
		const resolved = resolveBrowserPath(io({ onPath: { chromium: '/snap/bin/chromium' } }));
		expect(resolved).toBe('/snap/bin/chromium');
	});

	it('prefers an installed absolute candidate over a PATH hit', () => {
		const resolved = resolveBrowserPath(
			io({ installed: ['/usr/bin/google-chrome'], onPath: { chromium: '/snap/bin/chromium' } })
		);
		expect(resolved).toBe('/usr/bin/google-chrome');
	});

	it('works with no PATH lookup wired at all', () => {
		const probe = io({ installed: [] });
		const resolved = resolveBrowserPath({
			platform: probe.platform,
			env: probe.env,
			fileExists: probe.fileExists
		});
		expect(resolved).toBeNull();
	});
});
