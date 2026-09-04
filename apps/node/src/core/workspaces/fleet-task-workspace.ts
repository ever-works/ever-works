import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, posix, relative, resolve, win32 } from 'node:path';
import {
	FLEET_AGENT_TASK_META_DIR,
	normalizeFleetTaskWorkspaceMounts,
	type FleetTaskWorkspaceDescriptor,
	type FleetTaskWorkspaceMountDescriptor,
	type FleetTaskWorkspaceMountSpec,
	type FleetTaskWorkspaceSpec
} from '@ever-works/contracts';
import { execFileWithVerifiedCancellation, LocalWorkspacePlugin } from '@ever-works/local-workspace-plugin';
import type { IWorkspacePlugin, WorkspaceHandle } from '@ever-works/plugin';

export type FleetTaskWorkspaceErrorCode =
	| 'invalid-root'
	| 'invalid-spec'
	| 'cancelled'
	| 'provision-failed'
	| 'path-collision'
	| 'git-failed';

/** Stable, non-secret failure surface suitable for Fleet job diagnostics. */
export class FleetTaskWorkspaceError extends Error {
	constructor(
		readonly code: FleetTaskWorkspaceErrorCode,
		message: string
	) {
		super(message);
		this.name = 'FleetTaskWorkspaceError';
	}
}

/**
 * Narrow structural seam used by focused tests and alternative local
 * providers. `finalize` is optional so every existing provision-only
 * double keeps compiling; a node whose provider lacks it cannot commit
 * (and says so in the job result) rather than failing to construct.
 */
export type FleetWorkspacePlugin = Pick<IWorkspacePlugin, 'provision'> & Partial<Pick<IWorkspacePlugin, 'finalize'>>;

/** What {@link FleetTaskWorkspaceProvisioner.finalize} reports back to the executor. */
export interface FleetTaskWorkspaceFinalizeResult {
	pushed: boolean;
	headSha: string | null;
	empty: boolean;
	changedFiles?: number;
}

/**
 * Multi-repo Task workspaces (self-build slice C): the verdict of one
 * writable mount's commit + push. `error` is set instead of thrown so the
 * remaining mounts (and the primary) still get their turn.
 */
export interface FleetTaskWorkspaceMountFinalizeResult extends Partial<FleetTaskWorkspaceFinalizeResult> {
	repositoryId: string;
	mountDir: string;
	branch: string;
	baseSha: string;
	pushed: boolean;
	headSha: string | null;
	empty: boolean;
	error?: string;
}

/** Directory under the primary worktree the mounts are linked into. */
export const FLEET_TASK_WORKSPACE_MOUNTS_DIR = '.mounts';

/**
 * Paths the fleet keeps out of EVERY Task repository's Git view: the mounts
 * link directory (slice C) and the owner-question directory (slice Q).
 * Written to the shared `info/exclude` of each repository the workspace
 * touches — primary and mounts alike.
 *
 * `/.mounts/` is anchored at the worktree root on purpose: a nested
 * `.mounts` directory is the owner's own. The owner-question directory is
 * listed twice — anchored, where the OUTPUT CONTRACT tells the model to
 * write it, and UNANCHORED (review SR-5): a model that `cd`-ed into a
 * package of a monorepo and wrote `.ever-works/QUESTION.md` relative to
 * its cwd would otherwise hand the finalize's `git add -A` a
 * `packages/api/.ever-works/QUESTION.md` that is committed, pushed into
 * the pull request, and never reported as a question. Git matches an
 * unanchored `dir/` pattern at any depth, so the second rule is the
 * safety net the first one promises.
 */
export const FLEET_TASK_WORKSPACE_EXCLUDE_RULES: readonly string[] = [
	`/${FLEET_TASK_WORKSPACE_MOUNTS_DIR}/`,
	`/${FLEET_AGENT_TASK_META_DIR}/`,
	`${FLEET_AGENT_TASK_META_DIR}/`
];

/**
 * One path per exclude rule, in rule order, proven ignored through Git
 * after the rules are written (`ensureFleetExcluded`). Slash-terminated so
 * Git evaluates each as a directory whether or not it exists yet; the
 * nested probe is what proves the unanchored rule.
 */
const FLEET_TASK_WORKSPACE_EXCLUDE_PROBES: readonly string[] = [
	`${FLEET_TASK_WORKSPACE_MOUNTS_DIR}/`,
	`${FLEET_AGENT_TASK_META_DIR}/`,
	`nested/${FLEET_AGENT_TASK_META_DIR}/`
];

export interface FleetTaskWorkspaceProvisionerOptions {
	/** Persistent cache/worktree root owned by the node service account. */
	readonly rootPath: string;
	readonly plugin?: FleetWorkspacePlugin;
	/** Test seam; production always resolves HEAD with shell-free `execFile`. */
	readonly inspectHead?: (workspacePath: string, signal?: AbortSignal) => Promise<string>;
}

const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const IDENTITY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/;

/**
 * Stable default for unattended nodes. The Windows service account therefore
 * owns both the Git credential helper and the workspace tree. Operators can
 * place it on a larger volume without changing job payloads.
 */
export function defaultFleetTaskWorkspaceRoot(
	env: Readonly<Record<string, string | undefined>> = process.env,
	homePath: string = homedir()
): string {
	const configured = (env.EVER_WORKS_NODE_WORKSPACE_ROOT ?? env.EW_WORKSPACES_DIR ?? '').trim();
	return configured || join(homePath, '.ever-works', 'fleet-workspaces');
}

/**
 * Fleet adapter over the existing local-workspace capability.
 *
 * The plugin continues to own the bare repository cache, fetch-first branch
 * resolution, per-repository mutex, binding stamps, and stale-worktree
 * self-heal. This adapter owns the untrusted wire boundary: strict metadata
 * validation, deterministic short task bindings, root confinement,
 * cancellation checks, and a typed descriptor for the later model executor.
 */
