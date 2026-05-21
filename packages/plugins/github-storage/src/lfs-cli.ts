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
 * Implementation follows the platform's canonical CLI-spawn envelope
 * (`Workspace/knowledge/runbooks/EVER_WORKS_CLI_SPAWNING.md`):
 *   - `node:child_process.spawn` (no `execa` dep on the platform).
 *   - Env from a tight allowlist (PATH + HOME + TMPDIR + proxy/CA),
 *     never a `...process.env` spread (the C-10 finding from the
 *     2026-05-17 security audit).
 *   - Graceful shutdown: SIGTERM, escalate to SIGKILL after
 *     `KILL_TIMEOUT_MS` if the child doesn't exit.
 *   - `MAX_BUFFER_SIZE` cap on captured stdout/stderr so a runaway
 *     `git` clone doesn't OOM the API.
 *   - `AbortSignal` cancellation, surfaces as a clean "aborted" error.
 *   - Non-zero exit rejects with `<cmd> <args>` + captured stderr.
 */

import * as os from 'node:os';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as nodePath from 'node:path';

const DEFAULT_HOST_BASE = 'https://github.com';

/** Cap on per-child stdout/stderr capture. Prevents a misbehaving
 *  binary (e.g. `git` cloning into an enormous LFS pack) from OOMing
 *  the API. 10 MiB matches every other CLI runner on the platform —
 *  see `packages/plugins/gemini/src/types.ts`. */
const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/** Wait between SIGTERM and SIGKILL during graceful shutdown. Matches
 *  the other CLI runners on the platform. */
const KILL_TIMEOUT_MS = 5_000;

/**
 * Env keys that get forwarded into the `git` / `git-lfs` subprocess.
 * Everything outside this allowlist is dropped — including unrelated
 * secrets that happen to live in the API's environment. C-10 in the
 * 2026-05-17 security audit fixed the original sin (`...process.env`)
 * across the platform; this list keeps the same posture for github-storage.
 */
const PASSTHROUGH_ENV_KEYS = [
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'ALL_PROXY',
	'NO_PROXY',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	'NODE_EXTRA_CA_CERTS',
	// git itself reads these (askpass / credential helpers / ssh). Even
	// though we authenticate via `http.extraheader`, leaving these on
	// is fine — they're not secrets, they tell git where to LOOK for
	// secrets. Without them, git on Windows can't find OpenSSL CA bundle.
	'GIT_SSH',
	'GIT_SSH_COMMAND',
	'GIT_CONFIG_NOSYSTEM',
	'GIT_CONFIG_GLOBAL',
	'GIT_TERMINAL_PROMPT'
] as const;

