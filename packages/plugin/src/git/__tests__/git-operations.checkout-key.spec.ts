import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GitOperations } from '../git-operations.js';

/**
 * APW-02 P0 (Wave 0 PR 0.2) — checkout directory keys.
 *
 * `getLocalDir` used to key the on-disk checkout by `slugifyText(`${owner}-${repo}`)`, which is
 * lossy AND case-insensitive: two distinct (owner, repo) pairs whose normalized names agree get
 * ONE directory. Two different repositories then share a working copy, and one Work's branch /
 * commit state leaks into another's.
 *
 * Fixtures here are deliberately generic (Resolution R-14): the exact reproductions live in the
 * private operations repository, so this spec only ever names pairs "whose normalized names
 * collide" and asserts the *collision* itself in the arrange step — if the fixture ever stops
 * colliding, the guard test below fails instead of the whole suite silently going green for the
 * wrong reason.
 */

/** The pre-fix key formula, reproduced verbatim so the fixture can be PROVEN to collide. */
function legacyDirName(owner: string, repo: string): string {
	return `${owner}-${repo}`
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/(^-|-$)/g, '');
}

/** Mirrors the GitHub plugin's `getCloneUrl`. */
const githubCloneUrl = (owner: string, repo: string) => `https://github.com/${owner}/${repo}.git`;
/** Mirrors what a second, different provider injects. */
const gitlabCloneUrl = (owner: string, repo: string) => `https://gitlab.com/${owner}/${repo}.git`;

const COLLIDING_PAIRS: ReadonlyArray<readonly [string, string]> = [
	['acme', 'web.app'],
	['acme-web', 'app']
];

// Windows caps one path component at 255 characters; POSIX at 255 bytes. The generated component
// must stay under the smaller bound, whatever the input length.
const COMPONENT_LIMIT = 255;

let baseDir: string;

function makeOps(
	cloneUrl: (owner: string, repo: string) => string = githubCloneUrl,
	dir: string = baseDir
): GitOperations {
	return new GitOperations(() => ({ username: 'x-access-token', password: 'token' }), cloneUrl, {
		baseDir: dir
	});
}

function dirName(ops: GitOperations, owner: string, repo: string, checkoutKey?: string): string {
	return path.basename(ops.getLocalDir(owner, repo, checkoutKey));
}

beforeEach(() => {
	baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-checkout-key-'));
});

