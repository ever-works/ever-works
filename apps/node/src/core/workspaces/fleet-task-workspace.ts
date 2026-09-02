import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, posix, relative, resolve, win32 } from 'node:path';
import type { FleetTaskWorkspaceDescriptor, FleetTaskWorkspaceSpec } from '@ever-works/contracts';
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
				{ commitMessage, push: opts.push }
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
	return { repositoryId, repoUrl, baseRef, branch, ...(depth === undefined ? {} : { depth }) };
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
