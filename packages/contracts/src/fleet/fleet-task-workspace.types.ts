/**
 * Repository metadata a Fleet node needs to provision one Task-owned Git
 * workspace. Clone URLs are deliberately token-free: node-local Git
 * credential helpers authenticate fetches without putting a secret on the
 * Fleet job wire or in persisted Git configuration.
 */
export interface FleetTaskWorkspaceSpec {
	/** Stable platform repository identity (for example `owner/repository`). */
	readonly repositoryId: string;
	/** Token-free HTTPS or SSH clone URL. */
	readonly repoUrl: string;
	/** Short remote branch name fetched fresh before the task branch is resolved. */
	readonly baseRef: string;
	/** Dedicated remote/local branch for this Task. */
	readonly branch: string;
	/** Optional shallow-fetch depth. Defaults to one commit. */
	readonly depth?: number;
}

/**
 * Validated, local-only workspace metadata returned by a Fleet node.
 *
 * The absolute path is safe to pass as `cwd` to the later model executor; no
 * field is a shell fragment and no field contains Git credentials.
 */
export interface FleetTaskWorkspaceDescriptor {
	/** Absolute, canonical path beneath the configured Fleet worktree root. */
	readonly path: string;
	readonly repositoryId: string;
	readonly baseRef: string;
	readonly branch: string;
	/** Commit fetched for `baseRef` during this provisioning attempt. */
	readonly baseSha: string;
	/** Commit currently checked out in the task worktree. */
	readonly headSha: string;
	/** True when the same healthy task binding was reused. */
	readonly reused: boolean;
}
