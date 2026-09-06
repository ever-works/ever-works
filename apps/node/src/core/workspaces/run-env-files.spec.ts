import { promises as fs } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	RunEnvFileError,
	extractRunEnvSecretValues,
	removeRunEnvFiles,
	resolveRunEnvFilePath,
	runEnvFilesManifestPath,
	sweepStaleRunEnvFiles,
	writeRunEnvFiles
} from './run-env-files';

/**
 * Run secrets on disk (self-build slice Y, EW-781).
 *
 * Real files in a real temp directory: the whole point of this module is
 * what it does to a filesystem, and a mocked `fs` would prove nothing
 * about permissions, symlinks or traversal.
 *
 * The POSIX mode assertion is skipped on Windows deliberately, not
 * forgotten: `fs.chmod` there only toggles the read-only bit, so a
 * mode-bits check would PASS while the file stayed readable by every
 * other local account. The Windows half is an explicit ACL
 * (`restrictFileToOwnerWindows`), which `icacls` owns and this suite
 * cannot meaningfully assert without shelling out to it.
 */

const SENTINEL = 'sentinel-a7f3-DATABASE_URL=postgres://u:p@db/app';
const isPosix = process.platform !== 'win32';

describe('run env files on disk', () => {
	let root: string;
	let worktree: string;
	let gitDir: string;

	beforeEach(async () => {
		root = await realpath(await mkdtemp(join(tmpdir(), 'ew-run-env-')));
		worktree = join(root, 'checkout');
		gitDir = join(root, 'gitdir');
		await fs.mkdir(worktree, { recursive: true });
		await fs.mkdir(gitDir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
	});

	it('writes owner-only, inside the checkout, creating parents', async () => {
		const written = await writeRunEnvFiles(worktree, gitDir, [{ path: 'apps/api/.env', content: SENTINEL }]);
		expect(written).toEqual(['apps/api/.env']);
		const target = join(worktree, 'apps', 'api', '.env');
		expect(await fs.readFile(target, 'utf8')).toBe(SENTINEL);
		if (isPosix) {
			expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
		}
	});

	it('keeps the manifest OUTSIDE the checkout, so `git add -A` can never stage it', async () => {
		await writeRunEnvFiles(worktree, gitDir, [{ path: '.env', content: SENTINEL }]);
		const manifest = runEnvFilesManifestPath(gitDir);
		expect(manifest.startsWith(worktree)).toBe(false);
		const parsed = JSON.parse(await fs.readFile(manifest, 'utf8')) as { paths: string[] };
		expect(parsed.paths).toEqual(['.env']);
		// PATHS only — a content digest here would be a length oracle.
		expect(await fs.readFile(manifest, 'utf8')).not.toContain(SENTINEL);
	});

	it('refuses to write THROUGH a symlink planted at the target', async () => {
		const outside = join(root, 'stolen.env');
		await fs.writeFile(outside, 'not-yet');
		try {
			await fs.symlink(outside, join(worktree, '.env'));
		} catch {
			// Unprivileged Windows cannot create symlinks; the refusal it
			// guards is unreachable there, so there is nothing to assert.
			return;
		}
		await expect(writeRunEnvFiles(worktree, gitDir, [{ path: '.env', content: SENTINEL }])).rejects.toBeInstanceOf(
			RunEnvFileError
		);
		expect(await fs.readFile(outside, 'utf8')).toBe('not-yet');
	});

	it('refuses a directory sitting where the file should go', async () => {
		await fs.mkdir(join(worktree, '.env'));
		await expect(writeRunEnvFiles(worktree, gitDir, [{ path: '.env', content: SENTINEL }])).rejects.toBeInstanceOf(
			RunEnvFileError
		);
	});

	it.each(['../escape.env', '/etc/passwd', 'a/../../b.env', 'apps/./.env'])(
		'refuses the traversing path %s',
		async (path) => {
			expect(() => resolveRunEnvFilePath(worktree, path)).toThrow(RunEnvFileError);
			await expect(writeRunEnvFiles(worktree, gitDir, [{ path, content: SENTINEL }])).rejects.toBeInstanceOf(
				RunEnvFileError
			);
		}
	);

	it('leaves NOTHING behind when one file of a set fails — no partial environment', async () => {
		await expect(
			writeRunEnvFiles(worktree, gitDir, [
				{ path: 'apps/api/.env', content: SENTINEL },
				{ path: '../escape.env', content: SENTINEL }
			])
		).rejects.toBeInstanceOf(RunEnvFileError);
		await expect(fs.stat(join(worktree, 'apps', 'api', '.env'))).rejects.toMatchObject({
			code: 'ENOENT'
		});
		await expect(fs.stat(runEnvFilesManifestPath(gitDir))).rejects.toMatchObject({
			code: 'ENOENT'
		});
	});

	it('removes every written file and the manifest', async () => {
		await writeRunEnvFiles(worktree, gitDir, [
			{ path: '.env', content: SENTINEL },
			{ path: 'apps/api/.env', content: SENTINEL }
		]);
		expect(await removeRunEnvFiles(worktree, gitDir)).toEqual(['.env', 'apps/api/.env']);
		await expect(fs.stat(join(worktree, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(fs.stat(join(worktree, 'apps', 'api', '.env'))).rejects.toMatchObject({
			code: 'ENOENT'
		});
		await expect(fs.stat(runEnvFilesManifestPath(gitDir))).rejects.toMatchObject({
			code: 'ENOENT'
		});
	});

	it('never throws on removal, however broken the state', async () => {
		await expect(removeRunEnvFiles(worktree, gitDir)).resolves.toEqual([]);
		await expect(removeRunEnvFiles(worktree, null)).resolves.toEqual([]);
		await fs.writeFile(runEnvFilesManifestPath(gitDir), 'not json');
		await expect(removeRunEnvFiles(worktree, gitDir)).resolves.toEqual([]);
		await fs.rm(worktree, { recursive: true, force: true });
		await expect(removeRunEnvFiles(worktree, gitDir)).resolves.toEqual([]);
	});

	it('sweeps what a HARD-KILLED previous run left, by its own manifest', async () => {
		// Simulates SIGKILL: the files and the manifest survive, no cleanup
		// ran. The next provision must not hand this run the previous one's
		// secrets — including for a repository that no longer grants them.
		await writeRunEnvFiles(worktree, gitDir, [{ path: 'apps/api/.env', content: SENTINEL }]);
		expect(await sweepStaleRunEnvFiles(worktree, gitDir)).toEqual(['apps/api/.env']);
		await expect(fs.stat(join(worktree, 'apps', 'api', '.env'))).rejects.toMatchObject({
			code: 'ENOENT'
		});
	});

	it('deletes what the WRITER remembers even when there is no manifest at all', async () => {
		// `resolvePrivateGitDir` returns null for a checkout whose `.git` is a
		// directory rather than a worktree file, and for ANY transient failure
		// of the `git rev-parse` it shells out to (an index lock, EMFILE under
		// load). Deleting by the manifest alone would then leave a decrypted
		// `.env` on disk forever — and the provision-time sweep, which also
		// reads the manifest, would not find it either.
		const written = await writeRunEnvFiles(worktree, null, [{ path: 'apps/api/.env', content: SENTINEL }]);
		expect(written).toEqual(['apps/api/.env']);
		expect(await removeRunEnvFiles(worktree, null, written)).toEqual(['apps/api/.env']);
		await expect(fs.stat(join(worktree, 'apps', 'api', '.env'))).rejects.toMatchObject({
			code: 'ENOENT'
		});
	});

	it('deletes what the WRITER remembers when the manifest write was lost', async () => {
		await writeRunEnvFiles(worktree, gitDir, [{ path: '.env', content: SENTINEL }]);
		// A swallowed manifest failure looks exactly like this from here.
		await fs.rm(runEnvFilesManifestPath(gitDir), { force: true });
		expect(await removeRunEnvFiles(worktree, gitDir, ['.env'])).toEqual(['.env']);
		await expect(fs.stat(join(worktree, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('unions the writer record with the manifest, and visits each path once', async () => {
		await writeRunEnvFiles(worktree, gitDir, [
			{ path: '.env', content: SENTINEL },
			{ path: 'apps/api/.env', content: SENTINEL }
		]);
		// `.env` is in BOTH lists and must not be visited twice; the manifest
		// still contributes `apps/api/.env`, which the caller did not name.
		const removed = await removeRunEnvFiles(worktree, gitDir, ['.env', 'web/.env.local']);
		expect(removed.filter((path) => path === '.env')).toHaveLength(1);
		expect(removed).toContain('apps/api/.env');
		await expect(fs.stat(join(worktree, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(fs.stat(join(worktree, 'apps', 'api', '.env'))).rejects.toMatchObject({
			code: 'ENOENT'
		});
	});

	it('extracts the VALUES of a delivered env file, and only real ones', () => {
		const values = extractRunEnvSecretValues(
			[
				'# a comment',
				'',
				'DATABASE_URL=postgres://user:hunter2@db:5432/app',
				"export GH_TOKEN='ghp_0123456789abcdef'",
				'QUOTED="a-long-enough-value"',
				'SHORT=abc',
				'not a env line',
				'=novalue'
			].join('\n')
		);
		expect(values).toContain('postgres://user:hunter2@db:5432/app');
		expect(values).toContain('ghp_0123456789abcdef');
		expect(values).toContain('a-long-enough-value');
		// Under the 8-character floor: scrubbing it would redact prose.
		expect(values).not.toContain('abc');
		expect(values.some((value) => value.includes('novalue'))).toBe(false);
		// Longest first, so `scrub` replaces a containing value whole.
		expect([...values]).toEqual([...values].sort((a, b) => b.length - a.length));
	});

	it('overwrites a leftover regular file rather than refusing the run', async () => {
		await fs.writeFile(join(worktree, '.env'), 'stale=1');
		await writeRunEnvFiles(worktree, gitDir, [{ path: '.env', content: SENTINEL }]);
		expect(await fs.readFile(join(worktree, '.env'), 'utf8')).toBe(SENTINEL);
		if (isPosix) {
			expect((await fs.stat(join(worktree, '.env'))).mode & 0o777).toBe(0o600);
		}
	});
});