afterEach(() => {
	fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('GitOperations.getLocalDir — checkout directory keys', () => {
	it('arrange guard: the two fixture pairs really do collide under the legacy key', () => {
		const [a, b] = COLLIDING_PAIRS;
		const legacyA = legacyDirName(a[0], a[1]);
		const legacyB = legacyDirName(b[0], b[1]);

		expect(legacyA).toBe(legacyB);
		// ...and they are genuinely different repositories.
		expect(`${a[0]}/${a[1]}`).not.toBe(`${b[0]}/${b[1]}`);
	});

	it('gives two owner/repository pairs whose normalized names collide DIFFERENT directories', () => {
		const ops = makeOps();
		const [a, b] = COLLIDING_PAIRS;

		const dirA = ops.getLocalDir(a[0], a[1]);
		const dirB = ops.getLocalDir(b[0], b[1]);

		expect(dirA).not.toBe(dirB);
		expect(path.resolve(dirA)).not.toBe(path.resolve(dirB));
	});

	it('preserves case: Owner/Repo and owner/repo are different checkouts', () => {
		const ops = makeOps();

		const upper = ops.getLocalDir('Acme', 'Repo');
		const lower = ops.getLocalDir('acme', 'repo');

		expect(upper).not.toBe(lower);
	});

	it('is provider-scoped: the same owner/repo under two providers gets different keys', () => {
		const github = makeOps(githubCloneUrl);
		const gitlab = makeOps(gitlabCloneUrl);

		const fromGithub = github.getLocalDir('acme', 'app');
		const fromGitlab = gitlab.getLocalDir('acme', 'app');

		expect(fromGithub).not.toBe(fromGitlab);
	});

	it('is deterministic: the same coordinates always resolve to the same directory', () => {
		const first = makeOps().getLocalDir('acme', 'app');
		const second = makeOps().getLocalDir('acme', 'app');

		expect(first).toBe(second);
	});

	it('keeps the readable repository name in the directory name (human-identifiable)', () => {
		const name = dirName(makeOps(), 'acme', 'web-app');

		expect(name).toContain('acme');
		expect(name).toContain('web-app');
	});

	it('is filesystem-safe and bounded for hostile and pathological owner/repository names', () => {
		const ops = makeOps();
		const hostile: ReadonlyArray<readonly [string, string]> = [
			['..', '..'],
			['..', '../escape'],
			['acme/../evil', 'app'],
			['acme', 'app:stream'],
			['.hidden', '.dotfile'],
			['trailing.', 'trailing '],
			['a'.repeat(400), 'b'.repeat(400)],
			['ACME/\\:*?"<>|', 'APP/\\:*?"<>|'],
			['', ''],
			['acme', 'x'.repeat(5000)]
		];

		const seen = new Set<string>();

		for (const [owner, repo] of hostile) {
			const dir = ops.getLocalDir(owner, repo);
			const name = path.basename(dir);
			const resolved = path.resolve(dir);

			// Filesystem-safe: one component, no separators, no colon, no traversal, no
			// leading dot, no trailing dot or space.
			expect(name).not.toContain('/');
			expect(name).not.toContain('\\');
			expect(name).not.toContain(':');
			expect(name).not.toContain('..');
			expect(name.startsWith('.')).toBe(false);
			expect(/[. ]$/.test(name)).toBe(false);
			expect(name.length).toBeGreaterThan(0);
			expect(name.length).toBeLessThanOrEqual(COMPONENT_LIMIT);

			// Containment: the resolved path stays strictly inside baseDir and is never
			// baseDir itself.
			expect(resolved.startsWith(path.resolve(baseDir) + path.sep)).toBe(true);
			expect(resolved).not.toBe(path.resolve(baseDir));

			// Distinct hostile inputs must not collapse onto one directory either.
			expect(seen.has(resolved)).toBe(false);
			seen.add(resolved);
		}
	});

	it('caps the generated directory name for a pathological long name', () => {
		const name = dirName(makeOps(), 'o'.repeat(1000), 'r'.repeat(1000));

		expect(name.length).toBeLessThanOrEqual(COMPONENT_LIMIT);
	});

	it('scopes a per-caller checkout key to its own directory, distinct from the repository one', () => {
		const ops = makeOps();
		const repoDir = ops.getLocalDir('acme', 'app');
		const keyDir = ops.getLocalDir('acme', 'app', 'work:9f1c0b7a-0000-4000-8000-000000000000:data');

		expect(keyDir).not.toBe(repoDir);
		expect(dirName(ops, 'acme', 'app', 'work:9f1c0b7a-0000-4000-8000-000000000000:data')).toBe(
			path.basename(keyDir)
		);
		// Deterministic, and still contained + bounded.
		expect(ops.getLocalDir('acme', 'app', 'work:9f1c0b7a-0000-4000-8000-000000000000:data')).toBe(keyDir);
		expect(path.basename(keyDir).length).toBeLessThanOrEqual(COMPONENT_LIMIT);
		expect(path.resolve(keyDir).startsWith(path.resolve(baseDir) + path.sep)).toBe(true);
	});

	it('two different checkout keys for one repository do not share a directory', () => {
		const ops = makeOps();

		const data = ops.getLocalDir('acme', 'app', 'work:work-1:data');
		const work = ops.getLocalDir('acme', 'app', 'work:work-1:work');

		expect(data).not.toBe(work);
	});

	it('refuses a checkout key that is not filesystem-safe', () => {
		const ops = makeOps();

		expect(() => ops.getLocalDir('acme', 'app', 'work:../escape')).toThrow();
		expect(() => ops.getLocalDir('acme', 'app', 'work/../escape')).toThrow();
		expect(() => ops.getLocalDir('acme', 'app', 'UPPER')).toThrow();
		expect(() => ops.getLocalDir('acme', 'app', '')).toThrow();
	});

	it('falls back to a pre-existing legacy checkout instead of orphaning it', () => {
		const ops = makeOps();
		const legacyDir = path.join(baseDir, legacyDirName('acme', 'app'));
		fs.mkdirSync(legacyDir, { recursive: true });

		// Only the old-scheme directory exists: it is this repository's working copy, so it is
		// reused rather than abandoned.
		expect(ops.getLocalDir('acme', 'app')).toBe(legacyDir);

		// Learn the current-scheme directory the honest way — no legacy checkout present.
		fs.rmSync(legacyDir, { recursive: true, force: true });
		const primaryDir = ops.getLocalDir('acme', 'app');
		expect(primaryDir).not.toBe(legacyDir);

		// Both present: the current scheme wins.
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.mkdirSync(primaryDir, { recursive: true });

		expect(ops.getLocalDir('acme', 'app')).toBe(primaryDir);
		expect(ops.getLocalDir('acme', 'app')).not.toBe(legacyDir);
	});

	it('never resolves an unresolved legacy name to the base directory itself', () => {
		const ops = makeOps();

		// `slugifyText('..-..')` is the empty string; `path.join(baseDir, '')` is baseDir.
		expect(path.resolve(ops.getLocalDir('..', '..'))).not.toBe(path.resolve(baseDir));
	});

	it('removeLocalDir removes only its own checkout — siblings and legacy dirs survive', async () => {
		const ops = makeOps();
		const target = ops.getLocalDir('acme', 'web.app');
		const sibling = ops.getLocalDir('acme-web', 'app');
		const legacyOther = path.join(baseDir, legacyDirName('other-owner', 'other-repo'));
		const legacyTarget = path.join(baseDir, legacyDirName('acme', 'web.app'));

		fs.mkdirSync(target, { recursive: true });
		fs.mkdirSync(sibling, { recursive: true });
		fs.mkdirSync(legacyOther, { recursive: true });
		fs.mkdirSync(legacyTarget, { recursive: true });

		await ops.removeLocalDir('acme', 'web.app');

		// Exactly one directory goes: the one this repository was actually using. Nothing
		// sweeps old-scheme checkouts on the caller's behalf, and no other repository's
		// working copy is touched.
		expect(fs.existsSync(target)).toBe(false);
		expect(fs.existsSync(sibling)).toBe(true);
		expect(fs.existsSync(legacyOther)).toBe(true);
		expect(fs.existsSync(legacyTarget)).toBe(true);
	});

	it('removes the legacy checkout when that is the directory the repository is using', async () => {
		const ops = makeOps();
		const legacyTarget = path.join(baseDir, legacyDirName('acme', 'web.app'));
		const sibling = ops.getLocalDir('acme-web', 'app');

		fs.mkdirSync(legacyTarget, { recursive: true });
		fs.mkdirSync(sibling, { recursive: true });

		// Resolves onto the legacy directory...
		expect(ops.getLocalDir('acme', 'web.app')).toBe(legacyTarget);

		await ops.removeLocalDir('acme', 'web.app');

		// ...so that is the one removed. The colliding sibling keeps its own checkout.
		expect(fs.existsSync(legacyTarget)).toBe(false);
		expect(fs.existsSync(sibling)).toBe(true);
	});

	it('exposes a pure checkoutDirectoryName helper with the documented shape', async () => {
		const mod: Record<string, unknown> = await import('../git-operations.js');

		expect(typeof mod.checkoutDirectoryName).toBe('function');

		const name = (mod.checkoutDirectoryName as (...args: unknown[]) => string)(
			'https://github.com/acme/app.git',
			'acme',
			'app'
		);

		expect(name).toContain('acme');
		expect(name).toContain('app');
		// A versioned, relative path: `<prefix>/<kind>/<component>`.
		const parts = name.split('/');
		expect(parts).toHaveLength(3);
		expect(parts[0]).toBe('v2');
		expect(parts[1]).toBe('r');
		for (const part of parts) {
			expect(part).not.toContain('..');
			expect(part.startsWith('.')).toBe(false);
			expect(part.length).toBeLessThanOrEqual(COMPONENT_LIMIT);
			expect(part.length).toBeGreaterThan(0);
		}
		// Joining it onto a base keeps the working copy inside that base.
		expect(path.resolve(baseDir, name).startsWith(path.resolve(baseDir) + path.sep)).toBe(true);
	});
});
