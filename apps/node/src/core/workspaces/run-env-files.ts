import { constants as fsConstants, promises as fs } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { isValidFleetRunEnvFilePath } from '@ever-works/contracts';
import { restrictFileToOwnerWindows } from '../../node-io';

/**
 * Run secrets on disk (self-build slice Y, EW-781).
 *
 * The seed `.env` files a run's repositories declared, written into the
 * checkout the model works in, and removed again when the run ends —
 * however it ends.
 *
 * ## What this module guarantees, and what it deliberately does not
 *
 * GUARANTEED:
 *   - every file lands strictly inside the checkout it belongs to (the
 *     path is resolved against the CANONICAL worktree and re-checked);
 *   - nothing is ever written THROUGH a symlink — a link planted at
 *     `.env` by a previous run or by anything else sharing the service
 *     account is refused, not followed;
 *   - the file is owner-only: `0600` on POSIX, and on Windows an explicit
 *     ACL as well, because `fs.chmod` there only toggles the read-only
 *     bit and a mode-bits assertion would pass while the file stayed
 *     readable by every other local account;
 *   - a MANIFEST of what was written is kept beside the workspace lease
 *     in the worktree's PRIVATE gitdir — outside the checkout, so it can
 *     never be committed — which is what lets a later run sweep files a
 *     hard kill left behind.
 *
 * NOT GUARANTEED: survival of `SIGKILL` or a power cut. The executor's
 * `finally` covers success, failure, a thrown model step and an abort
 * (cancel, lapsed lease); a killed process runs no cleanup at all. That
 * is what the provision-time sweep and the Git exclude rules are for, and
 * the docs say so rather than claiming an absolute.
 */

/** One file to place, already decrypted. Lives for one write and is dropped. */
export interface RunEnvFileWrite {
	/** Repository-relative path, e.g. `apps/api/.env`. */
	readonly path: string;
	readonly content: string;
}

/** Name of the manifest written beside the workspace lease in the private gitdir. */
export const RUN_ENV_FILES_MANIFEST = 'ever-works-run-env.json';

interface RunEnvFilesManifest {
	version: 1;
	/** Repository-relative paths this process wrote. NEVER contents. */
	paths: string[];
	writtenAt: string;
}

export class RunEnvFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RunEnvFileError';
	}
}

/** Absolute path of the manifest for a worktree whose private gitdir is `gitDir`. */
export function runEnvFilesManifestPath(gitDir: string): string {
	return join(gitDir, RUN_ENV_FILES_MANIFEST);
}

/**
 * Resolve one repository-relative env-file path against a CANONICAL
 * worktree root, refusing anything that would land outside it.
 *
 * The contracts normalizer already rejected traversal and absolute forms
 * on the wire; this is the last gate, on the machine, against the value
 * that is about to become a real filesystem path.
 */
export function resolveRunEnvFilePath(canonicalWorktree: string, path: string): string {
	if (!isValidFleetRunEnvFilePath(path)) {
		throw new RunEnvFileError(`Run env file path '${path}' is not repository-relative`);
	}
	const target = resolve(canonicalWorktree, path);
	const child = relative(canonicalWorktree, target);
	if (child === '' || child.split(/[\\/]/)[0] === '..' || isAbsolute(child)) {
		throw new RunEnvFileError(`Run env file path '${path}' resolves outside the checkout`);
	}
	return target;
}

/**
 * Write the run's env files into one checkout, owner-only, and record
 * what was written in the private gitdir.
 *
 * `worktreePath` must already be the canonical path (the provisioner
 * realpath's it before calling). Any failure throws: a run that starts
 * with SOME of its environment is the failure this feature exists to
 * remove, so a half-written set is cleaned up and refused rather than
 * used.
 */
export async function writeRunEnvFiles(
	canonicalWorktree: string,
	gitDir: string | null,
	files: readonly RunEnvFileWrite[]
): Promise<string[]> {
	const written: string[] = [];
	try {
		for (const file of files) {
			const target = resolveRunEnvFilePath(canonicalWorktree, file.path);
			// Never write through a link. A previous run — or anything else
			// sharing this service account — can pre-place one at `.env` and
			// have the secret land wherever it points. Same posture the
			// mounts directory already takes: refuse, do not repair.
			const existing = await fs.lstat(target).catch(() => null);
			if (existing?.isSymbolicLink()) {
				throw new RunEnvFileError(
					`Refusing to write run env file '${file.path}': a symbolic link is already at that path`
				);
			}
			if (existing && !existing.isFile()) {
				throw new RunEnvFileError(
					`Refusing to write run env file '${file.path}': something that is not a regular file is at that path`
				);
			}
			await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
			// O_TRUNC rather than `wx`: the file legitimately exists when a
			// previous run in this reused worktree was killed before cleanup.
			// The lstat above is what makes overwriting it safe.
			await fs.writeFile(target, file.content, {
				encoding: 'utf8',
				mode: 0o600,
				flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC
			});
			if (process.platform === 'win32') {
				// Windows has no mode bits: without this the file inherits the
				// directory ACL and a 0600 assertion would be a lie.
				restrictFileToOwnerWindows(target);
			} else {
				// `mode` is masked by the umask on create, and the file may have
				// pre-existed with wider bits. Set them explicitly.
				await fs.chmod(target, 0o600);
			}
			written.push(file.path);
		}
	} catch (error) {
		// Fail closed: remove whatever landed before the failure so the run
		// cannot proceed on a partial environment, then re-throw.
		await removeRunEnvFilePaths(canonicalWorktree, written);
		throw error;
	}
	if (gitDir && written.length > 0) {
		await writeManifest(gitDir, written);
	}
	return written;
}

