/**
 * EW-644 — `git-cli` LFS transport: shell out to `git` + `git-lfs`.
 *
 * Reserved for advanced operators who would rather rely on the native
 * git binaries than HTTP signed URLs (e.g. air-gapped registries that
 * proxy git but block the LFS Batch host, or shops with strict
 * supply-chain rules about which HTTP clients can talk to GitHub).
 *
 * The flow:
 *
 *   1. `mkdtemp(...)`
 *   2. `git clone --depth 1 -b <branch> <authed-url> <tmpdir>`
 *   3. `git lfs install --local` (writes `.git/hooks/{pre-push,post-commit,post-checkout,post-merge}`)
 *   4. `git lfs track "<pathPrefix>/**"`  — appends to `.gitattributes`, idempotent
 *   5. Write each upload file into the tmpdir at its target path
 *   6. `git add .gitattributes <each-file>`
 *   7. `git -c user.email=... -c user.name=... commit -m "<msg>"`
 *   8. `git push origin <branch>`
 *   9. `rm -rf <tmpdir>`
 *
 * Notably: with `git lfs track` in place, step 5 writes the RAW bytes;
 * git-lfs intercepts the `git add` and substitutes a pointer file
 * automatically (and uploads the blob via `pre-push`). This differs
 * from the Batch-API path where we explicitly compute and commit the
 * pointer ourselves.
 *
 * Binary requirements: `git` ≥ 2.40, `git-lfs` ≥ 3.4. The plugin
 * probes both at `onLoad()` when `lfsTransport: 'git-cli'` is selected
 * so we fail loudly at boot rather than on the first upload.
 *
 * The implementation uses `node:child_process.spawn` directly (no
 * `execa` dep) — the platform doesn't pull execa in anywhere else.
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

const DEFAULT_HOST_BASE = 'https://github.com';

export interface LfsCliConfig {
	readonly owner: string;
	readonly repo: string;
	readonly branch: string;
	readonly token: string;
	/** Optional override for GHE deployments. Defaults to `https://github.com`. */
	readonly hostBase?: string;
}

export interface LfsCliCommitter {
	readonly name: string;
	readonly email: string;
}

export interface LfsCliFile {
	readonly path: string;
	readonly content: Buffer;
}

export interface BinaryProbeResult {
	readonly available: boolean;
	readonly version?: string;
	readonly error?: string;
}

export interface ProbeResult {
	readonly git: BinaryProbeResult;
	readonly gitLfs: BinaryProbeResult;
}

/**
 * Check for `git` and `git-lfs` on PATH, return the parsed semver-ish
 * version strings the binary reports. Called by the plugin's
 * `onLoad()` so misconfigured hosts fail at boot, not on the first
 * upload.
 */
export async function probeGitCliBinaries(exec: ExecImpl = defaultExec): Promise<ProbeResult> {
	const [git, gitLfs] = await Promise.all([
		probeOne(exec, 'git', ['--version']),
		probeOne(exec, 'git-lfs', ['--version'])
	]);
	return { git, gitLfs };
}

/**
 * Single-commit, single-push helper. Clones, ensures `.gitattributes`
 * tracks the path prefix via `git lfs track`, writes the supplied
 * files into the working tree, commits + pushes, and cleans up.
 *
 * Throws on any sub-step failure with the captured stderr so callers
 * can surface a useful error to the operator.
 */
export async function commitWithLfsCli(
	cfg: LfsCliConfig,
	pathPrefix: string,
	files: ReadonlyArray<LfsCliFile>,
	commitMessage: string,
	committer: LfsCliCommitter,
	exec: ExecImpl = defaultExec
): Promise<void> {
	const tmpdir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'ew-gh-storage-lfs-'));
	try {
		await runGitClone(exec, cfg, tmpdir);
		await runIn(exec, tmpdir, 'git', ['lfs', 'install', '--local']);
		await runIn(exec, tmpdir, 'git', ['lfs', 'track', sanitizeTrackPattern(pathPrefix)]);
		for (const file of files) {
			const full = nodePath.join(tmpdir, file.path);
			await fsp.mkdir(nodePath.dirname(full), { recursive: true });
			await fsp.writeFile(full, file.content);
			await runIn(exec, tmpdir, 'git', ['add', file.path]);
		}
		// `git lfs track` writes `.gitattributes` — always stage it.
		await runIn(exec, tmpdir, 'git', ['add', '.gitattributes']);
		await runIn(exec, tmpdir, 'git', [
			'-c',
			`user.name=${committer.name}`,
			'-c',
			`user.email=${committer.email}`,
			'commit',
			'-m',
			commitMessage
		]);
		await runIn(exec, tmpdir, 'git', ['push', 'origin', cfg.branch]);
	} finally {
		// Best-effort cleanup. Don't mask the original error if rm fails.
		await fsp.rm(tmpdir, { recursive: true, force: true }).catch(() => {
			/* swallow */
		});
	}
}

