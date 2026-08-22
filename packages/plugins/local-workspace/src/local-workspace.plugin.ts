import type {
	IPlugin,
	IWorkspacePlugin,
	PluginContext,
	PluginCategory,
	PluginHealthCheck,
	JsonSchema,
	WorkspaceProvisionSpec,
	WorkspaceHandle,
	WorkspaceFinalizeResult,
	WorkspaceMergeSimulation
} from '@ever-works/plugin';
import { WorkspaceNotProvisionedError } from '@ever-works/plugin';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';

/** Binding stamp kept INSIDE the worktree's gitdir so it can never be
 *  committed and never shows up in the working tree. */
const STAMP_FILE = 'ew-workspace.json';

/** Durable proof written in the trusted bare pool before `worktree add`. */
const INTENTS_DIR = 'ew-workspace-intents';

/** Pool sub-directories under the base dir. */
const REPOS_DIR = 'repos';
const WORKTREES_DIR = 'worktrees';

interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface BindingStamp {
	version: 2;
	bindingKey: string;
	branch: string;
	repositoryKey: string;
	remoteKey: string;
	poolPath: string;
	worktreePath: string;
}

interface ProvisionIntent {
	version: 1;
	bindingKey: string;
	branch: string;
	repositoryKey: string;
	remoteKey: string;
	poolPath: string;
	worktreePath: string;
}

interface WorktreeRegistration {
	path: string;
	head: string;
	branch: string;
}

interface OwnedWorktree {
	stamp: BindingStamp;
	registration: WorktreeRegistration;
}

interface RegisteredCheckout {
	canonicalPool: string;
	canonicalWorktree: string;
	canonicalGitDir: string;
	remoteUrl: string;
	registration: WorktreeRegistration;
}

export interface LocalWorkspacePluginOptions {
	/** Narrow process seam for deterministic cancellation tests. */
	readonly execFile?: typeof execFile;
}

/**
 * Local Workspace — the `workspace` provider for persistent local
 * runtimes.
 *
 * Where sandbox-workspace's ephemeral sandbox degenerates worktree
 * mechanics into fresh-clone-per-run, this provider keeps a PERSISTENT
 * pool on disk: one bare base clone per repository under
 * `<baseDir>/repos/<repo-key>` and one real `git worktree` per Task
 * branch under `<baseDir>/worktrees/<bindingKey>`. Worktrees survive
 * between runs — a re-run resumes in the same directory with the same
 * branch instead of re-cloning.
 *
 * Sharp edges this provider owns:
 *  - **Per-repo creation serialization**: concurrent `git worktree add`
 *    against one clone corrupts refs, so provision calls are serialized
 *    per repo-key with an in-process promise-chain mutex.
 *  - **Binding stamps with self-heal**: every worktree is stamped (in
 *    its gitdir, never the working tree) with `{ bindingKey, branch }`.
 *    A mismatch on reuse removes and re-provisions the worktree instead
 *    of bricking it.
 *  - **GC**: stale worktrees past the cutoff are removed and the pool
 *    repos are `git worktree prune`d so their bookkeeping never leaks.
 *
 * Auth posture (identical to sandbox-workspace): the pool clone's
 * `origin` remote is always TOKEN-FREE. Credentials arrive per-operation
 * in the spec and are injected into the URL of that single command
 * invocation only; they are never written to git config, the stamp file,
 * or the working tree (the checkout runs untrusted repo code). Tokens
 * are scrubbed from every error message before it can propagate into
 * logs.
 */
