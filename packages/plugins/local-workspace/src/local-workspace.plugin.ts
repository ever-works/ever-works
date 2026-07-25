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
import { promises as fs } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';

/** Binding stamp kept INSIDE the worktree's gitdir so it can never be
 *  committed and never shows up in the working tree. */
const STAMP_FILE = 'ew-workspace.json';

/** Pool sub-directories under the base dir. */
const REPOS_DIR = 'repos';
const WORKTREES_DIR = 'worktrees';

interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface BindingStamp {
	bindingKey: string;
	branch: string;
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

	/** Per-repo promise-chain mutex — see class doc. */
	private readonly repoLocks = new Map<string, Promise<void>>();

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
		await this.ensureGit();
		// Concurrent `git worktree add` on one clone corrupts refs —
		// serialize ALL provision work per repo-key.
		return this.withRepoLock(repoKey(spec.repoUrl), () => this.provisionLocked(spec));
	}

	private async provisionLocked(spec: WorkspaceProvisionSpec): Promise<WorkspaceHandle> {
		const base = this.baseDir(spec.settings);
		const poolDir = join(base, REPOS_DIR, repoKey(spec.repoUrl));
		const worktreeDir = join(base, WORKTREES_DIR, sanitizeSegment(spec.bindingKey));
		const depth = Number(spec.settings?.fetchDepth) > 0 ? Number(spec.settings?.fetchDepth) : 1;

		// ── pool repo: one BARE base clone per repository ─────────────
		await fs.mkdir(poolDir, { recursive: true });
		if (!(await exists(join(poolDir, 'HEAD')))) {
			await this.gitOrThrow(['init', '--bare'], poolDir, spec.auth, 'pool repo init failed');
			await this.gitOrThrow(
				['remote', 'add', 'origin', spec.repoUrl],
				poolDir,
				spec.auth,
				'pool remote add failed'
			);
		} else {
			// Keep the persisted remote token-free and current — but only
			// touch config when the URL actually changed (a reused pool
			// must not be rewritten on every provision).
			const current = await this.git(['remote', 'get-url', 'origin'], poolDir, spec.auth);
			if (current.code !== 0) {
				await this.gitOrThrow(
					['remote', 'add', 'origin', spec.repoUrl],
					poolDir,
					spec.auth,
					'pool remote add failed'
				);
			} else if (current.stdout.trim() !== spec.repoUrl) {
				await this.gitOrThrow(
					['remote', 'set-url', 'origin', spec.repoUrl],
					poolDir,
					spec.auth,
					'pool remote set-url failed'
				);
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
			`fetch of base ref '${spec.baseRef}' failed`
		);

		// A previously pushed task branch is the durable identity — reuse
		// it when it exists (re-run / conflict-fix loop).
		const branchFetch = await this.git(
			['fetch', authedUrl, `+refs/heads/${spec.branch}:refs/remotes/origin/${spec.branch}`],
			poolDir,
			spec.auth
		);
		const remoteBranchExists = branchFetch.code === 0;

		const baseSha = (
			await this.gitOrThrow(
				['rev-parse', `refs/remotes/origin/${spec.baseRef}`],
				poolDir,
				spec.auth,
				'base ref did not resolve after fetch'
			)
		).stdout.trim();

		// ── worktree: reuse when the binding stamp matches ────────────
		if (await exists(worktreeDir)) {
			const stamp = await this.readStamp(worktreeDir, spec.auth);
			const checkedOut =
				stamp !== null ? await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreeDir, spec.auth) : null;
			const healthy =
				stamp !== null &&
				stamp.bindingKey === spec.bindingKey &&
				stamp.branch === spec.branch &&
				checkedOut !== null &&
				checkedOut.code === 0 &&
				checkedOut.stdout.trim() === spec.branch;

			if (healthy) {
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

			// Self-heal: stale dir, corrupt/missing stamp, foreign binding
			// or a branch collision — remove and recreate instead of
			// bricking the workspace.
			await this.removeWorktree(poolDir, worktreeDir, spec.auth);
		}

		const startPoint = remoteBranchExists
			? `refs/remotes/origin/${spec.branch}`
			: `refs/remotes/origin/${spec.baseRef}`;
		await this.gitOrThrow(
			['worktree', 'add', '-B', spec.branch, worktreeDir, startPoint],
			poolDir,
			spec.auth,
			'worktree add failed'
		);

		await this.writeStamp(worktreeDir, { bindingKey: spec.bindingKey, branch: spec.branch }, spec.auth);

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
			return { pushed: false, headSha, empty: true };
		}

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

		return { pushed, headSha, empty: false };
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
		const poolDir = await this.poolDirOf(handle.path);
		if (poolDir) {
			await this.removeWorktree(poolDir, handle.path, undefined);
		} else {
			await fs.rm(handle.path, { recursive: true, force: true, maxRetries: 3 });
		}
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

	private async ensureGit(): Promise<void> {
		if (this.gitAvailable === true) return;
		const probe = await this.git(['--version'], undefined, undefined);
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

	/**
	 * Route EVERY worktree delete through git so the pool repo's
	 * bookkeeping stays consistent; fall back to rm + prune when git
	 * refuses (broken worktree, missing admin files).
	 */
	private async removeWorktree(
		poolDir: string,
		worktreeDir: string,
		auth: WorkspaceProvisionSpec['auth']
	): Promise<void> {
		await this.git(['worktree', 'remove', '--force', worktreeDir], poolDir, auth);
		await fs.rm(worktreeDir, { recursive: true, force: true, maxRetries: 3 });
		await this.git(['worktree', 'prune'], poolDir, auth);
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

	private git(args: string[], cwd: string | undefined, auth: WorkspaceProvisionSpec['auth']): Promise<GitResult> {
		return new Promise((resolve) => {
			execFile(
				'git',
				args,
				{
					cwd,
					env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
					maxBuffer: 16 * 1024 * 1024,
					windowsHide: true
				},
				(error, stdout, stderr) => {
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
		what: string
	): Promise<GitResult> {
		const result = await this.git(args, cwd, auth);
		if (result.code !== 0) {
			throw new Error(`${what}: ${result.stderr.trim() || `git exited ${result.code}`}`);
		}
		return result;
	}

	/** The worktree's PRIVATE gitdir (never the shared common dir, never
	 *  the working tree — the stamp must not be committable). */
	private async gitDirOf(worktreeDir: string, auth: WorkspaceProvisionSpec['auth']): Promise<string | null> {
		const result = await this.git(['rev-parse', '--path-format=absolute', '--git-dir'], worktreeDir, auth);
		if (result.code !== 0) return null;
		const dir = result.stdout.trim();
		return dir ? resolvePath(dir) : null;
	}

	private async readStamp(worktreeDir: string, auth: WorkspaceProvisionSpec['auth']): Promise<BindingStamp | null> {
		try {
			const gitDir = await this.gitDirOf(worktreeDir, auth);
			if (!gitDir) return null;
			const raw = await fs.readFile(join(gitDir, STAMP_FILE), 'utf8');
			const parsed = JSON.parse(raw) as { bindingKey?: unknown; branch?: unknown };
			return typeof parsed.bindingKey === 'string' && typeof parsed.branch === 'string'
				? { bindingKey: parsed.bindingKey, branch: parsed.branch }
				: null;
		} catch {
			return null;
		}
	}

	private async writeStamp(
		worktreeDir: string,
		stamp: BindingStamp,
		auth: WorkspaceProvisionSpec['auth']
	): Promise<void> {
		const gitDir = await this.gitDirOf(worktreeDir, auth);
		if (!gitDir) {
			throw new Error('cannot stamp workspace: worktree gitdir did not resolve');
		}
		await fs.writeFile(join(gitDir, STAMP_FILE), JSON.stringify(stamp), 'utf8');
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

async function exists(path: string): Promise<boolean> {
	return fs.access(path).then(
		() => true,
		() => false
	);
}

export default LocalWorkspacePlugin;
