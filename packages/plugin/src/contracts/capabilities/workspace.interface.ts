import type { IPlugin } from '../plugin.interface.js';
import type { PluginSettings } from '../../settings/settings.types.js';

/**
 * Workspace capability — pluggable isolated git working contexts for
 * agent-executed Tasks (capability `workspace`).
 *
 * A workspace is where an agent's Task run touches files: its own
 * branch (cut FRESH from `origin/<baseRef>` — never a cached HEAD, the
 * staleness lesson every reference implementation paid for), its own
 * checkout, shipped as a PR, cleaned up afterward. Implementations own
 * WHERE that checkout lives:
 *
 *  - `sandbox-workspace` (cloud default): fresh shallow clone inside
 *    the ephemeral job sandbox — worktree mechanics degenerate away;
 *    the REMOTE BRANCH is the durable identity and re-provisioning
 *    fetches it instead of re-cutting.
 *  - `local-workspace` (local runtime): persistent pool with real
 *    `git worktree add`, per-repo creation serialization, binding
 *    stamps with self-heal, GC.
 *  - later `ssh-workspace`: the founder's own-box runner — same
 *    contract, nothing upstream changes.
 *
 * Auth: the git token is resolved per-operation by the git facade and
 * injected transiently — it must NEVER be persisted into the checkout
 * (remote URLs, files) because the checkout runs untrusted repo code.
 */
export interface WorkspaceProvisionSpec {
	/** Resolved clone URL (token-free; auth injected per operation). */
	readonly repoUrl: string;
	/** Base ref to branch FROM — always fetched fresh before branching. */
	readonly baseRef: string;
	/** Deterministic branch name (`task/<slug>-<id8>`). */
	readonly branch: string;
	/** Binding stamp — `${taskId}`. A mismatch on reuse self-heals by
	 *  re-provisioning instead of bricking the workspace. */
	readonly bindingKey: string;
	/** Shallow clone depth (default 1). */
	readonly depth?: number;
	/** Per-operation auth injected by the facade (short-lived token). */
	readonly auth?: { username?: string; token?: string };
	readonly settings?: PluginSettings;
}

export interface WorkspaceHandle {
	/** Absolute path of the checkout. */
	readonly path: string;
	/** SHA of the fetched base the branch was cut from (or found at). */
	readonly baseSha: string;
	/** True when an existing workspace/branch was reused (re-run). */
	readonly reused: boolean;
	readonly branch: string;
	readonly bindingKey: string;
}

export interface WorkspaceFinalizeResult {
	pushed: boolean;
	headSha: string | null;
	/** True when there was nothing to commit (clean tree). */
	empty: boolean;
}

export interface WorkspaceMergeSimulation {
	clean: boolean;
	/** Conflicting paths, NAMED — "you are never handed a PR with a red
	 *  merge banner"; empty when clean. */
	conflictPaths: string[];
}

/**
 * Thrown when the provider cannot operate in this runtime (no git, no
 * disk, unreachable host). Matched BY NAME across packages; maps to a
 * loud, actionable failure — never a silent no-op.
 */
export class WorkspaceNotProvisionedError extends Error {
	constructor(message?: string) {
		super(message ?? 'Workspace provider is not provisioned in this runtime.');
		this.name = 'WorkspaceNotProvisionedError';
	}
}

/** Workspace plugin interface — capability `workspace`. */
export interface IWorkspacePlugin extends IPlugin {
	readonly providerName: string;

	/** Fetch-first provision: clone/fetch, cut or reuse the branch. */
	provision(spec: WorkspaceProvisionSpec): Promise<WorkspaceHandle>;

	/** Commit everything + optionally push the branch. */
	finalize(
		handle: WorkspaceHandle,
		opts: { commitMessage: string; push: boolean; auth?: WorkspaceProvisionSpec['auth'] }
	): Promise<WorkspaceFinalizeResult>;

	/**
	 * In-memory merge of the branch against a FRESH targetRef. On
	 * conflict the caller refuses the push/PR and names the paths.
	 */
	simulateMerge(
		handle: WorkspaceHandle,
		targetRef: string,
		auth?: WorkspaceProvisionSpec['auth']
	): Promise<WorkspaceMergeSimulation>;

	/** Route EVERY delete through here (kill processes → remove). */
	teardown(handle: WorkspaceHandle): Promise<void>;

	/** Reclaim stale workspaces (startup/cron reconcile). */
	gc?(policy: { olderThanDays: number }): Promise<{ removed: string[] }>;
}

/** Facade interface — implementation lives in `@ever-works/agent`. */
export interface IWorkspaceFacade {
	provision(spec: Omit<WorkspaceProvisionSpec, 'settings'>, facadeOptions: unknown): Promise<WorkspaceHandle>;
	finalize(
		handle: WorkspaceHandle,
		opts: { commitMessage: string; push: boolean },
		facadeOptions: unknown
	): Promise<WorkspaceFinalizeResult>;
	simulateMerge(
		handle: WorkspaceHandle,
		targetRef: string,
		facadeOptions: unknown
	): Promise<WorkspaceMergeSimulation>;
	teardown(handle: WorkspaceHandle, facadeOptions: unknown): Promise<void>;
}

/** Type guard — true when a plugin declares the `workspace` capability. */
export function isWorkspacePlugin(plugin: IPlugin): plugin is IWorkspacePlugin {
	return plugin.capabilities.includes('workspace');
}