export class LocalWorkspacePlugin implements IPlugin, IWorkspacePlugin {
	readonly id = 'local-workspace';
	readonly name = 'Local Workspace';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'utility';
	readonly capabilities: readonly string[] = ['workspace'];
	readonly providerName = 'Local (persistent worktree pool)';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			baseDir: {
				type: 'string',
				title: 'Workspace base directory',
				description:
					'Directory the worktree pool lives under. Defaults to EW_WORKSPACES_DIR or the OS temp dir.',
				'x-hidden': true
			},
			fetchDepth: {
				type: 'number',
				title: 'Fetch depth',
				description: 'Shallow fetch depth for the base-ref fetch.',
				default: 1,
				minimum: 1,
				maximum: 1000,
				'x-hidden': true
			},
			committerName: {
				type: 'string',
				title: 'Committer name',
				default: 'Ever Works Agent',
				'x-hidden': true
			},
			committerEmail: {
				type: 'string',
				title: 'Committer email',
				default: 'agent@ever.works',
				'x-hidden': true
			}
		}
	};

	private gitAvailable: boolean | null = null;
	private readonly execFileFn: typeof execFile;

	/** Per-repo promise-chain mutex — see class doc. */
	private readonly repoLocks = new Map<string, Promise<void>>();

	constructor(options: LocalWorkspacePluginOptions = {}) {
		this.execFileFn = options.execFile ?? execFile;
	}

	async onLoad(_context: PluginContext): Promise<void> {
		// Availability is probed lazily on first use — onLoad must stay
		// cheap and never fail registration (the API process loads every
		// plugin; only local runtimes actually run git).
	}

	async onUnload(): Promise<void> {
		this.gitAvailable = null;
		this.repoLocks.clear();
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		const ok = await this.ensureGit().then(
			() => true,
			() => false
		);
		return {
			status: ok ? 'healthy' : 'unhealthy',
			message: ok ? 'git available' : 'git binary not found in this runtime',
			checkedAt: Date.now()
		};
	}

	async provision(spec: WorkspaceProvisionSpec): Promise<WorkspaceHandle> {
		throwIfAborted(spec.signal);
		await this.ensureGit(spec.signal);
		const base = this.baseDir(spec.settings);
		const poolDir = join(base, REPOS_DIR, repoKey(spec.repoUrl));
		const worktreeDir = join(base, WORKTREES_DIR, sanitizeSegment(spec.bindingKey));
		// Concurrent `git worktree add` on one clone corrupts refs —
		// serialize ALL provision work per repo-key. A second path lock also
		// prevents two colliding repository keys from racing the same binding.
		return this.withRepoLock(`repo:${normalizedPath(poolDir)}`, () =>
			this.withRepoLock(`worktree:${normalizedPath(worktreeDir)}`, () =>
				this.provisionLocked(spec, poolDir, worktreeDir)
			)
		);
	}

	private async provisionLocked(
		spec: WorkspaceProvisionSpec,
		poolDir: string,
		worktreeDir: string
	): Promise<WorkspaceHandle> {
		const depth = Number(spec.settings?.fetchDepth) > 0 ? Number(spec.settings?.fetchDepth) : 1;
		throwIfAborted(spec.signal);

		// Inspect an existing binding BEFORE creating/updating/fetching the
		// requested pool. A foreign repository must not get even its remote
		// rewritten simply because its sanitized cache key collided.
		let existing: OwnedWorktree | null = null;
		if (await existsNoFollow(worktreeDir)) {
			if (!(await exists(join(poolDir, 'HEAD')))) {
				throw workspaceOwnershipError('Task workspace is not registered to the requested repository pool');
			}
			try {
				existing = await this.assertOwnedWorktree(poolDir, worktreeDir, spec, spec.signal);
			} catch (error) {
				if (!isWorkspaceOwnershipError(error)) throw error;
				try {
					existing = await this.reconcileInterruptedWorktree(poolDir, worktreeDir, spec, spec.signal);
				} catch (reconcileError) {
					if (isAbortError(reconcileError)) throw reconcileError;
					// No exact intent means this was an ordinary foreign/corrupt
					// path, so retain the original ownership diagnostic.
					throw error;
				}
			}
		}

		// ── pool repo: one BARE base clone per repository ─────────────
		await fs.mkdir(poolDir, { recursive: true });
		if (!(await exists(join(poolDir, 'HEAD')))) {
			await this.gitOrThrow(['init', '--bare'], poolDir, spec.auth, 'pool repo init failed', spec.signal);
			await this.gitOrThrow(
				['remote', 'add', 'origin', spec.repoUrl],
				poolDir,
				spec.auth,
				'pool remote add failed',
				spec.signal
			);
		} else {
			// Read the literal persisted URL. `remote get-url` applies
			// url.*.insteadOf rewrites and would make a token-free canonical
			// remote appear foreign in hermetic/local Git configurations.
			const current = await this.git(['config', '--get', 'remote.origin.url'], poolDir, spec.auth, spec.signal);
			if (current.code !== 0) {
				await this.gitOrThrow(
					['remote', 'add', 'origin', spec.repoUrl],
					poolDir,
					spec.auth,
					'pool remote add failed',
					spec.signal
				);
			} else if (current.stdout.trim() !== spec.repoUrl) {
				throw workspaceOwnershipError('Repository pool is already bound to a different token-free remote');
			}
		}

		const authedUrl = this.authedUrl(spec.repoUrl, spec.auth);

		// Fetch-first, ALWAYS: the base is branched from origin/<baseRef>
		// as of NOW, never a cached ref.
		await this.gitOrThrow(
			[
				'fetch',
				'--depth',
				String(depth),
				authedUrl,
				`+refs/heads/${spec.baseRef}:refs/remotes/origin/${spec.baseRef}`
			],
			poolDir,
			spec.auth,
			`fetch of base ref '${spec.baseRef}' failed`,
			spec.signal
		);

		// A previously pushed task branch is the durable identity — reuse
		// it when it exists (re-run / conflict-fix loop).
		const branchFetch = await this.git(
			['fetch', authedUrl, `+refs/heads/${spec.branch}:refs/remotes/origin/${spec.branch}`],
			poolDir,
			spec.auth,
			spec.signal
		);
		const remoteBranchExists = branchFetch.code === 0;

		const baseSha = (
			await this.gitOrThrow(
				['rev-parse', `refs/remotes/origin/${spec.baseRef}`],
				poolDir,
				spec.auth,
				'base ref did not resolve after fetch',
				spec.signal
			)
		).stdout.trim();

		// ── worktree: reuse only after exact stamp + Git registration ─
		if (existing) {
			if (existing.stamp.branch === spec.branch) {
				await this.removeProvisionIntent(poolDir, worktreeDir, spec);
				// The worktree persists across runs on purpose — resume in
				// place, no re-clone, no branch re-cut.
				return {
					path: worktreeDir,
					baseSha,
					reused: true,
					branch: spec.branch,
					bindingKey: spec.bindingKey
				};
			}

			// A different requested branch is the one supported stale-binding
			// repair. Re-prove ownership under both locks immediately before
			// Git removes anything; foreign/corrupt paths are never self-healed.
			await this.removeIntentMatchingStamp(poolDir, existing.stamp);
			await this.removeOwnedWorktree(poolDir, worktreeDir, spec, spec.signal);
		}

		const startPoint = remoteBranchExists
			? `refs/remotes/origin/${spec.branch}`
			: `refs/remotes/origin/${spec.baseRef}`;
		try {
			await this.writeProvisionIntent(poolDir, worktreeDir, spec);
			throwIfAborted(spec.signal);
			await this.gitOrThrow(
				['worktree', 'add', '-B', spec.branch, worktreeDir, startPoint],
				poolDir,
				spec.auth,
				'worktree add failed',
				spec.signal
			);

			await this.writeStamp(poolDir, worktreeDir, spec, spec.signal);
			await this.assertOwnedWorktree(poolDir, worktreeDir, spec, spec.signal);
			await this.removeProvisionIntent(poolDir, worktreeDir, spec);
		} catch (error) {
			if (isAbortError(error)) {
				// The process may have completed `worktree add` just before the
				// AbortSignal fired. Reconcile only the exact intended checkout
				// while both locks are still held, then preserve cancellation.
				await this.settleCancelledProvision(poolDir, worktreeDir, spec);
			}
			throw error;
		}

		return {
			path: worktreeDir,
			baseSha,
			reused: remoteBranchExists,
			branch: spec.branch,
			bindingKey: spec.bindingKey
		};
	}

	async finalize(
		handle: WorkspaceHandle,
		opts: { commitMessage: string; push: boolean; auth?: WorkspaceProvisionSpec['auth'] }
	): Promise<WorkspaceFinalizeResult> {
		await this.ensureGit();
		const dir = handle.path;
		await this.gitOrThrow(['add', '-A'], dir, opts.auth, 'git add failed');

		const status = await this.gitOrThrow(['status', '--porcelain'], dir, opts.auth, 'git status failed');
		const dirty = status.stdout.trim().length > 0;
		if (dirty) {
			await this.gitOrThrow(
				[
					'-c',
					'user.name=Ever Works Agent',
					'-c',
					'user.email=agent@ever.works',
					'commit',
					'-m',
					opts.commitMessage
				],
				dir,
				opts.auth,
				'git commit failed'
			);
		}

		const head = await this.git(['rev-parse', 'HEAD'], dir, opts.auth);
		const headSha = head.code === 0 ? head.stdout.trim() : null;

		// Empty run: no new commit AND the branch has nothing beyond the
		// base — there is nothing worth pushing or PR-ing.
		if (!dirty && (headSha === null || headSha === handle.baseSha)) {
			return { pushed: false, headSha, empty: true, changedFiles: 0 };
		}

		// Run telemetry — the branch's file footprint vs the base it was
		// cut from. Best-effort: a failed diff omits the field entirely
		// (the caller then leaves the run's counter untouched rather
		// than stamping a wrong 0) and never fails the finalize.
		const changedFiles = await this.countChangedFiles(dir, handle.baseSha, opts.auth);

		let pushed = false;
		if (opts.push) {
			const repoUrl = (
				await this.gitOrThrow(['remote', 'get-url', 'origin'], dir, opts.auth, 'origin remote missing')
			).stdout.trim();
			await this.gitOrThrow(
				['push', this.authedUrl(repoUrl, opts.auth), `HEAD:refs/heads/${handle.branch}`],
				dir,
				opts.auth,
				'git push failed'
			);
			pushed = true;
		}

		return {
			pushed,
			headSha,
			empty: false,
			...(changedFiles === null ? {} : { changedFiles })
		};
	}

	/**
	 * `git diff --name-only <baseSha>..HEAD` → distinct changed-file
	 * count for the run-telemetry counter. Returns null when the diff
	 * cannot be taken (unknown base, git failure), so the caller can
	 * tell "no data" apart from "zero files".
	 */
	private async countChangedFiles(
		dir: string,
		baseSha: string,
		auth?: WorkspaceProvisionSpec['auth']
	): Promise<number | null> {
		try {
			const diff = await this.git(['diff', '--name-only', `${baseSha}..HEAD`], dir, auth);
			if (diff.code !== 0) return null;
			const files = diff.stdout
				.split('\n')
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
			return new Set(files).size;
		} catch {
			return null;
		}
	}

	async simulateMerge(
		handle: WorkspaceHandle,
		targetRef: string,
		auth?: WorkspaceProvisionSpec['auth']
	): Promise<WorkspaceMergeSimulation> {
		await this.ensureGit();
		const dir = handle.path;
		const repoUrl = (
			await this.gitOrThrow(['remote', 'get-url', 'origin'], dir, auth, 'origin remote missing')
		).stdout.trim();

		// Merge against the target AS OF NOW — a stale target is how you
		// end up shipping a PR with a red merge banner.
		await this.gitOrThrow(
			['fetch', this.authedUrl(repoUrl, auth), `+refs/heads/${targetRef}:refs/remotes/origin/${targetRef}`],
			dir,
			auth,
			`fetch of merge target '${targetRef}' failed`
		);

		let result = await this.git(
			['merge-tree', '--write-tree', '--name-only', `refs/remotes/origin/${targetRef}`, 'HEAD'],
			dir,
			auth
		);

		// Shallow histories can lack a merge base; deepen once and retry.
		if (result.code > 1) {
			await this.git(['fetch', this.authedUrl(repoUrl, auth), '--unshallow'], dir, auth);
			result = await this.git(
				['merge-tree', '--write-tree', '--name-only', `refs/remotes/origin/${targetRef}`, 'HEAD'],
				dir,
				auth
			);
		}

		if (result.code === 0) {
			return { clean: true, conflictPaths: [] };
		}
		if (result.code === 1) {
			// Output: first line = written tree OID, following lines = the
			// conflicted file names (--name-only).
			const lines = result.stdout
				.split('\n')
				.map((l) => l.trim())
				.filter(Boolean);
			return { clean: false, conflictPaths: lines.slice(1) };
		}
		throw new Error(`merge simulation failed: ${this.scrub(result.stderr, auth)}`);
	}

	async teardown(handle: WorkspaceHandle): Promise<void> {
		await this.ensureGit();
		const poolDir = await this.poolDirOf(handle.path);
		if (!poolDir) {
			throw workspaceOwnershipError('Workspace teardown refused because its repository pool did not resolve');
		}
		await this.withRepoLock(`repo:${normalizedPath(poolDir)}`, () =>
			this.withRepoLock(`worktree:${normalizedPath(handle.path)}`, async () => {
				const owned = await this.inspectRegisteredWorktree(poolDir, handle.path, undefined, undefined);
				if (owned.stamp.bindingKey !== handle.bindingKey || owned.stamp.branch !== handle.branch) {
					throw workspaceOwnershipError('Workspace teardown refused a foreign task binding');
				}
				await this.removeRegisteredWorktree(poolDir, handle.path, undefined, undefined);
			})
		);
	}

	async gc(policy: { olderThanDays: number }): Promise<{ removed: string[] }> {
		const base = this.baseDir(undefined);
		const removed: string[] = [];
		const cutoff = Date.now() - policy.olderThanDays * 24 * 60 * 60 * 1000;

		// 1) Remove stale worktrees past the cutoff.
		const worktreesRoot = join(base, WORKTREES_DIR);
		let entries: string[] = [];
		try {
			entries = await fs.readdir(worktreesRoot);
		} catch {
			entries = [];
		}
		for (const entry of entries) {
			const dir = join(worktreesRoot, entry);
			try {
				const stat = await fs.stat(dir);
				if (stat.isDirectory() && stat.mtimeMs < cutoff) {
					await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
					removed.push(entry);
				}
			} catch {
				// Entry vanished mid-scan — GC is best-effort by design.
			}
		}

		// 2) Prune the pool repos' worktree bookkeeping so removed dirs
		//    never linger as phantom registrations.
		const reposRoot = join(base, REPOS_DIR);
		let repos: string[] = [];
		try {
			repos = await fs.readdir(reposRoot);
		} catch {
			repos = [];
		}
		for (const repo of repos) {
			await this.git(['worktree', 'prune'], join(reposRoot, repo), undefined);
		}

		return { removed };
	}

	// ── internals ────────────────────────────────────────────────────

	private baseDir(settings: WorkspaceProvisionSpec['settings']): string {
		const configured = (typeof settings?.baseDir === 'string' && settings.baseDir) || process.env.EW_WORKSPACES_DIR;
		return configured || join(tmpdir(), 'ew-local-workspaces');
	}

	/**
	 * Serialize work per repo-key with an in-process promise chain. The
	 * stored chain always resolves (rejections are swallowed into it) so
	 * one failed provision never poisons the queue behind it.
	 */
	private withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.repoLocks.get(key) ?? Promise.resolve();
		const run = prev.then(fn);
		this.repoLocks.set(
			key,
			run.then(
				() => undefined,
				() => undefined
			)
		);
		return run;
	}

	private async ensureGit(signal?: AbortSignal): Promise<void> {
		if (this.gitAvailable === true) return;
		const probe = await this.git(['--version'], undefined, undefined, signal);
		if (probe.code !== 0) {
			this.gitAvailable = false;
			throw new WorkspaceNotProvisionedError(
				'git is not available in this runtime — the local-workspace provider cannot operate.'
			);
		}
		this.gitAvailable = true;
	}

	/** Resolve the pool repo a worktree belongs to (its common gitdir). */
	private async poolDirOf(worktreePath: string): Promise<string | null> {
		const result = await this.git(
			['rev-parse', '--path-format=absolute', '--git-common-dir'],
			worktreePath,
			undefined
		);
		if (result.code !== 0) return null;
		const common = result.stdout.trim();
		return common ? resolvePath(common) : null;
	}

	/** Final provisioning deletion gate. This runs under both repository and
	 * worktree locks and re-proves exact ownership immediately before Git. */
	private async removeOwnedWorktree(
		poolDir: string,
		worktreeDir: string,
		spec: WorkspaceProvisionSpec,
		signal?: AbortSignal
	): Promise<void> {
		await this.assertOwnedWorktree(poolDir, worktreeDir, spec, signal);
		await this.removeRegisteredWorktree(poolDir, worktreeDir, spec.auth, signal);
	}

	private async removeRegisteredWorktree(
		poolDir: string,
		worktreeDir: string,
		auth: WorkspaceProvisionSpec['auth'],
		signal?: AbortSignal
	): Promise<void> {
		throwIfAborted(signal);
		await this.gitOrThrow(
			['worktree', 'remove', '--force', worktreeDir],
			poolDir,
			auth,
			'owned worktree remove failed',
			signal
		);
		await this.gitOrThrow(['worktree', 'prune'], poolDir, auth, 'worktree prune failed', signal);
		if (await existsNoFollow(worktreeDir)) {
			throw workspaceOwnershipError(
				'Git removed the registration but the workspace path still exists; refusing an unchecked filesystem delete'
			);
		}
	}

	/** Inject per-operation auth into the URL of ONE command invocation. */
	private authedUrl(repoUrl: string, auth: WorkspaceProvisionSpec['auth']): string {
		if (!auth?.token) return repoUrl;
		try {
			const url = new URL(repoUrl);
			url.username = auth.username || 'x-access-token';
			url.password = auth.token;
			return url.toString();
		} catch {
			return repoUrl;
		}
	}

	/** Remove any credential material from text before it can be logged. */
	private scrub(text: string, auth: WorkspaceProvisionSpec['auth']): string {
		let out = text;
		if (auth?.token) out = out.split(auth.token).join('***');
		// Belt-and-braces: strip userinfo from any URL that slipped through.
		out = out.replace(/(https?:\/\/)[^/@\s]+@/g, '$1***@');
		return out;
	}

	private git(
		args: string[],
		cwd: string | undefined,
		auth: WorkspaceProvisionSpec['auth'],
		signal?: AbortSignal
	): Promise<GitResult> {
		throwIfAborted(signal);
		return new Promise((resolve, reject) => {
			this.execFileFn(
				'git',
				args,
				{
					cwd,
					env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
					maxBuffer: 16 * 1024 * 1024,
					windowsHide: true,
					...(signal ? { signal } : {})
				},
				(error, stdout, stderr) => {
					if (signal?.aborted || error?.name === 'AbortError') {
						reject(abortError());
						return;
					}
					const code =
						error && typeof (error as { code?: unknown }).code === 'number'
							? ((error as { code?: number }).code ?? 1)
							: error
								? 1
								: 0;
					resolve({
						code,
						stdout: String(stdout ?? ''),
						stderr: this.scrub(String(stderr ?? ''), auth)
					});
				}
			);
		});
	}

	private async gitOrThrow(
		args: string[],
		cwd: string | undefined,
		auth: WorkspaceProvisionSpec['auth'],
		what: string,
		signal?: AbortSignal
	): Promise<GitResult> {
		const result = await this.git(args, cwd, auth, signal);
		if (result.code !== 0) {
			throw new Error(`${what}: ${result.stderr.trim() || `git exited ${result.code}`}`);
		}
		return result;
	}

	/** The worktree's PRIVATE gitdir (never the shared common dir, never
	 *  the working tree — the stamp must not be committable). */
	private async gitDirOf(
		worktreeDir: string,
		auth: WorkspaceProvisionSpec['auth'],
		signal?: AbortSignal
	): Promise<string | null> {
		const result = await this.git(['rev-parse', '--path-format=absolute', '--git-dir'], worktreeDir, auth, signal);
		if (result.code !== 0) return null;
		const dir = result.stdout.trim();
		return dir ? resolvePath(dir) : null;
	}

	private async assertOwnedWorktree(
		poolDir: string,
		worktreeDir: string,
		spec: WorkspaceProvisionSpec,
		signal?: AbortSignal
	): Promise<OwnedWorktree> {
		const owned = await this.inspectRegisteredWorktree(poolDir, worktreeDir, spec.auth, signal);
		if (
			owned.stamp.bindingKey !== spec.bindingKey ||
			owned.stamp.repositoryKey !== repositoryIdentity(spec) ||
			owned.stamp.remoteKey !== remoteIdentity(spec.repoUrl)
		) {
			throw workspaceOwnershipError('Existing workspace belongs to a different task or repository');
		}
		return owned;
	}

	/** Recover only an unstamped checkout backed by this task's durable intent. */
	private async reconcileInterruptedWorktree(
		poolDir: string,
		worktreeDir: string,
		spec: WorkspaceProvisionSpec,
		signal?: AbortSignal
	): Promise<OwnedWorktree> {
		await this.inspectIntentRegisteredCheckout(poolDir, worktreeDir, spec, signal);
		await this.writeStamp(poolDir, worktreeDir, spec, signal);
		const owned = await this.assertOwnedWorktree(poolDir, worktreeDir, spec, signal);
		await this.removeProvisionIntent(poolDir, worktreeDir, spec);
		return owned;
	}

	/**
	 * Best-effort cancellation settlement. This runs before the original
	 * AbortError leaves the nested repository/worktree locks. A completed,
	 * exactly registered checkout is stamped for idempotent retry. If stamping
	 * fails, deletion is attempted only after the intent + Git proof is repeated.
	 */
	private async settleCancelledProvision(
		poolDir: string,
		worktreeDir: string,
		spec: WorkspaceProvisionSpec
	): Promise<void> {
		try {
			if (!(await existsNoFollow(worktreeDir))) return;
			await this.inspectIntentRegisteredCheckout(poolDir, worktreeDir, spec);
			try {
				await this.writeStamp(poolDir, worktreeDir, spec);
				await this.assertOwnedWorktree(poolDir, worktreeDir, spec);
				await this.removeProvisionIntent(poolDir, worktreeDir, spec);
				return;
			} catch {
				// Re-prove immediately before the only deletion path. If a stamp
				// appeared or any registration changed, this throws and preserves it.
				await this.inspectIntentRegisteredCheckout(poolDir, worktreeDir, spec);
				await this.removeRegisteredWorktree(poolDir, worktreeDir, spec.auth);
				await this.removeProvisionIntent(poolDir, worktreeDir, spec);
			}
		} catch {
			// An unprovable partial path is deliberately preserved. The durable
			// intent remains for diagnostics; a retry will refuse the collision.
		}
	}

	private async writeProvisionIntent(
		poolDir: string,
		worktreeDir: string,
		spec: WorkspaceProvisionSpec
	): Promise<void> {
		const canonicalPool = await assertPlainDirectory(poolDir);
		if (!samePath(canonicalPool, poolDir)) {
			throw workspaceOwnershipError('Repository pool resolves through an alias');
		}
		const intentsDir = join(canonicalPool, INTENTS_DIR);
		try {
			await fs.mkdir(intentsDir, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
		const canonicalIntentsDir = await assertPlainDirectory(intentsDir);
		if (!samePath(canonicalIntentsDir, intentsDir) || !isStrictDescendant(canonicalPool, canonicalIntentsDir)) {
			throw workspaceOwnershipError('Workspace intent directory resolves outside its repository pool');
		}

		const expected = provisionIntent(poolDir, worktreeDir, spec);
		const existing = await this.readProvisionIntent(poolDir, spec.bindingKey);
		if (existing) {
			if (!sameProvisionIntent(existing, expected)) {
				throw workspaceOwnershipError('Existing workspace intent belongs to a different task or repository');
			}
			return;
		}

		const target = provisionIntentPath(canonicalPool, spec.bindingKey);
		const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(temporary, JSON.stringify(expected), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
			await fs.rename(temporary, target);
		} finally {
			await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== 'ENOENT') throw error;
			});
		}
	}

	private async readProvisionIntent(poolDir: string, bindingKey: string): Promise<ProvisionIntent | null> {
		const canonicalPool = await assertPlainDirectory(poolDir);
		if (!samePath(canonicalPool, poolDir)) {
			throw workspaceOwnershipError('Repository pool resolves through an alias');
		}
		const intentsDir = join(canonicalPool, INTENTS_DIR);
		if (!(await existsNoFollow(intentsDir))) return null;
		const canonicalIntentsDir = await assertPlainDirectory(intentsDir);
		if (!samePath(canonicalIntentsDir, intentsDir) || !isStrictDescendant(canonicalPool, canonicalIntentsDir)) {
			throw workspaceOwnershipError('Workspace intent directory resolves outside its repository pool');
		}
		const path = provisionIntentPath(canonicalPool, bindingKey);
		let stats;
		try {
			stats = await fs.lstat(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw error;
		}
		if (stats.isSymbolicLink() || !stats.isFile()) {
			throw workspaceOwnershipError('Workspace intent is a link or non-file');
		}
		return parseProvisionIntent(await fs.readFile(path, 'utf8'));
	}

	private async removeProvisionIntent(
		poolDir: string,
		worktreeDir: string,
		spec: WorkspaceProvisionSpec
	): Promise<void> {
		const actual = await this.readProvisionIntent(poolDir, spec.bindingKey);
		if (!actual) return;
		const expected = provisionIntent(poolDir, worktreeDir, spec);
		if (!sameProvisionIntent(actual, expected)) {
			throw workspaceOwnershipError('Workspace intent does not match the exact task binding');
		}
		await fs.unlink(provisionIntentPath(poolDir, spec.bindingKey));
	}

	private async removeIntentMatchingStamp(poolDir: string, stamp: BindingStamp): Promise<void> {
		const actual = await this.readProvisionIntent(poolDir, stamp.bindingKey);
		if (!actual) return;
		if (
			actual.bindingKey !== stamp.bindingKey ||
			actual.branch !== stamp.branch ||
			actual.repositoryKey !== stamp.repositoryKey ||
			actual.remoteKey !== stamp.remoteKey ||
			actual.poolPath !== stamp.poolPath ||
			actual.worktreePath !== stamp.worktreePath
		) {
			throw workspaceOwnershipError('Workspace intent does not match the proven task binding');
		}
		await fs.unlink(provisionIntentPath(poolDir, stamp.bindingKey));
	}

	private async inspectIntentRegisteredCheckout(
		poolDir: string,
		worktreeDir: string,
		spec: WorkspaceProvisionSpec,
		signal?: AbortSignal
	): Promise<RegisteredCheckout> {
		const intent = await this.readProvisionIntent(poolDir, spec.bindingKey);
		if (!intent || !sameProvisionIntent(intent, provisionIntent(poolDir, worktreeDir, spec))) {
			throw workspaceOwnershipError('Unstamped workspace has no exact durable provisioning intent');
		}
		const checkout = await this.inspectRegisteredCheckout(poolDir, worktreeDir, spec.auth, signal);
		if (
			intent.poolPath !== normalizedPath(checkout.canonicalPool) ||
			intent.worktreePath !== normalizedPath(checkout.canonicalWorktree) ||
			intent.remoteKey !== remoteIdentity(checkout.remoteUrl) ||
			checkout.registration.branch !== spec.branch
		) {
			throw workspaceOwnershipError('Provisioning intent does not match the exact Git registration');
		}
		try {
			await fs.lstat(join(checkout.canonicalGitDir, STAMP_FILE));
			throw workspaceOwnershipError('An existing workspace stamp cannot be replaced from an intent');
		} catch (error) {
			if (isWorkspaceOwnershipError(error)) throw error;
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		return checkout;
	}

	/**
	 * Strong ownership proof shared by reuse, stale-binding removal, and
	 * teardown. A writable stamp alone is never authority: the lexical path
	 * must be a plain directory, its canonical path must be exact, its common
	 * and private Git directories must belong to this pool, and the pool's
	 * porcelain registration must name the same path, branch, and HEAD.
	 */
	private async inspectRegisteredWorktree(
		poolDir: string,
		worktreeDir: string,
		auth: WorkspaceProvisionSpec['auth'],
		signal?: AbortSignal
	): Promise<OwnedWorktree> {
		const checkout = await this.inspectRegisteredCheckout(poolDir, worktreeDir, auth, signal);
		const stampPath = join(checkout.canonicalGitDir, STAMP_FILE);
		let stamp: BindingStamp;
		try {
			const stampStats = await fs.lstat(stampPath);
			if (stampStats.isSymbolicLink() || !stampStats.isFile()) throw new Error('unsafe stamp');
			stamp = parseBindingStamp(await fs.readFile(stampPath, 'utf8'));
		} catch (error) {
			if (isAbortError(error)) throw error;
			throw workspaceOwnershipError('Workspace binding stamp is missing, foreign, or corrupt');
		}
		if (
			stamp.poolPath !== normalizedPath(checkout.canonicalPool) ||
			stamp.worktreePath !== normalizedPath(checkout.canonicalWorktree) ||
			stamp.remoteKey !== remoteIdentity(checkout.remoteUrl)
		) {
			throw workspaceOwnershipError('Workspace binding stamp does not match its exact repository and path');
		}
		if (checkout.registration.branch !== stamp.branch) {
			throw workspaceOwnershipError('Workspace has no exact path, branch, and HEAD registration in this pool');
		}

		return { stamp, registration: checkout.registration };
	}

	private async inspectRegisteredCheckout(
		poolDir: string,
		worktreeDir: string,
		auth: WorkspaceProvisionSpec['auth'],
		signal?: AbortSignal
	): Promise<RegisteredCheckout> {
		throwIfAborted(signal);
		let canonicalPool: string;
		let canonicalWorktree: string;
		try {
			[canonicalPool, canonicalWorktree] = await Promise.all([
				assertPlainDirectory(poolDir),
				assertPlainDirectory(worktreeDir)
			]);
		} catch (error) {
			if (isAbortError(error)) throw error;
			throw workspaceOwnershipError(
				'Workspace path or repository pool is a link, reparse point, or non-directory'
			);
		}
		if (!samePath(canonicalPool, poolDir) || !samePath(canonicalWorktree, worktreeDir)) {
			throw workspaceOwnershipError('Workspace path or repository pool resolves through an alias');
		}

		const [commonResult, gitDirResult, originResult, registrationsResult] = await Promise.all([
			this.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], canonicalWorktree, auth, signal),
			this.git(['rev-parse', '--path-format=absolute', '--git-dir'], canonicalWorktree, auth, signal),
			this.git(['config', '--get', 'remote.origin.url'], canonicalPool, auth, signal),
			this.git(['worktree', 'list', '--porcelain'], canonicalPool, auth, signal)
		]);
		if (
			commonResult.code !== 0 ||
			gitDirResult.code !== 0 ||
			originResult.code !== 0 ||
			registrationsResult.code !== 0
		) {
			throw workspaceOwnershipError('Workspace Git ownership metadata could not be verified');
		}

		let canonicalCommon: string;
		let canonicalGitDir: string;
		try {
			[canonicalCommon, canonicalGitDir] = await Promise.all([
				fs.realpath(commonResult.stdout.trim()),
				fs.realpath(gitDirResult.stdout.trim())
			]);
		} catch {
			throw workspaceOwnershipError('Workspace Git directories did not resolve canonically');
		}
		if (
			!samePath(canonicalCommon, canonicalPool) ||
			!isStrictDescendant(join(canonicalPool, WORKTREES_DIR), canonicalGitDir)
		) {
			throw workspaceOwnershipError('Workspace is registered to a different repository pool');
		}

		const registrations = parseWorktreeRegistrations(registrationsResult.stdout);
		const matches = registrations.filter((entry) => samePath(entry.path, canonicalWorktree));
		if (matches.length !== 1 || !/^[0-9a-f]{40,64}$/i.test(matches[0].head)) {
			throw workspaceOwnershipError('Workspace has no exact path, branch, and HEAD registration in this pool');
		}

		return {
			canonicalPool,
			canonicalWorktree,
			canonicalGitDir,
			remoteUrl: originResult.stdout.trim(),
			registration: matches[0]
		};
	}

	private async writeStamp(
		poolDir: string,
		worktreeDir: string,
		spec: WorkspaceProvisionSpec,
		signal?: AbortSignal
	): Promise<void> {
		const [canonicalPool, canonicalWorktree] = await Promise.all([
			fs.realpath(poolDir),
			assertPlainDirectory(worktreeDir)
		]);
		if (!samePath(canonicalPool, poolDir) || !samePath(canonicalWorktree, worktreeDir)) {
			throw workspaceOwnershipError('New workspace resolved through a link or reparse-point alias');
		}
		const gitDir = await this.gitDirOf(worktreeDir, spec.auth, signal);
		if (!gitDir) {
			throw new Error('cannot stamp workspace: worktree gitdir did not resolve');
		}
		const canonicalGitDir = await fs.realpath(gitDir);
		if (!isStrictDescendant(join(canonicalPool, WORKTREES_DIR), canonicalGitDir)) {
			throw workspaceOwnershipError('New workspace private Git directory belongs to another repository');
		}
		const stamp: BindingStamp = {
			version: 2,
			bindingKey: spec.bindingKey,
			branch: spec.branch,
			repositoryKey: repositoryIdentity(spec),
			remoteKey: remoteIdentity(spec.repoUrl),
			poolPath: normalizedPath(canonicalPool),
			worktreePath: normalizedPath(canonicalWorktree)
		};
		await fs.writeFile(join(canonicalGitDir, STAMP_FILE), JSON.stringify(stamp), {
			encoding: 'utf8',
			mode: 0o600
		});
	}
}

function sanitizeSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'workspace';
}

/** Deterministic pool key for a repo URL (token- and scheme-free). */
function repoKey(repoUrl: string): string {
	const stripped = repoUrl
		.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
		.replace(/^[^/@\s]+@/, '')
		.replace(/\.git$/, '');
	return sanitizeSegment(stripped);
}

function repositoryIdentity(spec: WorkspaceProvisionSpec): string {
	return createHash('sha256')
		.update('workspace-repository-v2\0')
		.update(spec.repositoryId ?? '')
		.update('\0')
		.update(spec.repoUrl)
		.digest('hex');
}

function remoteIdentity(repoUrl: string): string {
	return createHash('sha256').update('workspace-remote-v1\0').update(repoUrl).digest('hex');
}

function provisionIntent(poolDir: string, worktreeDir: string, spec: WorkspaceProvisionSpec): ProvisionIntent {
	return {
		version: 1,
		bindingKey: spec.bindingKey,
		branch: spec.branch,
		repositoryKey: repositoryIdentity(spec),
		remoteKey: remoteIdentity(spec.repoUrl),
		poolPath: normalizedPath(poolDir),
		worktreePath: normalizedPath(worktreeDir)
	};
}

function provisionIntentPath(poolDir: string, bindingKey: string): string {
	const key = createHash('sha256').update('workspace-intent-v1\0').update(bindingKey).digest('hex');
	return join(poolDir, INTENTS_DIR, `${key}.json`);
}

