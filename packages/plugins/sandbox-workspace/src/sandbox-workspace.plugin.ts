import type {
	IPlugin,
	IWorkspacePlugin,
	PluginContext,
	PluginCategory,
	PluginHealthCheck,
	JsonSchema,
	WorkspaceProvisionSpec,
	WorkspaceHandle,
	WorkspaceBranchChanges,
	WorkspaceFinalizeOptions,
	WorkspaceFinalizeResult,
	WorkspaceMergeSimulation
} from '@ever-works/plugin';
import { WorkspaceNotProvisionedError } from '@ever-works/plugin';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Binding stamp kept INSIDE .git so it can never be committed. */
const STAMP_FILE = 'ew-workspace.json';

/**
 * A full, lower-case object id — SHA-1 (40) or SHA-256 (64). Nothing symbolic,
 * abbreviated or refspec-shaped reaches `git` as a commit to judge or publish.
 */
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Global options for every git call that decides what a branch would PUBLISH
 * (`branchChanges`, and the commit check it shares with `publishSha`). The run
 * can write this checkout's git dir, and three things there change what git
 * READS for an object id while `git push` still sends the real objects:
 *
 *  - `refs/replace/*` — `git replace <head> <decoy>` makes a diff read the
 *    decoy's tree for `head`. `--no-replace-objects` turns replacement off.
 *  - a forged commit-graph — it records each commit's parents and root tree, so
 *    it could move the merge base or the tree. `core.commitGraph=false` reads
 *    the commit objects themselves.
 *  - grafts — `info/grafts` (or `git replace --graft`) can make an orphan
 *    carrying a workflow an ANCESTOR of the base, which empties the three-dot
 *    diff. `--no-replace-objects` does not cover `info/grafts`; pointing
 *    `GIT_GRAFT_FILE` at a path that does not exist does ({@link literalHistoryEnv}).
 *
 * Measured with git 2.53: each plant, alone, lets a workflow file through a
 * plain diff; with these options the diff lists it, or fails closed with "no
 * merge base".
 */
const LITERAL_HISTORY_ARGS = ['--no-replace-objects', '-c', 'core.commitGraph=false'] as const;

/**
 * `GIT_GRAFT_FILE` at a fresh random path under a directory that is never
 * created: git then reads no graft file at all, and the run cannot plant one
 * at a path it cannot predict.
 */
function literalHistoryEnv(): NodeJS.ProcessEnv {
	return { GIT_GRAFT_FILE: join(tmpdir(), `ew-no-grafts-${randomUUID()}`, 'grafts') };
}

interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Sandbox Workspace — the cloud-default `workspace` provider.
 *
 * Runs plain `git` in an ephemeral job sandbox. Worktree mechanics
 * degenerate away here: every provision is a fresh shallow clone and
 * the REMOTE task branch is the durable identity — a re-run fetches
 * the pushed branch instead of re-cutting it, so nothing is lost when
 * the sandbox evaporates.
 *
 * Auth posture: the checkout's `origin` remote is always TOKEN-FREE.
 * Credentials arrive per-operation in the spec and are injected into
 * the URL of that single command invocation only; they are never
 * written to git config, the stamp file, or the working tree (the
 * checkout runs untrusted repo code). Tokens are scrubbed from every
 * error message before it can propagate into logs.
 */