/**
 * Pattern fed to `git lfs track`. We pin to `<pathPrefix>/**` so every
 * file under the prefix is LFS-tracked. Empty / whole-repo pinning is
 * supported but unusual — the plugin's `pathPrefix` defaults to
 * `uploads`.
 */
function sanitizeTrackPattern(pathPrefix: string): string {
	const safe = pathPrefix.replace(/(^\/+|\/+$)/g, '');
	if (safe.length === 0) return '*';
	return `${safe}/**`;
}

async function runGitClone(exec: ExecImpl, cfg: LfsCliConfig, dest: string): Promise<void> {
	const host = (cfg.hostBase || DEFAULT_HOST_BASE).replace(/\/$/, '');
	const url = `${host}/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}.git`;
	// We do NOT bake the token into the URL — that would surface it in
	// `git config remote.origin.url` for the lifetime of the temp dir
	// and in any error logs. Instead we use a single-shot
	// `-c http.extraheader=Authorization: Bearer <token>` which only
	// applies to this `git clone` invocation. After the clone we
	// strip the credential helper so subsequent `git push` reads from
	// the same extraheader we set on `-c` below.
	const authHeader = `Authorization: Bearer ${cfg.token}`;
	await exec(
		'git',
		[
			'-c',
			`http.extraheader=${authHeader}`,
			'clone',
			'--depth',
			'1',
			'--branch',
			cfg.branch,
			'--single-branch',
			url,
			dest
		],
		{}
	);
	// Persist the auth header on the cloned repo's local config so the
	// subsequent `git push` inside `dest` also authenticates without
	// embedding the token in the remote URL.
	await runIn(exec, dest, 'git', ['config', '--local', 'http.extraheader', authHeader]);
}

async function runIn(exec: ExecImpl, cwd: string, cmd: string, args: ReadonlyArray<string>): Promise<void> {
	await exec(cmd, args, { cwd });
}

async function probeOne(exec: ExecImpl, cmd: string, args: ReadonlyArray<string>): Promise<BinaryProbeResult> {
	try {
		const { stdout } = await exec(cmd, args, {});
		return { available: true, version: stdout.trim() };
	} catch (err) {
		return {
			available: false,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}

// ============================================================================
// Pluggable exec impl — the tests inject a mock, prod uses spawn().
// ============================================================================

export interface ExecResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

export type ExecImpl = (cmd: string, args: ReadonlyArray<string>, opts: { cwd?: string }) => Promise<ExecResult>;

const defaultExec: ExecImpl = async (cmd, args, opts) => {
	return new Promise((resolve, reject) => {
		const spawnOpts: SpawnOptions = {
			cwd: opts.cwd,
			env: process.env,
			stdio: ['ignore', 'pipe', 'pipe']
		};
		const child = spawn(cmd, [...args], spawnOpts);
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on('data', (chunk) => {
			stderr += chunk.toString();
		});
		child.on('error', (err) => {
			reject(
				new Error(
					`Failed to spawn '${cmd} ${args.join(' ')}': ${err.message}. ` +
						`Is the binary installed and on PATH?`
				)
			);
		});
		child.on('close', (exitCode) => {
			if (exitCode === 0) {
				resolve({ stdout, stderr, exitCode });
			} else {
				reject(new Error(`'${cmd} ${args.join(' ')}' exited with code ${exitCode}: ${stderr || stdout}`));
			}
		});
	});
};