function sameProvisionIntent(left: ProvisionIntent, right: ProvisionIntent): boolean {
	return (
		left.version === right.version &&
		left.bindingKey === right.bindingKey &&
		left.branch === right.branch &&
		left.repositoryKey === right.repositoryKey &&
		left.remoteKey === right.remoteKey &&
		left.poolPath === right.poolPath &&
		left.worktreePath === right.worktreePath
	);
}

function normalizedPath(value: string): string {
	const normalized = resolvePath(value);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
	return normalizedPath(left) === normalizedPath(right);
}

function isStrictDescendant(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return child !== '' && child.split(/[\\/]/)[0] !== '..' && !isAbsolute(child);
}

async function assertPlainDirectory(path: string): Promise<string> {
	const stats = await fs.lstat(path);
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		throw workspaceOwnershipError('Expected a plain directory, not a link, reparse point, or file');
	}
	return fs.realpath(path);
}

function parseBindingStamp(raw: string): BindingStamp {
	const parsed = JSON.parse(raw) as Partial<Record<keyof BindingStamp, unknown>>;
	if (
		parsed.version !== 2 ||
		typeof parsed.bindingKey !== 'string' ||
		!parsed.bindingKey ||
		typeof parsed.branch !== 'string' ||
		!parsed.branch ||
		typeof parsed.repositoryKey !== 'string' ||
		!/^[0-9a-f]{64}$/i.test(parsed.repositoryKey) ||
		typeof parsed.remoteKey !== 'string' ||
		!/^[0-9a-f]{64}$/i.test(parsed.remoteKey) ||
		typeof parsed.poolPath !== 'string' ||
		typeof parsed.worktreePath !== 'string'
	) {
		throw workspaceOwnershipError('Workspace binding stamp is not the strong v2 format');
	}
	return parsed as unknown as BindingStamp;
}