export class SandboxWorkspacePlugin implements IPlugin, IWorkspacePlugin {
	readonly id = 'sandbox-workspace';
	readonly name = 'Sandbox Workspace';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'utility';
	readonly capabilities: readonly string[] = ['workspace'];
	readonly providerName = 'Sandbox (ephemeral clone)';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			baseDir: {
				type: 'string',
				title: 'Workspace base directory',
				description:
					'Directory workspaces are provisioned under. Defaults to EW_WORKSPACES_DIR or the OS temp dir.',
				'x-hidden': true
			},
			fetchDepth: {
				type: 'number',
				title: 'Fetch depth',
				description: 'Shallow clone depth for the base-ref fetch.',
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

	async onLoad(_context: PluginContext): Promise<void> {
		// Availability is probed lazily on first use — onLoad must stay
		// cheap and never fail registration (the API process loads every
		// plugin; only worker sandboxes actually run git).
	}

	async onUnload(): Promise<void> {
		this.gitAvailable = null;
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
		const dir = join(this.baseDir(spec.settings), sanitizeSegment(spec.bindingKey));
		const depth = Number(spec.settings?.fetchDepth) > 0 ? Number(spec.settings?.fetchDepth) : 1;

		// Binding self-heal: an existing dir bound to a DIFFERENT key is
		// wiped and re-provisioned instead of bricking the workspace.
		const stamp = await this.readStamp(dir);
		if (stamp && stamp.bindingKey !== spec.bindingKey) {
			await fs.rm(dir, { recursive: true, force: true });
		}

		// Refused BEFORE the first `git` call, and before anything is written to
		// disk. The platform validates mount URLs, but the PRIMARY `repoUrl`
		// reaches this plugin unvalidated, and this package is standalone — it
		// cannot import the platform's contracts, and it can be loaded by a host
		// that never ran them. So it decides for itself rather than trusting a
		// caller it cannot see.
		assertRemoteCloneUrl(spec.repoUrl);

		await fs.mkdir(dir, { recursive: true });
		if (!(await exists(join(dir, '.git')))) {
			await this.git(['init', '--initial-branch', 'ew-provision'], dir, spec.auth);
			await this.git(['remote', 'add', 'origin', spec.repoUrl], dir, spec.auth);
		} else {
			// Keep the persisted remote token-free and current.
			await this.git(['remote', 'set-url', 'origin', spec.repoUrl], dir, spec.auth);
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
			dir,
			spec.auth,
			`fetch of base ref '${spec.baseRef}' failed`
		);

		// A previously pushed task branch is the durable identity — reuse
		// it when it exists (re-run / conflict-fix loop).
		const branchFetch = await this.git(
			['fetch', authedUrl, `+refs/heads/${spec.branch}:refs/remotes/origin/${spec.branch}`],
			dir,
			spec.auth
		);
		const reused = branchFetch.code === 0;

		const baseSha = (
			await this.gitOrThrow(
				['rev-parse', `refs/remotes/origin/${spec.baseRef}`],
				dir,
				spec.auth,
				'base ref did not resolve after fetch'
			)
		).stdout.trim();

		const startPoint = reused ? `refs/remotes/origin/${spec.branch}` : `refs/remotes/origin/${spec.baseRef}`;
		await this.gitOrThrow(['checkout', '-B', spec.branch, startPoint], dir, spec.auth, 'branch checkout failed');

		await this.writeStamp(dir, { bindingKey: spec.bindingKey, branch: spec.branch });

		return { path: dir, baseSha, reused, branch: spec.branch, bindingKey: spec.bindingKey };
	}

	async finalize(
		handle: WorkspaceHandle,
		opts: Pick<WorkspaceFinalizeOptions, 'commitMessage' | 'push' | 'auth' | 'publishSha'>
	): Promise<WorkspaceFinalizeResult> {
		await this.ensureGit();
		const dir = handle.path;
		// APW-08 T17 — publish an already-judged commit and nothing else. Checked
		// BEFORE `add -A`: whatever the tree gained after the judgement must not
		// ride along. `!== undefined`, not truthiness, so an empty value is
		// refused rather than read as "commit the tree as usual".
		if (opts.publishSha !== undefined) {
			return this.publishCommit(handle, opts.publishSha, opts);
		}
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
	 * The `publishSha` half of {@link finalize}: push exactly `publishSha` to
	 * the task branch — nothing staged, nothing committed. The sha must be a
	 * full object id that resolves to a commit in this checkout, so a symbolic
	 * name (`HEAD`, a branch) or a refspec can never stand in for the commit a
	 * caller judged.
	 */
	private async publishCommit(
		handle: WorkspaceHandle,
		publishSha: string,
		opts: Pick<WorkspaceFinalizeOptions, 'push' | 'auth'>
	): Promise<WorkspaceFinalizeResult> {
		if (!opts.push) {
			throw new Error(
				'publishSha requires push: true — it publishes an already-committed commit and does nothing else'
			);
		}
		const dir = handle.path;
		const sha = await this.verifiedCommit(dir, publishSha, 'publishSha', opts.auth);
		const changedFiles = await this.countChangedFiles(dir, handle.baseSha, opts.auth, sha);
		const repoUrl = (
			await this.gitOrThrow(['remote', 'get-url', 'origin'], dir, opts.auth, 'origin remote missing')
		).stdout.trim();
		await this.gitOrThrow(
			['push', this.authedUrl(repoUrl, opts.auth), `${sha}:refs/heads/${handle.branch}`],
			dir,
			opts.auth,
			'git push failed'
		);
		return {
			pushed: true,
			headSha: sha,
			empty: false,
			...(changedFiles === null ? {} : { changedFiles })
		};
	}

	/**
	 * What the branch changes at `opts.headSha`, read from git BEFORE anything
	 * is pushed (APW-08 T17's judge-before-push):
	 *
	 *  - `paths` — `git diff --name-only --no-renames --ignore-submodules=none
	 *    -z <baseSha>...<headSha>`. Three dots, so a REUSED branch is judged by
	 *    its own changes and not by whatever landed on the base since it was
	 *    cut (a two-dot diff against the fresh base would name a human's
	 *    workflow edit and refuse the run). `--no-renames`, so a rename names
	 *    both sides — moving a protected file away is a change to it.
	 *    `--ignore-submodules=none`, so neither a committed `.gitmodules`
	 *    `ignore = all` nor a checkout's `diff.ignoreSubmodules` hides a
	 *    gitlink at a protected path.
	 *  - `contents` — each requested path's blob AT `headSha`, or `null` when
	 *    no file is there. From git, never from disk: a gitignored or
	 *    line-ending-converted file on disk is not what would be pushed, and
	 *    the tree can move after the commit.
	 *
	 * Every read here ignores replace refs, grafts and the commit-graph
	 * ({@link LITERAL_HISTORY_ARGS}): the run can write them, and `git push`
	 * ignores them, so honouring them would judge something other than what is
	 * published.
	 *
	 * A depth-1 checkout has no merge base once the base moved, so a failed
	 * diff deepens the history once (`fetch --unshallow`, the same posture as
	 * {@link simulateMerge}) and retries; a second failure throws, and the
	 * caller refuses rather than pushing unjudged.
	 *
	 * NOT covered (recorded, not hidden): merge-base semantics judge a head cut
	 * from an OLD ancestor of the base only by what it changed since that
	 * ancestor. A workflow file the ancestor carried and the base has since
	 * removed can therefore ride along unnamed — as it does in the pull
	 * request's and the post-push compare's view. The contract pins these
	 * semantics; a history-free check would need the protected globs (the
	 * gate's) and a trusted remote tip (not on the handle).
	 */
	async branchChanges(
		handle: WorkspaceHandle,
		opts: { headSha: string; readPaths?: readonly string[] }
	): Promise<WorkspaceBranchChanges> {
		await this.ensureGit();
		const dir = handle.path;
		const readPaths = validatedReadPaths(opts.readPaths);
		const headSha = await this.verifiedCommit(dir, opts.headSha, 'headSha', undefined);
		if (typeof handle.baseSha !== 'string' || !FULL_OBJECT_ID.test(handle.baseSha)) {
			throw new Error('the workspace base is not a full commit id, so the branch cannot be compared with it');
		}

		const diffArgs = [
			'diff',
			'--name-only',
			'--no-renames',
			'--ignore-submodules=none',
			'-z',
			`${handle.baseSha}...${headSha}`
		];
		let diff = await this.gitLiteral(diffArgs, dir, undefined);
		if (diff.code !== 0) {
			const repoUrl = (
				await this.gitOrThrow(['remote', 'get-url', 'origin'], dir, undefined, 'origin remote missing')
			).stdout.trim();
			await this.git(['fetch', this.authedUrl(repoUrl, undefined), '--unshallow'], dir, undefined);
			diff = await this.gitLiteral(diffArgs, dir, undefined);
			if (diff.code !== 0) {
				throw new Error(
					`the branch's changes could not be read: ${diff.stderr.trim() || `git exited ${diff.code}`}`
				);
			}
		}
		const paths = [...new Set(diff.stdout.split('\0').filter((path) => path.length > 0))];

		const contents: Record<string, string | null> = {};
		for (const path of readPaths) {
			contents[path] = await this.blobAt(dir, headSha, path);
		}
		return { paths, contents };
	}

	/**
	 * `value` when it is a full object id naming a COMMIT in this checkout —
	 * the real object, not a replacement ({@link LITERAL_HISTORY_ARGS}); throws
	 * otherwise. The value is echoed only once it is known to be hex.
	 */
	private async verifiedCommit(
		dir: string,
		value: string,
		label: 'headSha' | 'publishSha',
		auth: WorkspaceProvisionSpec['auth']
	): Promise<string> {
		if (typeof value !== 'string' || !FULL_OBJECT_ID.test(value)) {
			throw new Error(`${label} must be a full lower-case commit id (40 or 64 hex characters)`);
		}
		const resolved = await this.gitLiteral(['rev-parse', '--verify', '--quiet', `${value}^{commit}`], dir, auth);
		if (resolved.code !== 0 || resolved.stdout.trim() !== value) {
			throw new Error(`${label} ${value} is not a commit in this workspace`);
		}
		return value;
	}

	/**
	 * The blob at `<sha>:<path>` in the REAL commit (no replace ref, graft or
	 * commit-graph can swap its tree), or null when no FILE is there.
	 */
	private async blobAt(dir: string, sha: string, path: string): Promise<string | null> {
		const object = `${sha}:${path}`;
		const type = await this.gitLiteral(['cat-file', '-t', object], dir, undefined);
		if (type.code !== 0 || type.stdout.trim() !== 'blob') return null;
		const blob = await this.gitLiteral(['cat-file', 'blob', object], dir, undefined);
		if (blob.code !== 0) {
			throw new Error(`reading ${path} failed: ${blob.stderr.trim() || `git exited ${blob.code}`}`);
		}
		return blob.stdout;
	}

	/** {@link git} with replace refs, grafts and the commit-graph ignored — see {@link LITERAL_HISTORY_ARGS}. */
	private gitLiteral(args: string[], cwd: string, auth: WorkspaceProvisionSpec['auth']): Promise<GitResult> {
		return this.git([...LITERAL_HISTORY_ARGS, ...args], cwd, auth, literalHistoryEnv());
	}

	/**
	 * `git diff --name-only <baseSha>..<head>` → distinct changed-file
	 * count for the run-telemetry counter. Returns null when the diff
	 * cannot be taken (unknown base after a shallow fetch, git failure),
	 * so the caller can tell "no data" apart from "zero files".
	 */
	private async countChangedFiles(
		dir: string,
		baseSha: string,
		auth?: WorkspaceProvisionSpec['auth'],
		head = 'HEAD'
	): Promise<number | null> {
		try {
			const diff = await this.git(['diff', '--name-only', `${baseSha}..${head}`], dir, auth);
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
		await fs.rm(handle.path, { recursive: true, force: true, maxRetries: 3 });
	}

	async gc(policy: { olderThanDays: number }): Promise<{ removed: string[] }> {
		const base = this.baseDir(undefined);
		const removed: string[] = [];
		const cutoff = Date.now() - policy.olderThanDays * 24 * 60 * 60 * 1000;
		let entries: string[] = [];
		try {
			entries = await fs.readdir(base);
		} catch {
			return { removed };
		}
		for (const entry of entries) {
			const dir = join(base, entry);
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
		return { removed };
	}

	// ── internals ────────────────────────────────────────────────────

	private baseDir(settings: WorkspaceProvisionSpec['settings']): string {
		const configured = (typeof settings?.baseDir === 'string' && settings.baseDir) || process.env.EW_WORKSPACES_DIR;
		return configured || join(tmpdir(), 'ew-workspaces');
	}

	private async ensureGit(): Promise<void> {
		if (this.gitAvailable === true) return;
		const probe = await this.git(['--version'], undefined, undefined);
		if (probe.code !== 0) {
			this.gitAvailable = false;
			throw new WorkspaceNotProvisionedError(
				'git is not available in this runtime — the sandbox-workspace provider cannot operate.'
			);
		}
		this.gitAvailable = true;
	}

	/** Inject per-operation auth into the URL of ONE command invocation. */
	private authedUrl(repoUrl: string, auth: WorkspaceProvisionSpec['auth']): string {
		// Every remote operation funnels through here, including the ones that
		// read a URL back off a persisted handle rather than the provision spec.
		// Re-checking is cheap and means one missed call site cannot reintroduce
		// the hole.
		assertRemoteCloneUrl(repoUrl);
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
		// Only {@link gitLiteral} passes one.
		extraEnv?: NodeJS.ProcessEnv
	): Promise<GitResult> {
		return new Promise((resolve) => {
			execFile(
				'git',
				args,
				{
					cwd,
					env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
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

	private async readStamp(dir: string): Promise<{ bindingKey: string } | null> {
		try {
			const raw = await fs.readFile(join(dir, '.git', STAMP_FILE), 'utf8');
			const parsed = JSON.parse(raw) as { bindingKey?: unknown };
			return typeof parsed.bindingKey === 'string' ? { bindingKey: parsed.bindingKey } : null;
		} catch {
			return null;
		}
	}

	private async writeStamp(dir: string, stamp: { bindingKey: string; branch: string }): Promise<void> {
		await fs.writeFile(join(dir, '.git', STAMP_FILE), JSON.stringify(stamp), 'utf8');
	}
}

/**
 * Refuse a clone URL that `git` would read as anything other than a remote.
 *
 * Two shapes reach `git` as an ARGUMENT and execute a command on the machine
 * running this plugin — which, for a Fleet node, is somebody's actual PC:
 *
 *   - a value starting with `-`, parsed as an OPTION rather than a repository
 *     (`--upload-pack=<cmd>` runs `<cmd>`);
 *   - `<helper>::<address>`, git's transport-helper syntax, whose `ext::` form
 *     runs its address verbatim.
 *
 * Neither is a local path, so a local-path deny-list does not see them. This is
 * therefore an allow-list, and it is enforced HERE as well as in the platform's
 * contracts: this package is standalone, its primary `repoUrl` is not validated
 * upstream, and a host that loads it need not have run the platform's checks at
 * all. Fail closed.
 */
export function assertRemoteCloneUrl(repoUrl: string): void {
	if (!isSafeCloneArgument(repoUrl)) {
		// The URL is not echoed: it can carry credentials, and a caller that
		// sent one already knows what it sent.
		throw new WorkspaceNotProvisionedError(
			'repoUrl would reach git as an option or a transport helper, not as a repository — the sandbox-workspace provider refuses it.'
		);
	}
}

/**
 * WHAT THIS DOES NOT DECIDE: which remotes a host is willing to clone. That is
 * policy, and it belongs to the host — the platform's own mount rules refuse
 * `file:` and local paths so that a Fleet node cannot clone its own disk, while
 * this package's hermetic tests legitimately use a `file://` origin to run real
 * git without a network. Duplicating the platform's policy here would break
 * that harness and would still not be the platform's policy.
 *
 * What it does decide is narrower and is nobody's policy: a value that git will
 * not treat as a repository AT ALL, because it executes instead.
 */
function isSafeCloneArgument(url: string): boolean {
	// Parsed as an OPTION rather than a repository: `--upload-pack=<cmd>` runs
	// `<cmd>`.
	if (url.startsWith('-')) return false;
	// `<helper>::<address>` is git's transport-helper syntax, and `ext::` runs
	// its address verbatim. Anchored, so an IPv6 host such as
	// `https://[::1]/x.git` is unaffected.
	if (/^[A-Za-z0-9+.-]*::/.test(url)) return false;
	// scp-like SSH (`git@host:owner/repo.git`) is not a parseable URL, so it is
	// judged on its own shape: the host must begin alphanumerically, or
	// `git@-oProxyCommand=…:x` would hand ssh an option in the host position.
	if (/^[A-Za-z0-9._-]+@/.test(url)) {
		return /^[A-Za-z0-9._-]+@[A-Za-z0-9][A-Za-z0-9._-]*:(?![\\/])/.test(url);
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		// Not a URL and not scp-like. git would read it as a path, which is the
		// host's policy to allow or refuse, not an execution vector.
		return true;
	}
	// Same option-in-the-host-position problem, reached through a real URL.
	return !parsed.hostname.startsWith('-');
}

/**
 * The paths `branchChanges` may read: repository-relative, no parent segment,
 * no NUL. They are read as `<sha>:<path>`, so an absolute or `..` path would
 * name nothing the branch could publish.
 */
function validatedReadPaths(readPaths: readonly string[] | undefined): string[] {
	if (readPaths === undefined) return [];
	if (!Array.isArray(readPaths)) throw new Error('readPaths must be a list of repository-relative paths');
	return readPaths.map((path) => {
		if (
			typeof path !== 'string' ||
			path.length === 0 ||
			path.includes('\0') ||
			path.startsWith('/') ||
			path.split('/').some((segment) => segment === '..')
		) {
			throw new Error('readPath must be a repository-relative path with no parent segment');
		}
		return path;
	});
}

function sanitizeSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'workspace';
}

async function exists(path: string): Promise<boolean> {
	return fs.access(path).then(
		() => true,
		() => false
	);
}

export default SandboxWorkspacePlugin;