export class FleetTaskWorkspaceProvisioner {
	private readonly rootPath: string;
	private readonly plugin: FleetWorkspacePlugin;
	private readonly inspectHead: (workspacePath: string, signal?: AbortSignal) => Promise<string>;

	constructor(options: FleetTaskWorkspaceProvisionerOptions) {
		this.rootPath = validateRootPath(options.rootPath);
		this.plugin = options.plugin ?? new LocalWorkspacePlugin();
		this.inspectHead = options.inspectHead ?? inspectGitHead;
	}

	async provision(
		taskId: string,
		rawSpec: FleetTaskWorkspaceSpec,
		signal?: AbortSignal
	): Promise<FleetTaskWorkspaceDescriptor> {
		const normalizedTaskId = validateTaskId(taskId);
		const spec = validateWorkspaceSpec(rawSpec);
		const primary = await this.provisionOne(normalizedTaskId, spec, signal);
		const mountSpecs = spec.mounts ?? [];
		throwIfCancelled(signal);
		// The primary worktree persists across runs, so `.mounts/` is
		// reconciled on EVERY provision — a run without mounts included: a
		// link left behind by an earlier spec would otherwise keep a repository
		// the operator has since removed reachable (and editable) by the model.
		const mountsDir = await reconcileMountsDir(primary.path, mountSpecs);
		if (mountSpecs.length === 0) {
			// Unconditional since slice Q: even a single-repository workspace
			// may receive an owner-question file, and a forgotten one must
			// never reach the finalize's `git add -A`.
			await ensureFleetExcluded(primary.path, signal);
			return primary;
		}

		// Multi-repo Task workspaces (self-build slice C). Every mount is an
		// ordinary binding of its OWN repository under the fleet root — same
		// pool, same reuse, same ownership proof as the primary — and is then
		// linked into the primary worktree at `.mounts/<mountDir>` so the model
		// reaches it by a relative path from its cwd. `.mounts/` is excluded
		// from the primary's Git so the link never shows up as an untracked
		// entry, is never committed, and never confuses the primary's diff.
		const mounts: FleetTaskWorkspaceMountDescriptor[] = [];
		for (const mount of mountSpecs) {
			throwIfCancelled(signal);
			// Re-validated with the NODE's stricter URL / ref rules, exactly like
			// the primary (the contracts normalizer only checks shape).
			const mountSpec = validateWorkspaceSpec({
				repositoryId: mount.repositoryId,
				repoUrl: mount.repoUrl,
				baseRef: mount.baseRef,
				branch: mount.branch,
				...(mount.depth === undefined ? {} : { depth: mount.depth })
			});
			let provisioned: FleetTaskWorkspaceDescriptor;
			try {
				provisioned = await this.provisionOne(normalizedTaskId, mountSpec, signal);
				// A read-only mount is a pristine reference by contract. The
				// binding is reused in place without a reset, so whatever a
				// model left in it would survive into the next run — and be
				// committed by the first run after `writable` flips to true.
				if (!mount.writable && provisioned.reused) {
					await resetReadOnlyMount(provisioned.path, signal);
				}
			} catch (error) {
				if (error instanceof FleetTaskWorkspaceError && error.code !== 'cancelled') {
					throw new FleetTaskWorkspaceError(
						error.code,
						`mount '${mount.mountDir}' (${mount.repositoryId}): ${error.message}`
					);
				}
				throw error;
			}
			// The mount is a repository of its own: a question file the model
			// writes while working under `.mounts/<dir>` must stay out of THAT
			// repository's Git too (the node scans writable mounts for it).
			await ensureFleetExcluded(provisioned.path, signal);
			const linkPath = await linkMountIntoPrimary(mountsDir, mount.mountDir, provisioned.path);
			mounts.push({ ...provisioned, mountDir: mount.mountDir, linkPath, writable: mount.writable });
		}
		throwIfCancelled(signal);
		await ensureFleetExcluded(primary.path, signal);
		return { ...primary, mounts };
	}

