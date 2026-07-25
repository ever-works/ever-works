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
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Binding stamp kept INSIDE .git so it can never be committed. */
const STAMP_FILE = 'ew-workspace.json';

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

		const startPoint = reused
			? `refs/remotes/origin/${spec.branch}`
			: `refs/remotes/origin/${spec.baseRef}`;
		await this.gitOrThrow(
			['checkout', '-B', spec.branch, startPoint],
			dir,
			spec.auth,
			'branch checkout failed'
		);

		await this.writeStamp(dir, { bindingKey: spec.bindingKey, branch: spec.branch });

		return { path: dir, baseSha, reused, branch: spec.branch, bindingKey: spec.bindingKey };
	}

	async finalize(
		handle: WorkspaceHandle,
		opts: { commitMessage: string; push: boolean; auth?: WorkspaceProvisionSpec['auth'] }
	): Promise<WorkspaceFinalizeResult> {
		await this.ensureGit();
		const dir = handle.path;
		await this.gitOrThrow(['add', '-A'], dir, opts.auth, 'git add failed');

		const status = await this.gitOrThrow(
			['status', '--porcelain'],
			dir,
			opts.auth,
			'git status failed'
		);
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
				await this.gitOrThrow(
					['remote', 'get-url', 'origin'],
					dir,
					opts.auth,
					'origin remote missing'
				)
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
		const configured =
			(typeof settings?.baseDir === 'string' && settings.baseDir) ||
			process.env.EW_WORKSPACES_DIR;
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
		auth: WorkspaceProvisionSpec['auth']
	): Promise<GitResult> {
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
