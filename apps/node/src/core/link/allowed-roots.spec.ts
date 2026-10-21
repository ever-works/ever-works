import { describe, expect, it } from 'vitest';
import {
	isFilesystemRoot,
	isInsideRoot,
	resolveAllowedRoots,
	resolveUnderRoots,
	standardLogDirs,
	type RootsFs
} from './allowed-roots';

/**
 * Fleet node link — the allowed-roots resolver (CONTRACTS R-18, R-39; FL-08
 * T-03): symlink escapes, `..`, sibling cousins, Windows case, the home
 * directory and filesystem roots.
 */

/** A fake filesystem: `links` maps a path to what it resolves to; `missing` throws. */
function fakeFs(links: Record<string, string>, missing: string[] = []): RootsFs {
	return {
		realpath: async (path) => {
			if (missing.includes(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			for (const [from, to] of Object.entries(links)) {
				if (path === from || path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
			}
			return path;
		}
	};
}

describe('isInsideRoot', () => {
	it('accepts the root and its descendants', () => {
		expect(isInsideRoot('/srv/app', '/srv/app', 'linux')).toBe(true);
		expect(isInsideRoot('/srv/app/storage/logs/a.log', '/srv/app', 'linux')).toBe(true);
	});

	it('refuses a sibling whose name starts with the root', () => {
		expect(isInsideRoot('/srv/app-old/a.log', '/srv/app', 'linux')).toBe(false);
		expect(isInsideRoot('/srv/a.log', '/srv/app', 'linux')).toBe(false);
	});

	it('accepts a child named like `..x` but never `..`', () => {
		expect(isInsideRoot('/srv/app/..x/a.log', '/srv/app', 'linux')).toBe(true);
	});

	it('folds case on Windows only', () => {
		expect(isInsideRoot('C:\\Code\\API\\logs\\a.log', 'c:\\code\\api', 'win32')).toBe(true);
		expect(isInsideRoot('D:\\code\\api\\a.log', 'C:\\code\\api', 'win32')).toBe(false);
		expect(isInsideRoot('/Srv/App/a.log', '/srv/app', 'linux')).toBe(false);
	});
});

describe('isFilesystemRoot', () => {
	it('names the roots of both shapes', () => {
		expect(isFilesystemRoot('/', 'linux')).toBe(true);
		expect(isFilesystemRoot('C:\\', 'win32')).toBe(true);
		expect(isFilesystemRoot('/var/log', 'linux')).toBe(false);
	});
});

describe('resolveAllowedRoots', () => {
	it('keeps canonical roots in order and refuses home, a filesystem root and a relative path', async () => {
		const result = await resolveAllowedRoots(
			{
				platform: 'linux',
				homedir: '/home/ops',
				logDirs: ['/var/log'],
				workspaceRoot: '/home/ops/.ever-works/fleet-workspaces',
				filesRoots: ['/home/ops', '/', 'relative/dir', '/srv/app', '/gone'],
				checkouts: ['/home/ops/code/api']
			},
			fakeFs({}, ['/gone'])
		);
		expect(result.roots).toEqual([
			{ path: '/var/log', kind: 'log-dir' },
			{ path: '/home/ops/code/api', kind: 'checkout' },
			{ path: '/home/ops/.ever-works/fleet-workspaces', kind: 'workspace' },
			{ path: '/srv/app', kind: 'files-root' }
		]);
		expect(result.refused.map((entry) => entry.reason)).toEqual(['home', 'filesystem-root', 'relative', 'missing']);
	});

	it('refuses a root that is a link to the home directory', async () => {
		const result = await resolveAllowedRoots(
			{ platform: 'linux', homedir: '/home/ops', filesRoots: ['/mnt/me'] },
			fakeFs({ '/mnt/me': '/home/ops' })
		);
		expect(result.roots).toEqual([]);
		expect(result.refused[0]?.reason).toBe('home');
	});
});

describe('resolveUnderRoots', () => {
	const roots = [
		{ path: '/var/log', kind: 'log-dir' as const },
		{ path: '/home/ops/code/api', kind: 'checkout' as const }
	];

	it('opens a file under a root', async () => {
		const result = await resolveUnderRoots('/home/ops/code/api/storage/logs/laravel.log', roots, 'linux', fakeFs({}));
		expect(result).toMatchObject({ ok: true, canonical: '/home/ops/code/api/storage/logs/laravel.log' });
	});

	it('refuses a symlink from a root to /etc', async () => {
		const result = await resolveUnderRoots(
			'/home/ops/code/api/etc-link/shadow',
			roots,
			'linux',
			fakeFs({ '/home/ops/code/api/etc-link': '/etc' })
		);
		expect(result).toEqual({ ok: false, reason: 'outside' });
	});

	it('refuses `..` once it is collapsed', async () => {
		const collapsing: RootsFs = { realpath: async () => '/etc/shadow' };
		expect(await resolveUnderRoots('/var/log/../../etc/shadow', roots, 'linux', collapsing)).toEqual({
			ok: false,
			reason: 'outside'
		});
	});

	it('refuses a relative or missing path', async () => {
		expect(await resolveUnderRoots('var/log/syslog', roots, 'linux', fakeFs({}))).toEqual({
			ok: false,
			reason: 'not-absolute'
		});
		expect(await resolveUnderRoots('/var/log/nope', roots, 'linux', fakeFs({}, ['/var/log/nope']))).toEqual({
			ok: false,
			reason: 'missing'
		});
	});
});

describe('standardLogDirs', () => {
	it('lists each platform’s folders, none on Windows (spec §8b)', () => {
		expect(standardLogDirs('linux', '/home/ops')).toEqual(['/var/log']);
		expect(standardLogDirs('darwin', '/Users/ops')).toEqual(['/var/log', '/Library/Logs', '/Users/ops/Library/Logs']);
		expect(standardLogDirs('win32', 'C:\\Users\\ops')).toEqual([]);
	});
});