	/** One repository binding — the slice A/B provision, unchanged. */
	private async provisionOne(
		normalizedTaskId: string,
		spec: FleetTaskWorkspaceSpec,
		signal?: AbortSignal
	): Promise<FleetTaskWorkspaceDescriptor> {
		throwIfCancelled(signal);

		// A hash keeps Windows paths short and prevents two repositories with
		// the same Task id from sharing a worktree directory.
		const bindingKey = taskBindingKey(normalizedTaskId, spec.repositoryId);
		// Namespace the existing local-workspace pool by the FULL stable
		// repository identity + token-free remote. Its own human-readable URL
		// key is intentionally short; the outer digest prevents two long,
		// similarly-prefixed remotes from ever sharing refs or worktrees.
		const repositoryRoot = resolve(this.rootPath, 'repositories', repositoryCacheKey(spec));
		const expectedPath = resolve(repositoryRoot, 'worktrees', bindingKey);
		await prepareRepositoryRoot(this.rootPath, repositoryRoot);
		throwIfCancelled(signal);
		await assertExistingWorkspacePathSafe(expectedPath, repositoryRoot, signal);

		let handle: WorkspaceHandle;
		try {
			handle = await this.plugin.provision({
				repositoryId: spec.repositoryId,
				repoUrl: spec.repoUrl,
				baseRef: spec.baseRef,
				branch: spec.branch,
				bindingKey,
				...(signal ? { signal } : {}),
				settings: {
					baseDir: repositoryRoot,
					...(spec.depth === undefined ? {} : { fetchDepth: spec.depth })
				}
			});
		} catch (error) {
			if (error instanceof Error && error.name === 'ProcessTreeTerminationError') throw error;
			if (signal?.aborted) throw cancelledError();
			if (error instanceof Error && error.name === 'WorkspaceOwnershipError') {
				throw new FleetTaskWorkspaceError(
					'path-collision',
					'Existing task workspace did not pass the provider ownership proof and was preserved'
				);
			}
			throw new FleetTaskWorkspaceError(
				'provision-failed',
				`Git fetch or workspace provisioning failed for repository '${spec.repositoryId}' at '${spec.baseRef}'`
			);
		}

		// If cancellation races the Git operation, keep the deterministic
		// task-owned checkout in place for an idempotent retry. Never delete it
		// from an abort path that cannot prove ownership beyond the plugin stamp.
		throwIfCancelled(signal);
		if (!handle || typeof handle !== 'object') {
			throw new FleetTaskWorkspaceError('provision-failed', 'Workspace provider returned no task binding');
		}
		assertPluginBinding(handle, expectedPath, bindingKey, spec.branch, this.rootPath);

		let canonicalRoot: string;
		let canonicalPath: string;
		try {
			const lexicalStats = await fs.lstat(handle.path);
			if (lexicalStats.isSymbolicLink() || !lexicalStats.isDirectory()) {
				throw new Error('link, reparse point, or non-directory');
			}
			[canonicalRoot, canonicalPath] = await Promise.all([fs.realpath(this.rootPath), fs.realpath(handle.path)]);
		} catch {
			throw new FleetTaskWorkspaceError('path-collision', 'Provisioned workspace did not resolve to a directory');
		}
		if (!isStrictDescendant(canonicalRoot, canonicalPath)) {
			throw new FleetTaskWorkspaceError('path-collision', 'Provisioned workspace escapes the configured root');
		}
		if (!samePath(canonicalPath, expectedPath)) {
			throw new FleetTaskWorkspaceError(
				'path-collision',
				'Provisioned workspace resolves through a link or reparse-point alias'
			);
		}

		throwIfCancelled(signal);
		let headSha: string;
		try {
			headSha = (await this.inspectHead(canonicalPath, signal)).trim();
		} catch (error) {
			if (error instanceof Error && error.name === 'ProcessTreeTerminationError') throw error;
			if (signal?.aborted) throw cancelledError();
			throw new FleetTaskWorkspaceError('git-failed', 'Provisioned workspace HEAD could not be resolved');
		}
		throwIfCancelled(signal);

		if (!SHA_PATTERN.test(handle.baseSha) || !SHA_PATTERN.test(headSha)) {
			throw new FleetTaskWorkspaceError('git-failed', 'Provisioned workspace returned invalid commit metadata');
		}

		return {
			path: canonicalPath,
			repositoryId: spec.repositoryId,
			baseRef: spec.baseRef,
			branch: spec.branch,
			baseSha: handle.baseSha,
			headSha,
			reused: handle.reused
		};
	}