export interface LfsCliConfig {
	readonly owner: string;
	readonly repo: string;
	readonly branch: string;
	readonly token: string;
	/** Optional override for GHE deployments. Defaults to `https://github.com`. */
	readonly hostBase?: string;
	/**
	 * Optional cancellation. When the signal fires, the in-flight
	 * child process gets SIGTERM (then SIGKILL after `KILL_TIMEOUT_MS`)
	 * and the wrapping promise rejects with the abort reason. Matches
	 * the other plugin runners' API.
	 */
	readonly signal?: AbortSignal;
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
	const run = (cwd: string | undefined, cmd: string, args: ReadonlyArray<string>) =>
		exec(cmd, args, { cwd, signal: cfg.signal });
	try {
		await runGitClone(run, cfg, tmpdir);
		await run(tmpdir, 'git', ['lfs', 'install', '--local']);
		await run(tmpdir, 'git', ['lfs', 'track', sanitizeTrackPattern(pathPrefix)]);
		for (const file of files) {
			const full = nodePath.join(tmpdir, file.path);
			await fsp.mkdir(nodePath.dirname(full), { recursive: true });
			await fsp.writeFile(full, file.content);
			await run(tmpdir, 'git', ['add', file.path]);
		}
		// `git lfs track` writes `.gitattributes` — always stage it.
		await run(tmpdir, 'git', ['add', '.gitattributes']);
		await run(tmpdir, 'git', [
			'-c',
			`user.name=${committer.name}`,
			'-c',
			`user.email=${committer.email}`,
			'commit',
			'-m',
			commitMessage
		]);
		await run(tmpdir, 'git', ['push', 'origin', cfg.branch]);
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

type Runner = (cwd: string | undefined, cmd: string, args: ReadonlyArray<string>) => Promise<ExecResult>;

async function runGitClone(run: Runner, cfg: LfsCliConfig, dest: string): Promise<void> {
	const host = (cfg.hostBase || DEFAULT_HOST_BASE).replace(/\/$/, '');
	const url = `${host}/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}.git`;
	// We do NOT bake the token into the URL — that would surface it in
	// `git config remote.origin.url` for the lifetime of the temp dir
	// and in any error logs. Instead we use a single-shot
	// `-c http.extraheader=Authorization: Bearer <token>` which only
	// applies to this `git clone` invocation. After the clone we
	// persist the same header on the cloned repo's local config so
	// `git push` authenticates without embedding the token in the
	// remote URL.
	const authHeader = `Authorization: Bearer ${cfg.token}`;
	await run(undefined, 'git', [
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
	]);
	await run(dest, 'git', ['config', '--local', 'http.extraheader', authHeader]);
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

export interface ExecOptions {
	readonly cwd?: string;
	readonly signal?: AbortSignal;
}

export type ExecImpl = (cmd: string, args: ReadonlyArray<string>, opts: ExecOptions) => Promise<ExecResult>;

/**
 * Build the subprocess env from a tight allowlist. Never spread
 * `process.env` — see `Workspace/knowledge/runbooks/EVER_WORKS_CLI_SPAWNING.md`
 * (security audit C-10, 2026-05-17).
 */
function buildSubprocessEnv(): Record<string, string> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
		HOME: process.env.HOME ?? process.env.USERPROFILE ?? os.homedir(),
		TMPDIR: process.env.TMPDIR ?? process.env.TEMP ?? os.tmpdir()
	};
	for (const key of PASSTHROUGH_ENV_KEYS) {
		const value = process.env[key];
		if (value) env[key] = value;
	}
	return env;
}

const defaultExec: ExecImpl = async (cmd, args, opts) => {
	return new Promise((resolve, reject) => {
		const spawnOpts: SpawnOptions = {
			cwd: opts.cwd,
			env: buildSubprocessEnv(),
			stdio: ['ignore', 'pipe', 'pipe']
		};
		let child: ChildProcess;
		try {
			child = spawn(cmd, [...args], spawnOpts);
		} catch (err) {
			reject(
				new Error(
					`Failed to spawn '${cmd} ${args.join(' ')}': ${err instanceof Error ? err.message : String(err)}. ` +
						`Is the binary installed and on PATH?`
				)
			);
			return;
		}

		let stdout = '';
		let stderr = '';
		let killedByCap = false;
		let killedByAbort = false;
		let killTimer: NodeJS.Timeout | undefined;

		const kill = () => {
			if (!child || child.exitCode !== null) return;
			child.kill('SIGTERM');
			killTimer = setTimeout(() => {
				if (child && !child.killed) child.kill('SIGKILL');
			}, KILL_TIMEOUT_MS);
		};

		const onAbort = () => {
			killedByAbort = true;
			kill();
		};
		if (opts.signal) {
			if (opts.signal.aborted) {
				onAbort();
			} else {
				opts.signal.addEventListener('abort', onAbort, { once: true });
			}
		}

		child.stdout?.on('data', (chunk: Buffer) => {
			if (stdout.length + chunk.length > MAX_BUFFER_SIZE) {
				killedByCap = true;
				kill();
				return;
			}
			stdout += chunk.toString();
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			if (stderr.length + chunk.length > MAX_BUFFER_SIZE) {
				killedByCap = true;
				kill();
				return;
			}
			stderr += chunk.toString();
		});
		child.on('error', (err) => {
			if (killTimer) clearTimeout(killTimer);
			if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
			reject(
				new Error(
					`Failed to spawn '${cmd} ${args.join(' ')}': ${err.message}. ` +
						`Is the binary installed and on PATH?`
				)
			);
		});
		child.on('close', (exitCode) => {
			if (killTimer) clearTimeout(killTimer);
			if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
			if (killedByAbort) {
				reject(new Error(`'${cmd} ${args.join(' ')}' aborted via AbortSignal`));
				return;
			}
			if (killedByCap) {
				reject(
					new Error(`'${cmd} ${args.join(' ')}' exceeded ${MAX_BUFFER_SIZE}-byte output cap and was killed`)
				);
				return;
			}
			if (exitCode === 0) {
				resolve({ stdout, stderr, exitCode });
			} else {
				reject(new Error(`'${cmd} ${args.join(' ')}' exited with code ${exitCode}: ${stderr || stdout}`));
			}
		});
	});
};
