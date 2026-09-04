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
	/**
	 * Multi-repo Task workspaces (self-build slice C). Additional
	 * repositories the run may read and edit, each checked out on the same
	 * Task branch and linked into the primary worktree at
	 * `.mounts/<mountDir>`. Validated by {@link normalizeFleetTaskWorkspaceMounts};
	 * absent or empty means the single-repository workspace of slices A/B.
	 */
	readonly mounts?: readonly FleetTaskWorkspaceMountSpec[];
}

/**
 * One additional repository of a multi-repo Task workspace.
 *
 * The same token-free rules as the primary apply. `mountDir` is the ONE
 * path segment under the primary worktree's `.mounts/` directory the
 * repository is linked at — never a path, never `.git`, never the
 * `.mounts` directory itself.
 */
export interface FleetTaskWorkspaceMountSpec {
	/** Stable platform repository identity (for example `owner/repository`). */
	readonly repositoryId: string;
	/** Token-free HTTPS or SSH clone URL. */
	readonly repoUrl: string;
	/** Short remote branch name the mount's Task branch is cut from. */
	readonly baseRef: string;
	/** Dedicated branch for this Task in THIS repository (same name as the primary's). */
	readonly branch: string;
	/** Single safe path segment the repository is linked at under `.mounts/`. */
	readonly mountDir: string;
	/**
	 * Whether the node commits and pushes changes left in this mount.
	 * `false` is a read-only reference checkout: never committed, never
	 * pushed, no pull request. Defaults to `true`.
	 */
	readonly writable: boolean;
	/** Optional shallow-fetch depth. Defaults to one commit. */
	readonly depth?: number;
}

/** Upper bound on additional repositories per Task workspace. */
export const FLEET_TASK_WORKSPACE_MAX_MOUNTS = 8;

/**
 * Shape of a mount directory name: one segment, 1–64 characters, no path
 * separators, no leading dot (so `.git`, `.mounts` and hidden entries can
 * never be named) and no trailing dot — Windows strips trailing dots, so
 * `api.` and `api` would be the SAME directory on the node's primary
 * platform and two mounts could silently collapse into one link.
 */
export const FLEET_TASK_WORKSPACE_MOUNT_DIR_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9_-])?$/;

const MOUNT_REPOSITORY_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/;
const MOUNT_BRANCH_PATTERN = /^[^\s\0~^:?*[\\]{1,200}$/;
const MOUNT_RESERVED_DIRS = new Set(['.', '..', '.git', '.mounts', 'node_modules']);
/**
 * Windows device names (`CON`, `NUL`, `COM1`…, with or without an extension)
 * cannot be created as directories; the file system reports EINVAL/ENOENT
 * from the symlink call instead of anything naming the field.
 */
const WINDOWS_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * True when `name` can never be a mount directory even though it may match
 * {@link FLEET_TASK_WORKSPACE_MOUNT_DIR_PATTERN}: the Git / fleet layout
 * entries (`.git`, `.mounts`), `node_modules`, and Windows reserved device
 * names. ONE definition, shared by the fleet normalizer, the API DTO and the
 * Task extra-repositories validation so the three gates cannot drift.
 */
export function isReservedMountDir(name: string): boolean {
	const value = typeof name === 'string' ? name.trim().toLowerCase() : '';
	return value.length === 0 || MOUNT_RESERVED_DIRS.has(value) || WINDOWS_DEVICE_NAME_PATTERN.test(value);
}

export class FleetTaskWorkspaceMountError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FleetTaskWorkspaceMountError';
	}
}

/**
 * Validate the `mounts` of a workspace spec arriving off the wire (or
 * assembled by the planner) and return trimmed copies.
 *
 * REFUSES rather than coerces, like the model-execution block: a mount the
 * node cannot honour exactly as written must fail naming the field, because
 * a silently dropped or renamed repository is a run the operator never
 * asked for. `undefined`, `null` and `[]` all mean "no mounts".
 */