	/**
	 * Commit whatever the model left in the task worktree and push the
	 * task branch (agent execution v2).
	 *
	 * Delegates to the local-workspace provider's own `finalize` — the
	 * same `git add -A` / commit / `push HEAD:refs/heads/<branch>` the
	 * cloud worker runs — so a node-pushed branch is indistinguishable
	 * from a cloud-pushed one. The push is token-free: the node's own Git
	 * credential helper authenticates, exactly as the fetch did.
	 *
	 * The descriptor is re-validated against the configured root before
	 * any Git command runs, so a job cannot point this at a directory the
	 * provisioner did not create.
	 */
	async finalize(
		taskId: string,
		descriptor: FleetTaskWorkspaceDescriptor,
		opts: { commitMessage: string; push: boolean },
		signal?: AbortSignal
	): Promise<FleetTaskWorkspaceFinalizeResult> {
		if (!this.plugin.finalize) {
			throw new FleetTaskWorkspaceError(
				'git-failed',
				'Workspace provider cannot finalize (no commit/push support)'
			);
		}
		throwIfCancelled(signal);
		const normalizedTaskId = validateTaskId(taskId);
		const repositoryId = typeof descriptor?.repositoryId === 'string' ? descriptor.repositoryId.trim() : '';
		if (!IDENTITY_PATTERN.test(repositoryId)) {
			throw new FleetTaskWorkspaceError('invalid-spec', 'Fleet workspace repository identity is invalid');
		}
		const branch = validateBranchRef(descriptor.branch, 'branch');
		if (!SHA_PATTERN.test(descriptor.baseSha)) {
			throw new FleetTaskWorkspaceError('invalid-spec', 'Fleet workspace base commit is invalid');
		}
		const commitMessage = typeof opts.commitMessage === 'string' ? opts.commitMessage.trim() : '';
		if (!commitMessage || /[\0\r]/.test(commitMessage) || commitMessage.length > 1000) {
			throw new FleetTaskWorkspaceError('invalid-spec', 'Commit message is missing or invalid');
		}

		let canonicalRoot: string;
		let canonicalPath: string;
		try {
			[canonicalRoot, canonicalPath] = await Promise.all([
				fs.realpath(this.rootPath),
				fs.realpath(descriptor.path)
			]);
		} catch {
			throw new FleetTaskWorkspaceError('path-collision', 'Task workspace no longer resolves to a directory');
		}
		if (!isStrictDescendant(canonicalRoot, canonicalPath)) {
			throw new FleetTaskWorkspaceError('path-collision', 'Task workspace escapes the configured root');
		}
		throwIfCancelled(signal);

		const bindingKey = taskBindingKey(normalizedTaskId, repositoryId);
		try {
			const result = await this.plugin.finalize(
				{
					path: canonicalPath,
					baseSha: descriptor.baseSha,
					reused: descriptor.reused,
					branch,
					bindingKey
				},
				// The signal rides into every Git call the provider makes, so a
				// lease lost mid-push cannot leave the branch pushed behind the
				// cancelled run's back.
				{ commitMessage, push: opts.push, ...(signal ? { signal } : {}) }
			);
			return {
				pushed: result.pushed,
				headSha: result.headSha,
				empty: result.empty,
				...(result.changedFiles === undefined ? {} : { changedFiles: result.changedFiles })
			};
		} catch (error) {
			if (error instanceof Error && error.name === 'ProcessTreeTerminationError') throw error;
			if (signal?.aborted) throw cancelledError();
			throw new FleetTaskWorkspaceError(
				'git-failed',
				`Commit or push failed for branch '${branch}': ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
	/**
	 * Multi-repo Task workspaces (self-build slice C): commit + push every
	 * WRITABLE mount the model may have changed, one verdict per mount.
	 *
	 * A failure in one mount is recorded on its entry and does not stop the
	 * others: they are independent branches in independent repositories, and
	 * a branch already pushed is never rolled back. Cancellation is the one
	 * exception — it propagates, exactly as for the primary.
	 */
	async finalizeMounts(
		taskId: string,
		descriptor: FleetTaskWorkspaceDescriptor,
		opts: { commitMessage: string; push: boolean },
		signal?: AbortSignal
	): Promise<FleetTaskWorkspaceMountFinalizeResult[]> {
		const results: FleetTaskWorkspaceMountFinalizeResult[] = [];
		for (const mount of descriptor.mounts ?? []) {
			if (!mount.writable) continue;
			throwIfCancelled(signal);
			const base = {
				repositoryId: mount.repositoryId,
				mountDir: mount.mountDir,
				branch: mount.branch,
				baseSha: mount.baseSha
			};
			try {
				const finalized = await this.finalize(taskId, mount, opts, signal);
				results.push({ ...base, ...finalized });
			} catch (error) {
				if (error instanceof FleetTaskWorkspaceError && error.code === 'cancelled') throw error;
				if (error instanceof Error && error.name === 'ProcessTreeTerminationError') throw error;
				results.push({
					...base,
					pushed: false,
					headSha: null,
					empty: false,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		}
		return results;
	}
}

function validateRootPath(raw: string): string {
	const value = typeof raw === 'string' ? raw.trim() : '';
	if (!value || !isAbsolute(value)) {
		throw new FleetTaskWorkspaceError('invalid-root', 'Fleet workspace root must be an absolute path');
	}
	const normalized = resolve(value);
	if (normalized === parse(normalized).root) {
		throw new FleetTaskWorkspaceError('invalid-root', 'Fleet workspace root cannot be a filesystem root');
	}
	return normalized;
}

function validateTaskId(raw: string): string {
	const value = typeof raw === 'string' ? raw.trim() : '';
	if (!TASK_ID_PATTERN.test(value) || isCrossPlatformAbsolute(value)) {
		throw new FleetTaskWorkspaceError('invalid-spec', 'Fleet workspace task id is invalid');
	}
	return value;
}

function validateWorkspaceSpec(raw: FleetTaskWorkspaceSpec): FleetTaskWorkspaceSpec {
	if (!raw || typeof raw !== 'object') {
		throw new FleetTaskWorkspaceError('invalid-spec', 'Fleet workspace repository metadata is missing');
	}
	const repositoryId = typeof raw.repositoryId === 'string' ? raw.repositoryId.trim() : '';
	if (!IDENTITY_PATTERN.test(repositoryId) || isCrossPlatformAbsolute(repositoryId)) {
		throw new FleetTaskWorkspaceError('invalid-spec', 'Fleet workspace repository identity is invalid');
	}
	const identitySegments = repositoryId.split(/[/:]/);
	if (identitySegments.some((segment) => !segment || segment === '.' || segment === '..')) {
		throw new FleetTaskWorkspaceError('invalid-spec', 'Fleet workspace repository identity contains traversal');
	}

	const repoUrl = validateRemoteUrl(raw.repoUrl);
	const baseRef = validateBranchRef(raw.baseRef, 'baseRef');
	const branch = validateBranchRef(raw.branch, 'branch');
	const depth = raw.depth;
	if (depth !== undefined && (!Number.isInteger(depth) || depth < 1 || depth > 1000)) {
		throw new FleetTaskWorkspaceError('invalid-spec', 'Fleet workspace depth must be an integer from 1 to 1000');
	}
	let mounts: FleetTaskWorkspaceMountSpec[];
	try {
		mounts = normalizeFleetTaskWorkspaceMounts(raw.mounts, repositoryId);
	} catch (error) {
		throw new FleetTaskWorkspaceError('invalid-spec', error instanceof Error ? error.message : String(error));
	}
	return {
		repositoryId,
		repoUrl,
		baseRef,
		branch,
		...(depth === undefined ? {} : { depth }),
		...(mounts.length > 0 ? { mounts } : {})
	};
}

function validateRemoteUrl(raw: string): string {
	const value = typeof raw === 'string' ? raw.trim() : '';
	if (!value || value.length > 2048 || /[\0\r\n]/.test(value) || value !== raw) {
		throw new FleetTaskWorkspaceError('invalid-spec', 'Fleet workspace clone URL is invalid');
	}
	if (isWindowsLocalPath(value) || isCrossPlatformAbsolute(value) || value.startsWith('file:')) {
		throw new FleetTaskWorkspaceError('invalid-spec', 'Local filesystem clone URLs are not supported');
	}
	if (remoteUrlContainsTraversal(value)) {
		throw new FleetTaskWorkspaceError('invalid-spec', 'Fleet workspace clone URL path contains traversal');
	}

	// Common Git SSH syntax (`git@host:owner/repository.git`). It is an
	// argv value, never a shell fragment, and all option/control characters
	// are excluded here before the local-workspace plugin receives it.
	const scpLike = /^(?:([a-zA-Z0-9._-]+)@)?([a-zA-Z0-9.-]+):([a-zA-Z0-9][a-zA-Z0-9._~/-]*)$/.exec(value);
	if (scpLike) {
		validateRemotePath(scpLike[3]);
		return value;
	}

	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new FleetTaskWorkspaceError('invalid-spec', 'Fleet workspace clone URL is unsupported');
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') {
		throw new FleetTaskWorkspaceError('invalid-spec', 'Fleet workspace clone URL must use HTTPS or SSH');
	}
	if (!parsed.hostname || parsed.password || parsed.search || parsed.hash) {
		throw new FleetTaskWorkspaceError(
			'invalid-spec',
			'Fleet workspace clone URL cannot contain credentials or query data'
		);
	}
	if (parsed.protocol === 'https:' && parsed.username) {
		throw new FleetTaskWorkspaceError('invalid-spec', 'Fleet workspace HTTPS clone URL cannot contain credentials');
	}
	if (parsed.username && !/^[a-zA-Z0-9._-]+$/.test(parsed.username)) {
		throw new FleetTaskWorkspaceError('invalid-spec', 'Fleet workspace SSH username is invalid');
	}
	let remotePath: string;
	try {
		remotePath = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
	} catch {
		throw new FleetTaskWorkspaceError('invalid-spec', 'Fleet workspace clone URL path is invalid');
	}
	validateRemotePath(remotePath);
	return value;
}

function validateRemotePath(value: string): void {
	const segments = value.split('/');
	if (
		!value ||
		value.includes('\\') ||
		segments.some((segment) => !segment || segment === '.' || segment === '..') ||
		/[\0-\x20\x7f~^:?*\[]/.test(value)
	) {
		throw new FleetTaskWorkspaceError('invalid-spec', 'Fleet workspace clone URL path is invalid');
	}
}

/** A strict subset of `git check-ref-format --branch`, kept shell-free. */
function validateBranchRef(raw: string, field: 'baseRef' | 'branch'): string {
	const value = typeof raw === 'string' ? raw.trim() : '';
	const segments = value.split('/');
	if (
		!value ||
		value !== raw ||
		value.length > 240 ||
		value === '@' ||
		value.startsWith('-') ||
		value.startsWith('/') ||
		value.endsWith('/') ||
		value.endsWith('.') ||
		value.startsWith('refs/') ||
		value.includes('..') ||
		value.includes('@{') ||
		value.includes('//') ||
		/[\0-\x20\x7f~^:?*\[\\]/.test(value) ||
		segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.endsWith('.lock'))
	) {
		throw new FleetTaskWorkspaceError('invalid-spec', `Fleet workspace ${field} is not a supported branch name`);
	}
	return value;
}

function taskBindingKey(taskId: string, repositoryId: string): string {
	const digest = createHash('sha256').update(repositoryId).update('\0').update(taskId).digest('hex').slice(0, 32);
	return `fleet-${digest}`;
}

function repositoryCacheKey(spec: FleetTaskWorkspaceSpec): string {
	return createHash('sha256').update(spec.repositoryId).update('\0').update(spec.repoUrl).digest('hex').slice(0, 32);
}

function remoteUrlContainsTraversal(value: string): boolean {
	const schemeIndex = value.indexOf('://');
	if (schemeIndex < 0) return false;
	const pathIndex = value.indexOf('/', schemeIndex + 3);
	if (pathIndex < 0) return false;
	return value
		.slice(pathIndex + 1)
		.split('/')
		.some((rawSegment) => {
			try {
				const segment = decodeURIComponent(rawSegment);
				return segment === '.' || segment === '..';
			} catch {
				return true;
			}
		});
}

function assertPluginBinding(
	handle: WorkspaceHandle,
	expectedPath: string,
	bindingKey: string,
	branch: string,
	rootPath: string
): void {
	const actualPath = resolve(handle.path);
	if (
		!samePath(actualPath, expectedPath) ||
		!isStrictDescendant(rootPath, actualPath) ||
		handle.bindingKey !== bindingKey ||
		handle.branch !== branch
	) {
		throw new FleetTaskWorkspaceError('path-collision', 'Workspace provider returned a foreign task binding');
	}
}

/**
 * Create the cache hierarchy one component at a time with owner-only POSIX
 * permissions, refusing pre-existing symlinks/junctions before Git can write
 * through them. On Windows the service-account profile supplies the ACL; the
 * lstat + realpath checks still reject reparse-point escapes.
 */
async function prepareRepositoryRoot(rootPath: string, repositoryRoot: string): Promise<void> {
	try {
		const canonicalRoot = await ensurePlainConfiguredRoot(rootPath);
		if (canonicalRoot === parse(canonicalRoot).root) {
			throw new FleetTaskWorkspaceError('invalid-root', 'Fleet workspace root resolves to a filesystem root');
		}
		const repositoriesRoot = join(rootPath, 'repositories');
		await ensureSafeDirectory(repositoriesRoot, canonicalRoot);
		const canonicalRepositoryRoot = await ensureSafeDirectory(repositoryRoot, canonicalRoot);
		const reposRoot = join(repositoryRoot, 'repos');
		await ensureSafeDirectory(reposRoot, canonicalRepositoryRoot);
		await ensureSafeDirectory(join(repositoryRoot, 'worktrees'), canonicalRepositoryRoot);

		// The outer digest means one local-workspace bare pool is expected.
		// Refuse a tampered junction/file entry instead of letting `git init`
		// or `remote set-url` operate outside this repository namespace.
		for (const entry of await fs.readdir(reposRoot, { withFileTypes: true })) {
			const entryPath = join(reposRoot, entry.name);
			if (entry.isSymbolicLink() || !entry.isDirectory()) {
				throw new Error('unsafe repository pool entry');
			}
			const canonicalEntry = await fs.realpath(entryPath);
			if (!isStrictDescendant(canonicalRepositoryRoot, canonicalEntry) || !samePath(canonicalEntry, entryPath)) {
				throw new Error('repository pool escape');
			}
		}
	} catch (error) {
		if (error instanceof FleetTaskWorkspaceError) throw error;
		throw new FleetTaskWorkspaceError(
			'path-collision',
			'Fleet repository cache contains an unsafe path and was preserved'
		);
	}
}

/**
 * Validate the nearest existing ancestor without following links, then create
 * the configured root and prove its lexical and canonical paths are exact.
 * This runs before any cache child or Git process can write through the root.
 */
async function ensurePlainConfiguredRoot(rootPath: string): Promise<string> {
	let existing = rootPath;
	while (true) {
		try {
			const stats = await fs.lstat(existing);
			if (stats.isSymbolicLink() || !stats.isDirectory()) {
				throw new FleetTaskWorkspaceError(
					'invalid-root',
					'Fleet workspace root or its nearest existing ancestor is not a plain directory'
				);
			}
			const canonicalExisting = await fs.realpath(existing);
			if (!samePath(canonicalExisting, existing)) {
				throw new FleetTaskWorkspaceError(
					'invalid-root',
					'Fleet workspace root resolves through a link or reparse-point alias'
				);
			}
			break;
		} catch (error) {
			if (error instanceof FleetTaskWorkspaceError) throw error;
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			const parent = dirname(existing);
			if (parent === existing) {
				throw new FleetTaskWorkspaceError('invalid-root', 'Fleet workspace root has no safe existing ancestor');
			}
			existing = parent;
		}
	}

	await fs.mkdir(rootPath, { recursive: true, mode: 0o700 });
	const rootStats = await fs.lstat(rootPath);
	if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
		throw new FleetTaskWorkspaceError('invalid-root', 'Fleet workspace root is not a plain directory');
	}
	const canonicalRoot = await fs.realpath(rootPath);
	if (!samePath(canonicalRoot, rootPath)) {
		throw new FleetTaskWorkspaceError('invalid-root', 'Fleet workspace root resolves through an alias');
	}
	return canonicalRoot;
}

async function ensureSafeDirectory(directoryPath: string, canonicalParent: string): Promise<string> {
	try {
		await fs.mkdir(directoryPath, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
	}
	const stats = await fs.lstat(directoryPath);
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		throw new FleetTaskWorkspaceError('path-collision', 'Fleet repository cache path is not a safe directory');
	}
	const canonicalPath = await fs.realpath(directoryPath);
	if (!isStrictDescendant(canonicalParent, canonicalPath)) {
		throw new FleetTaskWorkspaceError('path-collision', 'Fleet repository cache path escapes its configured root');
	}
	return canonicalPath;
}

/**
 * The local-workspace provider can self-heal a stale binding by removing its
 * directory. Prove the existing directory is OUR stamped linked worktree
 * before allowing that behavior; an arbitrary folder or junction collision is
 * preserved and reported instead of ever becoming a recursive-delete target.
 */
async function assertExistingWorkspacePathSafe(
	expectedPath: string,
	repositoryRoot: string,
	signal?: AbortSignal
): Promise<void> {
	let stats;
	try {
		stats = await fs.lstat(expectedPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throwIfCancelled(signal);
			return;
		}
		throw new FleetTaskWorkspaceError('path-collision', 'Task workspace path could not be inspected safely');
	}

	throwIfCancelled(signal);
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		throw new FleetTaskWorkspaceError(
			'path-collision',
			'Existing task workspace is a link, reparse point, or non-directory and was preserved'
		);
	}
	let canonicalRepositoryRoot: string;
	let canonicalPath: string;
	try {
		[canonicalRepositoryRoot, canonicalPath] = await Promise.all([
			fs.realpath(repositoryRoot),
			fs.realpath(expectedPath)
		]);
	} catch {
		throw new FleetTaskWorkspaceError('path-collision', 'Existing task workspace path is not a safe directory');
	}
	if (!isStrictDescendant(canonicalRepositoryRoot, canonicalPath)) {
		throw new FleetTaskWorkspaceError('path-collision', 'Existing task workspace escapes its repository cache');
	}
	if (!samePath(canonicalPath, expectedPath)) {
		throw new FleetTaskWorkspaceError(
			'path-collision',
			'Existing task workspace resolves through a link or reparse-point alias and was preserved'
		);
	}
}

function isStrictDescendant(rootPath: string, candidate: string): boolean {
	const child = relative(rootPath, candidate);
	return child !== '' && child.split(/[\\/]/)[0] !== '..' && !isAbsolute(child);
}

function isCrossPlatformAbsolute(value: string): boolean {
	return isAbsolute(value) || posix.isAbsolute(value) || win32.isAbsolute(value);
}

/** Reject Windows local/drive-relative/device forms before SCP-like parsing. */
function isWindowsLocalPath(value: string): boolean {
	return /^[a-zA-Z]:/.test(value) || value.startsWith('\\\\') || value.startsWith('//');
}

function samePath(left: string, right: string): boolean {
	const normalizedLeft = resolve(left);
	const normalizedRight = resolve(right);
	return process.platform === 'win32'
		? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
		: normalizedLeft === normalizedRight;
}

function throwIfCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw cancelledError();
}

function cancelledError(): FleetTaskWorkspaceError {
	return new FleetTaskWorkspaceError('cancelled', 'Fleet workspace provisioning was cancelled');
}

function inspectGitHead(workspacePath: string, signal?: AbortSignal): Promise<string> {
	return runGitOutput(['rev-parse', '--verify', 'HEAD'], workspacePath, signal);
}

function runGitOutput(args: string[], workspacePath: string, signal?: AbortSignal): Promise<string> {
	return execFileWithVerifiedCancellation('git', args, {
		cwd: workspacePath,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		windowsHide: true,
		maxBuffer: 1024 * 1024,
		...(signal ? { signal } : {})
	}).then(({ error, stdout }) => {
		if (error) throw error;
		return String(stdout ?? '').trim();
	});
}

/**
 * Prove `<primary>/.mounts` is a plain directory directly under the primary
 * worktree — creating it when the spec has mounts — and drop every link in
 * it that the current spec no longer names.
 *
 * The primary worktree is reused across runs and the model runs in it as
 * the node service account, so `.mounts` is untrusted input on the next
 * provision: left as a symlink or junction to another Task's worktree (or
 * anywhere the account can write), every `lstat` / `unlink` / `symlink` on
 * `.mounts/<dir>` would resolve THROUGH it — a write-through-link by the
 * privileged provisioner, exactly what the cache-root checks refuse for
 * every other path. A link or file at `.mounts` is therefore a
 * `path-collision` when mounts are needed (and left alone when none are,
 * since nothing would be written through it). Real directories and files
 * inside `.mounts/` are never touched: they surface as collisions naming
 * the path so an operator can clean them.
 */
async function reconcileMountsDir(
	primaryPath: string,
	mountSpecs: readonly FleetTaskWorkspaceMountSpec[]
): Promise<string> {
	const mountsDir = resolve(primaryPath, FLEET_TASK_WORKSPACE_MOUNTS_DIR);
	let stats: Awaited<ReturnType<typeof fs.lstat>> | null = null;
	try {
		stats = await fs.lstat(mountsDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw new FleetTaskWorkspaceError('path-collision', `'${mountsDir}' could not be inspected safely`);
		}
	}
	if (stats && (stats.isSymbolicLink() || !stats.isDirectory())) {
		if (mountSpecs.length === 0) return mountsDir;
		throw new FleetTaskWorkspaceError(
			'path-collision',
			`'${FLEET_TASK_WORKSPACE_MOUNTS_DIR}' in the task workspace (${mountsDir}) is a link or file and was preserved`
		);
	}
	if (!stats) {
		if (mountSpecs.length === 0) return mountsDir;
		await fs.mkdir(mountsDir);
	}
	// `mkdir` cannot race a link into place unnoticed: re-read without
	// following, then require the canonical path to be exactly the plain
	// child of the (already canonical) primary.
	const created = await fs.lstat(mountsDir);
	if (created.isSymbolicLink() || !created.isDirectory()) {
		throw new FleetTaskWorkspaceError(
			'path-collision',
			`'${FLEET_TASK_WORKSPACE_MOUNTS_DIR}' in the task workspace (${mountsDir}) is a link or file and was preserved`
		);
	}
	let canonicalPrimary: string;
	let canonicalMounts: string;
	try {
		[canonicalPrimary, canonicalMounts] = await Promise.all([fs.realpath(primaryPath), fs.realpath(mountsDir)]);
	} catch {
		throw new FleetTaskWorkspaceError('path-collision', `'${mountsDir}' did not resolve to a directory`);
	}
	if (
		!isStrictDescendant(canonicalPrimary, canonicalMounts) ||
		!samePath(canonicalMounts, resolve(canonicalPrimary, FLEET_TASK_WORKSPACE_MOUNTS_DIR))
	) {
		throw new FleetTaskWorkspaceError(
			'path-collision',
			`'${mountsDir}' resolves through a link or reparse-point alias and was preserved`
		);
	}
	// Case-insensitive like the contracts normalizer: Windows and macOS
	// would otherwise keep `Template` next to `template`.
	const wanted = new Set(mountSpecs.map((mount) => mount.mountDir.toLowerCase()));
	for (const name of await fs.readdir(mountsDir)) {
		if (wanted.has(name.toLowerCase())) continue;
		const entryPath = join(mountsDir, name);
		if (!(await fs.lstat(entryPath)).isSymbolicLink()) continue;
		await removeMountLink(entryPath);
	}
	return mountsDir;
}

/**
 * Remove a mount link WITHOUT touching its target. `unlink` handles
 * symlinks everywhere and junctions on current Node; `rmdir` is the
 * documented fallback for a directory reparse point, and removes only the
 * reparse point itself. The caller has already proven the path is a link.
 */
async function removeMountLink(linkPath: string): Promise<void> {
	try {
		await fs.unlink(linkPath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== 'EPERM' && code !== 'EISDIR') throw error;
		await fs.rmdir(linkPath);
	}
}

/**
 * Put a reused READ-ONLY mount back to exactly its checked-out commit:
 * tracked edits reverted, untracked files removed (ignored files — caches,
 * dependencies — are kept, they are not content). Both commands run inside
 * the mount's own canonical worktree, never through the primary's link.
 */
async function resetReadOnlyMount(mountPath: string, signal?: AbortSignal): Promise<void> {
	try {
		await runGitOutput(['reset', '--hard', '--quiet', 'HEAD'], mountPath, signal);
		await runGitOutput(['clean', '-fdq'], mountPath, signal);
	} catch (error) {
		if (error instanceof Error && error.name === 'ProcessTreeTerminationError') throw error;
		if (signal?.aborted) throw cancelledError();
		throw new FleetTaskWorkspaceError('git-failed', 'Read-only mount could not be reset to its base commit');
	}
}

/**
 * Link one provisioned mount into the primary worktree at
 * `<mountsDir>/<mountDir>` (`mountsDir` is the `.mounts` directory
 * {@link reconcileMountsDir} has already proven plain). A directory
 * junction on Windows (no privilege needed) and a directory symlink
 * elsewhere. An existing link to the same target is kept; a link elsewhere
 * is replaced; a real directory or file at that path is a collision and is
 * never touched — the message names it so an operator can clean it.
 */
async function linkMountIntoPrimary(mountsDir: string, mountDir: string, targetPath: string): Promise<string> {
	const linkPath = resolve(mountsDir, mountDir);
	if (!isStrictDescendant(mountsDir, linkPath) || dirname(linkPath) !== mountsDir) {
		throw new FleetTaskWorkspaceError('invalid-spec', `Mount directory '${mountDir}' escapes the mounts directory`);
	}
	let existing: Awaited<ReturnType<typeof fs.lstat>> | null = null;
	try {
		existing = await fs.lstat(linkPath);
	} catch {
		existing = null;
	}
	if (existing) {
		if (!existing.isSymbolicLink()) {
			throw new FleetTaskWorkspaceError(
				'path-collision',
				`Mount path '${mountDir}' already exists in the task workspace (${linkPath}) and is not a mount link; remove it to provision this Task again`
			);
		}
		let current: string | null = null;
		try {
			current = await fs.realpath(linkPath);
		} catch {
			current = null;
		}
		if (current && samePath(current, targetPath)) return linkPath;
		await removeMountLink(linkPath);
	}
	await fs.symlink(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
	return linkPath;
}

/**
 * Keep the fleet's own paths (`FLEET_TASK_WORKSPACE_EXCLUDE_RULES`) out of
 * one repository's view: `git status`, `git add -A` (the finalize) and
 * every diff ignore them. Written to the repository's `info/exclude`
 * (shared by all worktrees of the pool) rather than a tracked
 * `.gitignore`, so nothing about the fleet layout is ever committed to
 * the owner's repository.
 *
 * The file is shared by every worktree of the pool, and another Task's
 * finalize (`git add -A`) may be reading it at this very moment: a torn
 * rule would let that finalize commit `.mounts` — a symlink entry on POSIX,
 * an embedded-repository gitlink on Windows — or a forgotten
 * `.ever-works/QUESTION.md` silently, into the owner's pushed branch. The
 * merged content is therefore written to a sibling temporary file and
 * renamed over the exclude file (atomic on both platforms), and every rule
 * is verified through Git itself before the workspace is considered ready.
 *
 * Per-rule idempotent: a node upgraded from slice C, whose exclude file
 * already carries `/.mounts/`, gains the `.ever-works/` rules exactly once
 * and never a second copy of any. Called for the primary of EVERY
 * workspace and for every mount, because the owner-question file
 * (slice Q) can appear in any of them.
 */
async function ensureFleetExcluded(repoPath: string, signal?: AbortSignal): Promise<void> {
	let commonDir: string;
	try {
		commonDir = (await runGitOutput(['rev-parse', '--git-common-dir'], repoPath, signal)).trim();
	} catch (error) {
		if (error instanceof Error && error.name === 'ProcessTreeTerminationError') throw error;
		if (signal?.aborted) throw cancelledError();
		throw new FleetTaskWorkspaceError('git-failed', 'Task workspace Git directory could not be resolved');
	}
	const excludePath = resolve(isAbsolute(commonDir) ? commonDir : resolve(repoPath, commonDir), 'info', 'exclude');
	let current = '';
	try {
		current = await fs.readFile(excludePath, 'utf8');
	} catch {
		current = '';
	}
	const lines = current.split(/\r?\n/).map((line) => line.trim());
	const missing = FLEET_TASK_WORKSPACE_EXCLUDE_RULES.filter((rule) => !lines.includes(rule));
	if (missing.length > 0) {
		await fs.mkdir(dirname(excludePath), { recursive: true });
		const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
		const merged = `${current}${separator}# ever-works fleet: mounted repositories and the owner-question file of Task workspaces\n${missing.join('\n')}\n`;
		const temporaryPath = `${excludePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
		try {
			await fs.writeFile(temporaryPath, merged, 'utf8');
			await fs.rename(temporaryPath, excludePath);
		} catch (error) {
			await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
			throw new FleetTaskWorkspaceError(
				'git-failed',
				`Task workspace exclude rule could not be written: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
	throwIfCancelled(signal);
	// `check-ignore -q` exits 0 only when the path IS ignored; anything else
	// (rule not effective, Git error) surfaces as a thrown call. The probes
	// are slash-terminated: a `dir/` rule matches directories only, and Git
	// evaluates a slash-terminated pathname as a directory even before it
	// exists — `.ever-works` never exists at provision time and `.mounts`
	// only in a multi-repo workspace.
	for (const probe of FLEET_TASK_WORKSPACE_EXCLUDE_PROBES) {
		// A probe path that exists as a LINK or a FILE cannot be verified this
		// way, and does not need to be.
		//
		// `dir/` matches directories only, so Git answers "not ignored" for a
		// symlink named `.mounts` — correctly. That is a POSIX-only outcome: on
		// Windows a junction reads as a directory and the probe passes, which is
		// why this surfaced first on Linux CI.
		//
		// Only the ASSERTION is skipped. The rule itself is still written above,
		// and nothing is written through such a path anyway: `reconcileMountsDir`
		// preserves a leftover link and refuses to use it, so there is no content
		// for the rule to have to cover. Without this, one stale `.mounts` link
		// left by an earlier run made the workspace unprovisionable forever —
		// including for Tasks that use no mounts at all, which is exactly the
		// case `fleet-task-workspace-mounts.spec.ts` pins as "not blocked by it".
		const probePath = join(repoPath, probe.replace(/\/$/, ''));
		const probeEntry = await fs.lstat(probePath).catch(() => null);
		if (probeEntry && !probeEntry.isDirectory()) {
			continue;
		}
		try {
			await runGitOutput(['check-ignore', '-q', probe], repoPath, signal);
		} catch (error) {
			if (error instanceof Error && error.name === 'ProcessTreeTerminationError') throw error;
			if (signal?.aborted) throw cancelledError();
			throw new FleetTaskWorkspaceError(
				'git-failed',
				`Task workspace exclude rule for '${probe}' did not take effect`
			);
		}
	}
}