function parseProvisionIntent(raw: string): ProvisionIntent {
	const parsed = JSON.parse(raw) as Partial<Record<keyof ProvisionIntent, unknown>>;
	if (
		parsed.version !== 1 ||
		typeof parsed.bindingKey !== 'string' ||
		!parsed.bindingKey ||
		typeof parsed.branch !== 'string' ||
		!parsed.branch ||
		typeof parsed.repositoryKey !== 'string' ||
		!/^[0-9a-f]{64}$/i.test(parsed.repositoryKey) ||
		typeof parsed.remoteKey !== 'string' ||
		!/^[0-9a-f]{64}$/i.test(parsed.remoteKey) ||
		typeof parsed.poolPath !== 'string' ||
		typeof parsed.worktreePath !== 'string'
	) {
		throw workspaceOwnershipError('Workspace provisioning intent is corrupt');
	}
	return parsed as unknown as ProvisionIntent;
}

function parseWorktreeRegistrations(output: string): WorktreeRegistration[] {
	const registrations: WorktreeRegistration[] = [];
	let current: Partial<WorktreeRegistration> = {};
	const finish = (): void => {
		if (typeof current.path === 'string') {
			registrations.push({
				path: current.path,
				head: current.head ?? '',
				branch: current.branch ?? ''
			});
		}
		current = {};
	};
	for (const rawLine of `${output}\n`.split(/\r?\n/)) {
		if (!rawLine) {
			finish();
			continue;
		}
		if (rawLine.startsWith('worktree ')) current.path = rawLine.slice('worktree '.length);
		else if (rawLine.startsWith('HEAD ')) current.head = rawLine.slice('HEAD '.length);
		else if (rawLine.startsWith('branch refs/heads/')) {
			current.branch = rawLine.slice('branch refs/heads/'.length);
		}
	}
	return registrations;
}

function workspaceOwnershipError(message: string): Error {
	const error = new Error(message);
	error.name = 'WorkspaceOwnershipError';
	return error;
}

function isWorkspaceOwnershipError(error: unknown): boolean {
	return error instanceof Error && error.name === 'WorkspaceOwnershipError';
}

function abortError(): Error {
	const error = new Error('Workspace provisioning was cancelled');
	error.name = 'AbortError';
	return error;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

async function exists(path: string): Promise<boolean> {
	return fs.access(path).then(
		() => true,
		() => false
	);
}

async function existsNoFollow(path: string): Promise<boolean> {
	return fs.lstat(path).then(
		() => true,
		(error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') return false;
			throw error;
		}
	);
}

export default LocalWorkspacePlugin;
