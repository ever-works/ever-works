/**
 * Multi-repo Task workspaces (self-build slice C, PR C2) — repositories a
 * Task spans IN ADDITION to its primary Work repository and the run
 * agent's repository attachments.
 *
 * Each entry names a repository connection from the owner's repository
 * registry. On a fleet run it becomes a workspace mount next to the primary
 * worktree (`.mounts/<mountDir>`), on the same Task branch, with its own
 * pull request when it changes. A Task entry wins over an agent attachment
 * for the same repository or mount directory.
 */
export interface TaskExtraRepo {
	/** `RepoConnection.id` from the owner's repository registry. */
	repoConnectionId: string;
	/**
	 * Directory under `.mounts/` the repository is linked at. Omitted or
	 * null = the connection's own mount path (or its name).
	 */
	mountDir?: string | null;
	/** `false` = read-only reference checkout: never committed, no pull request. Default `true`. */
	writable?: boolean;
}

/** Upper bound on extra repositories per Task (matches the fleet mount limit). */
export const TASK_MAX_EXTRA_REPOS = 8;