export function normalizeFleetTaskWorkspaceMounts(
	raw: unknown,
	primaryRepositoryId: string
): FleetTaskWorkspaceMountSpec[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) {
		throw new FleetTaskWorkspaceMountError('workspace.mounts must be an array');
	}
	if (raw.length > FLEET_TASK_WORKSPACE_MAX_MOUNTS) {
		throw new FleetTaskWorkspaceMountError(
			`workspace.mounts has ${raw.length} entries; the limit is ${FLEET_TASK_WORKSPACE_MAX_MOUNTS}`
		);
	}
	const primary = primaryRepositoryId.trim().toLowerCase();
	const seenDirs = new Set<string>();
	const seenRepositories = new Set<string>();
	return raw.map((entry, index) => {
		const at = `workspace.mounts[${index}]`;
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			throw new FleetTaskWorkspaceMountError(`${at} must be an object`);
		}
		const mount = entry as Record<string, unknown>;
		const repositoryId = requireString(mount.repositoryId, `${at}.repositoryId`);
		if (!MOUNT_REPOSITORY_ID_PATTERN.test(repositoryId) || hasTraversal(repositoryId)) {
			throw new FleetTaskWorkspaceMountError(`${at}.repositoryId is not a valid repository identity`);
		}
		const repoUrl = requireString(mount.repoUrl, `${at}.repoUrl`);
		if (repoUrl.length > 2048 || /[\0\r\n]/.test(repoUrl) || isLocalUrl(repoUrl)) {
			throw new FleetTaskWorkspaceMountError(`${at}.repoUrl must be a remote, token-free clone URL`);
		}
		const baseRef = requireString(mount.baseRef, `${at}.baseRef`);
		const branch = requireString(mount.branch, `${at}.branch`);
		for (const [field, value] of [
			['baseRef', baseRef],
			['branch', branch]
		] as const) {
			if (!MOUNT_BRANCH_PATTERN.test(value) || value.startsWith('-') || value.endsWith('.lock')) {
				throw new FleetTaskWorkspaceMountError(`${at}.${field} is not a valid branch name`);
			}
		}
		const mountDir = requireString(mount.mountDir, `${at}.mountDir`);
		if (!FLEET_TASK_WORKSPACE_MOUNT_DIR_PATTERN.test(mountDir) || isReservedMountDir(mountDir)) {
			throw new FleetTaskWorkspaceMountError(
				`${at}.mountDir must be a single directory name (letters, digits, '.', '_' or '-'; no trailing dot; not '.git', '.mounts', 'node_modules' or a Windows device name)`
			);
		}
		// Windows and macOS file systems are case-insensitive: two mounts
		// that differ only by case would collide on disk.
		const dirKey = mountDir.toLowerCase();
		if (seenDirs.has(dirKey)) {
			throw new FleetTaskWorkspaceMountError(`${at}.mountDir '${mountDir}' is used by another mount`);
		}
		seenDirs.add(dirKey);
		const repositoryKey = repositoryId.toLowerCase();
		if (repositoryKey === primary) {
			throw new FleetTaskWorkspaceMountError(
				`${at}.repositoryId '${repositoryId}' is the primary repository and cannot also be a mount`
			);
		}
		if (seenRepositories.has(repositoryKey)) {
			throw new FleetTaskWorkspaceMountError(`${at}.repositoryId '${repositoryId}' is mounted twice`);
		}
		seenRepositories.add(repositoryKey);
		const writable = mount.writable === undefined ? true : mount.writable;
		if (typeof writable !== 'boolean') {
			throw new FleetTaskWorkspaceMountError(`${at}.writable must be a boolean`);
		}
		const depth = mount.depth;
		if (depth !== undefined && (!Number.isInteger(depth) || (depth as number) < 1 || (depth as number) > 1000)) {
			throw new FleetTaskWorkspaceMountError(`${at}.depth must be an integer from 1 to 1000`);
		}
		return {
			repositoryId,
			repoUrl,
			baseRef,
			branch,
			mountDir,
			writable,
			...(depth === undefined ? {} : { depth: depth as number })
		};
	});
}

function requireString(value: unknown, field: string): string {
	const trimmed = typeof value === 'string' ? value.trim() : '';
	if (!trimmed) {
		throw new FleetTaskWorkspaceMountError(`${field} is required`);
	}
	return trimmed;
}

function hasTraversal(identity: string): boolean {
	return identity.split(/[/:]/).some((segment) => !segment || segment === '.' || segment === '..');
}

function isLocalUrl(url: string): boolean {
	return /^file:/i.test(url) || /^[a-zA-Z]:[\\/]/.test(url) || url.startsWith('/') || url.startsWith('\\');
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
	/** Additional repositories provisioned for this run, in spec order. */
	readonly mounts?: readonly FleetTaskWorkspaceMountDescriptor[];
}

/**
 * One provisioned mount. `path` is the mount's OWN worktree beneath the
 * Fleet root (where Git commands run); `linkPath` is where the primary
 * worktree reaches it (`<primary>/.mounts/<mountDir>`).
 */
export interface FleetTaskWorkspaceMountDescriptor extends Omit<FleetTaskWorkspaceDescriptor, 'mounts'> {
	readonly mountDir: string;
	readonly linkPath: string;
	readonly writable: boolean;
}