/**
 * Delete the run's env files from one checkout and drop the manifest.
 *
 * NEVER throws: cleanup runs on every exit path, including one that is
 * already reporting a failure, and a cleanup error must not become the
 * verdict. Returns the paths it removed so a caller can log a count.
 *
 * `knownPaths` is what the WRITER still remembers, and it is the primary
 * source — the manifest is only the cross-process half. The manifest is
 * best-effort by design (it is skipped entirely when the worktree has no
 * private gitdir, and its write failure is swallowed), so a deletion that
 * consulted it alone would silently leave a decrypted `.env` on disk
 * forever in exactly the cases where something had already gone wrong.
 */
export async function removeRunEnvFiles(
	canonicalWorktree: string,
	gitDir: string | null,
	knownPaths: readonly string[] = []
): Promise<string[]> {
	const paths = new Set<string>(knownPaths.filter((path): path is string => typeof path === 'string'));
	if (gitDir) {
		for (const path of await readManifestPaths(gitDir)) paths.add(path);
	}
	const removed = await removeRunEnvFilePaths(canonicalWorktree, [...paths]);
	if (gitDir) {
		await fs.rm(runEnvFilesManifestPath(gitDir), { force: true }).catch(() => undefined);
	}
	return removed;
}

/**
 * Provision-time sweep: whatever a PREVIOUS run left in this worktree.
 *
 * The one exit path the executor's `finally` cannot cover is a hard kill,
 * and a reused worktree would otherwise carry that run's `.env` into the
 * next one — including into a run for a repository that no longer grants
 * it. Reads the manifest, so it removes exactly what was written even if
 * the repository's file list has changed since.
 */
export async function sweepStaleRunEnvFiles(canonicalWorktree: string, gitDir: string | null): Promise<string[]> {
	return removeRunEnvFiles(canonicalWorktree, gitDir);
}

/** Best-effort deletion of specific paths. Never throws. */
async function removeRunEnvFilePaths(canonicalWorktree: string, paths: readonly string[]): Promise<string[]> {
	const removed: string[] = [];
	for (const path of paths) {
		let target: string;
		try {
			target = resolveRunEnvFilePath(canonicalWorktree, path);
		} catch {
			// A manifest entry that no longer resolves inside the checkout is
			// not ours to delete.
			continue;
		}
		try {
			await fs.rm(target, { force: true });
			removed.push(path);
		} catch {
			// Best-effort by contract. A file that survives here is covered by
			// the Git exclude rule and swept on the next provision.
		}
	}
	return removed;
}

/**
 * The manifest lives in the worktree's PRIVATE gitdir, next to the
 * workspace lease — never in the checkout, so `git add -A` cannot see it
 * and no exclude rule has to cover it. Paths only; writing a content
 * digest here would be a length oracle for a secret.
 */
async function writeManifest(gitDir: string, paths: readonly string[]): Promise<void> {
	const manifest: RunEnvFilesManifest = {
		version: 1,
		paths: [...paths],
		writtenAt: new Date().toISOString()
	};
	const target = runEnvFilesManifestPath(gitDir);
	try {
		await fs.writeFile(target, `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', mode: 0o600 });
	} catch {
		// The manifest is a cleanup AID, not the cleanup itself: the run's
		// own `finally` deletes by the list it holds in memory. Losing it
		// costs a sweep on the next provision, never a delivered secret.
	}
}

async function readManifestPaths(gitDir: string): Promise<string[]> {
	let raw: string;
	try {
		raw = await fs.readFile(runEnvFilesManifestPath(gitDir), 'utf8');
	} catch {
		return [];
	}
	try {
		const parsed = JSON.parse(raw) as Partial<RunEnvFilesManifest>;
		if (!Array.isArray(parsed.paths)) return [];
		return parsed.paths.filter((path): path is string => typeof path === 'string');
	} catch {
		return [];
	}
}

/**
 * The secret VALUES inside one delivered env file, for the redactor.
 *
 * A `.env` is `KEY=VALUE` lines, and it is the VALUES — not the file as a
 * whole — that a failing `pnpm test` prints into its log tail and that a
 * model echoes into its summary. Registering the whole blob (which is what
 * `logger.protect` gets handed) only ever matches if the entire file is
 * reproduced verbatim, which is not how a connection string leaks.
 *
 * Deliberately conservative: `export ` prefixes and matching quotes are
 * stripped, `${...}` interpolations are left alone (they are not the
 * value), and anything under 8 characters is dropped, because scrubbing a
 * short value would redact ordinary prose out of every log the node
 * reports. Same floor the node's own logger and
 * `collectProtectedValues` already use.
 */
export function extractRunEnvSecretValues(content: string): string[] {
	if (typeof content !== 'string' || content.length === 0) return [];
	const values = new Set<string>();
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const separator = line.indexOf('=');
		if (separator <= 0) continue;
		const name = line
			.slice(0, separator)
			.replace(/^export\s+/, '')
			.trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
		let value = line.slice(separator + 1).trim();
		if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
			value = value.slice(1, -1);
		}
		if (value.trim().length >= 8) values.add(value);
	}
	return [...values].sort((a, b) => b.length - a.length);
}
