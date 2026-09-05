import { createHash } from 'node:crypto';
import { promises as fs, type Dirent } from 'node:fs';
import { join, resolve } from 'node:path';
import { FLEET_AGENT_TASK_META_DIR } from '@ever-works/contracts';
import { execFileWithVerifiedCancellation } from '@ever-works/local-workspace-plugin';
import {
	defaultIsProcessAlive,
	FLEET_TASK_WORKSPACE_MOUNTS_DIR,
	isStrictDescendant,
	readWorkspaceLease,
	readWorkspaceUsage,
	resolvePrivateGitDir,
	samePath,
	type FleetWorkspaceLease
} from './fleet-task-workspace';

/**
 * Workspace inventory — everything the node can find out about the
 * worktrees under its workspace root WITHOUT changing any of them.
 *
 * The reaper (`workspace-reaper.ts`) decides from this evidence alone, and
 * `ever-works-node doctor` prints it, so the evidence has to be honest
 * about what it does not know: every field that can fail to be
 * established has an `'unknown'` state, and unknown always reads as
 * "keep" downstream. Nothing here writes to a worktree; the only writes
 * are Git's own remote-tracking refs when a remote refresh is requested,
 * which is exactly what a provision would have written.
 *
 * ## Layout it understands (see `fleet-task-workspace.ts`)
 *
 *     <root>/repositories/<repository key>/
 *         repos/<repo key>/                     one BARE pool clone
 *             worktrees/<id>/ew-workspace.json  the provider's binding stamp
 *             worktrees/<id>/ew-workspace-lease.json / -usage.json
 *             ew-workspace-intents/<sha>.json   "provision in flight" proof
 *         worktrees/fleet-<binding>/            one checkout per (task, repo)
 *             .mounts/<dir>                     junction / symlink to ANOTHER worktree
 *
 * Anything that does not fit is reported as unrecognised and never
 * touched.
 */

/** Mirrors the local-workspace provider's private stamp/intent names. */
export const FLEET_WORKSPACE_STAMP_FILE = 'ew-workspace.json';
export const FLEET_WORKSPACE_INTENTS_DIR = 'ew-workspace-intents';

/** Per-command bound on a remote round trip (ls-remote / fetch). */
export const DEFAULT_REMOTE_TIMEOUT_MS = 30_000;

export type RemoteBranchState = 'present' | 'absent' | 'unknown';
export type Tristate = boolean | 'unknown';

export interface WorkspaceLeaseEvidence extends FleetWorkspaceLease {
	/** Whether the pid in the lease is running (a reused pid reads as running). */
	alive: boolean;
}

/** Everything known about one Task worktree. */
export interface WorkspaceRecord {
	/** Lexical path of the checkout. */
	path: string;
	repositoryRoot: string;
	/** The bare pool it is registered to, or null when that could not be proven. */
	poolPath: string | null;
	/** Its private gitdir (`<pool>/worktrees/<id>`), or null. */
	gitDir: string | null;
	bindingKey: string | null;
	branch: string | null;
	headSha: string | null;
	/** Stamp + exact Git registration both proven. Anything else is never removed. */
	owned: boolean;
	ownershipNote: string | null;
	/** Epoch ms of the last provision/release, or the best mtime evidence; null when nothing could be read. */
	lastUsedAt: number | null;
	/** True when `lastUsedAt` came from the usage file rather than mtimes. */
	hasUsageRecord: boolean;
	sizeBytes: number;
	dirty: Tristate;
	hasLocks: boolean;
	/** Commits on HEAD that no remote-tracking ref reaches. */
	unpushedCount: number | 'unknown';
	remoteBranch: RemoteBranchState;
	/** HEAD is an ancestor of the remote default branch. */
	mergedIntoDefault: Tristate;
	/** A provisioning intent for this binding is pending in the pool. */
	intentPending: boolean;
	lease: WorkspaceLeaseEvidence | null;
	/** `.mounts/*` entries that are links (junctions / symlinks). */
	mountLinks: string[];
	/**
	 * What `.mounts` itself is. `'foreign'` (a link or a file) and
	 * `'unknown'` are never removed: enumerating or deleting through it
	 * would reach whatever it points at. See {@link inspectMountsDir}.
	 */
	mountsDir: MountsDirState;
	/**
	 * Output under the fleet's own exclude rules (`.ever-works/`), which
	 * `git status` structurally cannot see. See {@link hasFleetExcludedOutput}.
	 */
	excludedOutput: Tristate;
}

/** One bare pool clone. */
export interface WorkspacePoolRecord {
	path: string;
	repositoryRoot: string;
	remoteUrl: string | null;
	/** Linked worktrees Git still lists for this pool (the bare entry itself excluded). */
	registeredWorktrees: number;
	pendingIntents: number;
	lastUsedAt: number | null;
	sizeBytes: number;
	owned: boolean;
	ownershipNote: string | null;
	/** Remote default branch, when a refresh resolved it. */
	defaultBranch: string | null;
	/**
	 * True when THIS scan refreshed the pool's remote-tracking refs (the
	 * `ls-remote` and the `fetch` both succeeded, or there was nothing to
	 * fetch). False offline or when either failed — every remote-derived
	 * fact is then stale and the pool is never removed.
	 */
	remoteRefreshed: boolean;
	/**
	 * Commits on any LOCAL branch of the pool that no remote-tracking ref
	 * reaches. `git worktree remove` leaves the branch behind, so a pool with
	 * zero worktrees can still hold work that was never pushed (the
	 * provider's branch-change re-cut, a manual clean-up); `'unknown'` when
	 * Git could not say.
	 */
	unpushedCount: number | 'unknown';
}

export interface WorkspaceRepositoryInventory {
	repositoryRoot: string;
	pools: WorkspacePoolRecord[];
	worktrees: WorkspaceRecord[];
	/** Entries under this repository cache the node does not recognise (reported, never touched). */
	unrecognised: string[];
}

export interface WorkspaceInventory {
	rootPath: string;
	/** False when the root does not exist yet (a node that never provisioned). */
	exists: boolean;
	scannedAt: number;
	/** True when remotes were consulted; false means every remote field is `'unknown'`. */
	remoteRefreshed: boolean;
	repositories: WorkspaceRepositoryInventory[];
	totalBytes: number;
	unrecognised: string[];
}

export interface ScanWorkspaceRootOptions {
	/**
	 * Consult each pool's remote (one `ls-remote`, one batched `fetch` per
	 * pool) so "pushed" and "merged" are judged against the remote AS OF
	 * NOW. Default true. Off, every remote-derived field is `'unknown'`,
	 * which the reaper reads as "keep" — an offline scan can inform, never
	 * remove.
	 */
	refreshRemote?: boolean;
	/** Walk every worktree for its byte size. Default true; off for a quick listing. */
	measureSize?: boolean;
	isProcessAlive?: (pid: number) => boolean;
	now?: () => number;
	remoteTimeoutMs?: number;
	signal?: AbortSignal;
}

interface ScanContext {
	refreshRemote: boolean;
	measureSize: boolean;
	isProcessAlive: (pid: number) => boolean;
	now: () => number;
	remoteTimeoutMs: number;
	signal: AbortSignal | undefined;
}

interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface WorktreeRegistration {
	path: string;
	head: string;
	branch: string;
	bare: boolean;
}

interface BindingStamp {
	bindingKey: string;
	branch: string;
	poolPath: string;
	worktreePath: string;
}

/** Scan the workspace root. Never throws for a malformed tree — it reports it. */
export async function scanWorkspaceRoot(
	rootPath: string,
	options: ScanWorkspaceRootOptions = {}
): Promise<WorkspaceInventory> {
	const context: ScanContext = {
		refreshRemote: options.refreshRemote ?? true,
		measureSize: options.measureSize ?? true,
		isProcessAlive: options.isProcessAlive ?? defaultIsProcessAlive,
		now: options.now ?? (() => Date.now()),
		remoteTimeoutMs: options.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS,
		signal: options.signal
	};
	const root = resolve(rootPath);
	const inventory: WorkspaceInventory = {
		rootPath: root,
		exists: false,
		scannedAt: context.now(),
		remoteRefreshed: context.refreshRemote,
		repositories: [],
		totalBytes: 0,
		unrecognised: []
	};
	const rootStats = await lstatOrNull(root);
	if (!rootStats) return inventory;
	if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
		inventory.unrecognised.push(root);
		return inventory;
	}
	inventory.exists = true;

	for (const entry of await readdirSafe(root)) {
		if (entry.name === 'repositories' && entry.isDirectory() && !entry.isSymbolicLink()) continue;
		inventory.unrecognised.push(join(root, entry.name));
	}
	const repositoriesDir = join(root, 'repositories');
	for (const entry of await readdirSafe(repositoriesDir)) {
		const repositoryRoot = join(repositoriesDir, entry.name);
		if (entry.isSymbolicLink() || !entry.isDirectory()) {
			inventory.unrecognised.push(repositoryRoot);
			continue;
		}
		inventory.repositories.push(await scanRepositoryRoot(repositoryRoot, context));
	}
	inventory.totalBytes = inventory.repositories.reduce(
		(sum, repository) =>
			sum +
			repository.pools.reduce((poolSum, pool) => poolSum + pool.sizeBytes, 0) +
			repository.worktrees.reduce((treeSum, tree) => treeSum + tree.sizeBytes, 0),
		0
	);
	return inventory;
}

async function scanRepositoryRoot(repositoryRoot: string, context: ScanContext): Promise<WorkspaceRepositoryInventory> {
	const result: WorkspaceRepositoryInventory = { repositoryRoot, pools: [], worktrees: [], unrecognised: [] };
	for (const entry of await readdirSafe(repositoryRoot)) {
		if ((entry.name === 'repos' || entry.name === 'worktrees') && entry.isDirectory() && !entry.isSymbolicLink()) {
			continue;
		}
		result.unrecognised.push(join(repositoryRoot, entry.name));
	}
	const reposDir = join(repositoryRoot, 'repos');
	for (const entry of await readdirSafe(reposDir)) {
		const poolPath = join(reposDir, entry.name);
		if (entry.isSymbolicLink() || !entry.isDirectory()) {
			result.unrecognised.push(poolPath);
			continue;
		}
		result.pools.push(await scanPool(poolPath, repositoryRoot, context));
	}
	const worktreesDir = join(repositoryRoot, 'worktrees');
	for (const entry of await readdirSafe(worktreesDir)) {
		const worktreePath = join(worktreesDir, entry.name);
		if (entry.isSymbolicLink() || !entry.isDirectory()) {
			result.unrecognised.push(worktreePath);
			continue;
		}
		result.worktrees.push(await scanWorktree(worktreePath, repositoryRoot, result.pools, context));
	}
	if (context.refreshRemote) {
		for (const pool of result.pools) {
			await refreshPoolRemote(
				pool,
				result.worktrees.filter((tree) => tree.poolPath !== null && samePath(tree.poolPath, pool.path)),
				context
			);
		}
	}
	for (const pool of result.pools) {
		await judgePool(pool, context);
	}
	for (const tree of result.worktrees) {
		await judgeAgainstRemote(tree, result.pools, context);
	}
	return result;
}

async function scanPool(poolPath: string, repositoryRoot: string, context: ScanContext): Promise<WorkspacePoolRecord> {
	const pool: WorkspacePoolRecord = {
		path: poolPath,
		repositoryRoot,
		remoteUrl: null,
		registeredWorktrees: 0,
		pendingIntents: 0,
		lastUsedAt: null,
		sizeBytes: 0,
		owned: false,
		ownershipNote: null,
		defaultBranch: null,
		remoteRefreshed: false,
		unpushedCount: 'unknown'
	};
	const head = await lstatOrNull(join(poolPath, 'HEAD'));
	if (!head || !head.isFile()) {
		pool.ownershipNote = 'not a bare Git repository (no HEAD)';
	} else if (!(await isCanonical(poolPath))) {
		pool.ownershipNote = 'pool path resolves through an alias';
	} else {
		const remote = await git(['config', '--get', 'remote.origin.url'], poolPath, context);
		pool.remoteUrl = remote.code === 0 && remote.stdout.trim() ? remote.stdout.trim() : null;
		const listed = await git(['worktree', 'list', '--porcelain'], poolPath, context);
		if (listed.code !== 0) {
			pool.ownershipNote = 'worktree registrations could not be read';
		} else {
			pool.registeredWorktrees = parseWorktreeRegistrations(listed.stdout).filter(
				(entry) => !entry.bare && !samePath(entry.path, poolPath)
			).length;
			pool.owned = true;
		}
	}
	const intents = await readdirSafe(join(poolPath, FLEET_WORKSPACE_INTENTS_DIR));
	pool.pendingIntents = intents.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length;
	// Dated by what changes ONLY on a provision or a removal — the pool's
	// `worktrees/` and intents directories — never by `FETCH_HEAD`, which the
	// scan's own remote refresh rewrites on every cycle (a pool dated by it
	// would look freshly used forever). `HEAD` is the creation-time floor.
	pool.lastUsedAt = await newestMtime([
		join(poolPath, 'worktrees'),
		join(poolPath, FLEET_WORKSPACE_INTENTS_DIR),
		join(poolPath, 'HEAD')
	]);
	pool.sizeBytes = context.measureSize ? await directorySize(poolPath) : 0;
	return pool;
}

async function scanWorktree(
	worktreePath: string,
	repositoryRoot: string,
	pools: readonly WorkspacePoolRecord[],
	context: ScanContext
): Promise<WorkspaceRecord> {
	const record: WorkspaceRecord = {
		path: worktreePath,
		repositoryRoot,
		poolPath: null,
		gitDir: null,
		bindingKey: null,
		branch: null,
		headSha: null,
		owned: false,
		ownershipNote: null,
		lastUsedAt: null,
		hasUsageRecord: false,
		sizeBytes: 0,
		dirty: 'unknown',
		hasLocks: false,
		unpushedCount: 'unknown',
		remoteBranch: 'unknown',
		mergedIntoDefault: 'unknown',
		intentPending: false,
		lease: null,
		mountLinks: [],
		mountsDir: 'absent',
		excludedOutput: 'unknown'
	};

	const mounts = await inspectMountsDir(worktreePath);
	record.mountsDir = mounts.state;
	record.mountLinks = mounts.links;
	record.excludedOutput = await hasFleetExcludedOutput(worktreePath);
	record.sizeBytes = context.measureSize ? await directorySize(worktreePath) : 0;

	const ownership = await proveOwnership(worktreePath, pools, context);
	record.ownershipNote = ownership.note;
	if (ownership.gitDir) record.gitDir = ownership.gitDir;
	if (ownership.poolPath) record.poolPath = ownership.poolPath;
	if (ownership.stamp) {
		record.bindingKey = ownership.stamp.bindingKey;
		record.branch = ownership.stamp.branch;
	}
	if (ownership.registration) record.headSha = ownership.registration.head;
	record.owned = ownership.owned;

	if (record.gitDir) {
		const lease = await readWorkspaceLease(record.gitDir);
		record.lease = lease ? { ...lease, alive: context.isProcessAlive(lease.pid) } : null;
		const usage = await readWorkspaceUsage(record.gitDir);
		if (usage) {
			record.lastUsedAt = Date.parse(usage.lastUsedAt);
			record.hasUsageRecord = true;
		}
		record.hasLocks =
			(await lstatOrNull(join(record.gitDir, 'index.lock'))) !== null ||
			(await lstatOrNull(join(record.gitDir, 'HEAD.lock'))) !== null;
	}
	if (record.lastUsedAt === null) {
		const candidates = [worktreePath];
		if (record.gitDir) {
			candidates.push(
				join(record.gitDir, 'HEAD'),
				join(record.gitDir, 'index'),
				join(record.gitDir, 'logs', 'HEAD'),
				join(record.gitDir, FLEET_WORKSPACE_STAMP_FILE)
			);
		}
		record.lastUsedAt = await newestMtime(candidates);
	}
	if (record.poolPath && record.bindingKey) {
		record.intentPending = (await lstatOrNull(intentPath(record.poolPath, record.bindingKey))) !== null;
	}
	if (record.owned) {
		const status = await git(['status', '--porcelain', '--untracked-files=all'], worktreePath, context);
		record.dirty = status.code === 0 ? status.stdout.trim().length > 0 : 'unknown';
	}
	return record;
}

/**
 * The same proof the provider demands before it removes anything: a plain
 * directory at its own canonical path, a private gitdir inside a pool of
 * THIS repository cache, a v2 stamp naming exactly these paths, and one
 * Git registration on the stamped branch.
 */
async function proveOwnership(
	worktreePath: string,
	pools: readonly WorkspacePoolRecord[],
	context: ScanContext
): Promise<{
	owned: boolean;
	note: string | null;
	gitDir: string | null;
	poolPath: string | null;
	stamp: BindingStamp | null;
	registration: WorktreeRegistration | null;
}> {
	const failure = (
		note: string,
		partial: Partial<{ gitDir: string; poolPath: string; stamp: BindingStamp }> = {}
	) => ({
		owned: false,
		note,
		gitDir: partial.gitDir ?? null,
		poolPath: partial.poolPath ?? null,
		stamp: partial.stamp ?? null,
		registration: null
	});
	if (!(await isCanonical(worktreePath))) {
		return failure('workspace path resolves through an alias');
	}
	const gitDir = await resolvePrivateGitDir(worktreePath, context.signal);
	if (!gitDir) {
		return failure('not a linked Git worktree');
	}
	const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], worktreePath, context);
	if (common.code !== 0 || !common.stdout.trim()) {
		return failure('repository pool could not be resolved', { gitDir });
	}
	let canonicalCommon: string;
	try {
		canonicalCommon = await fs.realpath(common.stdout.trim());
	} catch {
		return failure('repository pool could not be resolved', { gitDir });
	}
	const pool = pools.find((candidate) => candidate.owned && samePath(candidate.path, canonicalCommon));
	if (!pool) {
		return failure('registered to a pool outside this repository cache', { gitDir });
	}
	if (!isStrictDescendant(join(pool.path, 'worktrees'), gitDir)) {
		return failure('private gitdir is not inside the pool', { gitDir, poolPath: pool.path });
	}
	const stamp = await readStamp(gitDir);
	if (!stamp) {
		return failure('binding stamp missing, foreign, or corrupt', { gitDir, poolPath: pool.path });
	}
	if (
		stamp.worktreePath !== normalizedPath(await fs.realpath(worktreePath)) ||
		stamp.poolPath !== normalizedPath(pool.path)
	) {
		return failure('binding stamp names a different path or pool', { gitDir, poolPath: pool.path, stamp });
	}
	const listed = await git(['worktree', 'list', '--porcelain'], pool.path, context);
	if (listed.code !== 0) {
		return failure('worktree registrations could not be read', { gitDir, poolPath: pool.path, stamp });
	}
	const matches = parseWorktreeRegistrations(listed.stdout).filter((entry) => samePath(entry.path, worktreePath));
	if (matches.length !== 1 || !/^[0-9a-f]{40,64}$/i.test(matches[0].head)) {
		return failure('no exact Git registration in the pool', { gitDir, poolPath: pool.path, stamp });
	}
	if (matches[0].branch !== stamp.branch) {
		return failure('Git registration is on a different branch than the stamp', {
			gitDir,
			poolPath: pool.path,
			stamp
		});
	}
	return { owned: true, note: null, gitDir, poolPath: pool.path, stamp, registration: matches[0] };
}

/**
 * One round trip per pool: `ls-remote --symref` gives the remote's default
 * branch and every head, then one batched `fetch` refreshes the
 * remote-tracking refs the local ancestry math below depends on.
 *
 * This matters because the node PUSHES to a URL (`git push <url>
 * HEAD:refs/heads/<branch>`), which never updates
 * `refs/remotes/origin/<branch>`; without the refresh every pushed
 * workspace would look unpushed forever and the reaper could never free
 * anything. A branch the remote no longer has gets its stale tracking ref
 * deleted for the same reason.
 */
async function refreshPoolRemote(
	pool: WorkspacePoolRecord,
	worktrees: readonly WorkspaceRecord[],
	context: ScanContext
): Promise<void> {
	if (!pool.owned || !pool.remoteUrl) return;
	const listed = await git(['ls-remote', '--symref', pool.remoteUrl, 'HEAD', 'refs/heads/*'], pool.path, context, {
		timeoutMs: context.remoteTimeoutMs
	});
	if (listed.code !== 0) return;
	const heads = new Set<string>();
	let defaultBranch: string | null = null;
	for (const line of listed.stdout.split(/\r?\n/)) {
		const symref = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
		if (symref) {
			defaultBranch = symref[1];
			continue;
		}
		const head = /^[0-9a-f]{40,64}\trefs\/heads\/(.+)$/i.exec(line);
		if (head) heads.add(head[1]);
	}
	pool.defaultBranch = defaultBranch;

	// Every LOCAL branch of the pool is refreshed, not only the ones a
	// worktree is on: `git worktree remove` leaves the branch behind, and
	// the pool's own unpushed count (`judgePool`) is judged on these refs.
	const branches = await git(['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads'], pool.path, context);
	if (branches.code !== 0) return;
	const localBranches = new Set(
		branches.stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
	);
	for (const tree of worktrees) {
		if (tree.owned && tree.branch) localBranches.add(tree.branch);
	}

	const refspecs: string[] = [];
	if (defaultBranch) refspecs.push(`+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`);
	for (const branch of localBranches) {
		if (branch === defaultBranch) continue;
		if (heads.has(branch)) {
			refspecs.push(`+refs/heads/${branch}:refs/remotes/origin/${branch}`);
		} else {
			await git(['update-ref', '-d', `refs/remotes/origin/${branch}`], pool.path, context);
		}
	}
	for (const tree of worktrees) {
		if (!tree.owned || !tree.branch) continue;
		tree.remoteBranch = heads.has(tree.branch) ? 'present' : 'absent';
	}
	if (refspecs.length > 0) {
		const fetched = await git(['fetch', '--quiet', pool.remoteUrl, ...new Set(refspecs)], pool.path, context, {
			timeoutMs: context.remoteTimeoutMs
		});
		if (fetched.code !== 0) {
			// The refs are now of unknown freshness: NOTHING in this pool is
			// judged on them — not even a branch `ls-remote` said was gone,
			// because its "pushed" count would be computed against stale refs.
			pool.defaultBranch = null;
			for (const tree of worktrees) tree.remoteBranch = 'unknown';
			return;
		}
	}
	pool.remoteRefreshed = true;
}

/**
 * Everything the pool can still reach that no remote-tracking ref does,
 * judged after the refresh. This is what makes an emptied pool safe (or
 * not) to delete: deleting it is the one irreversible `fs.rm` in the
 * reaper, and it takes the object store with it.
 *
 * `--all --reflog`, not `--branches` (review AO-2). `--branches` sees only
 * `refs/heads/*`, and the provider's own
 * `worktree add -B <branch> <dir> <startPoint>` FORCE-RESETS an existing
 * local branch — so a commit from a run whose publish was withheld can
 * end up reachable from that branch's reflog alone, at which point
 * `--branches` counts zero and the pool (its last copy) becomes
 * removable. `--all` additionally covers `refs/stash` and tags. Counting
 * more is always the safe direction here: it can only keep a pool, never
 * delete one.
 */
export const POOL_UNPUSHED_REVISION_ARGS: readonly string[] = [
	'rev-list',
	'--count',
	'--all',
	'--reflog',
	'--not',
	'--remotes'
];

async function judgePool(pool: WorkspacePoolRecord, context: ScanContext): Promise<void> {
	if (!pool.owned) return;
	const counted = await git(POOL_UNPUSHED_REVISION_ARGS, pool.path, context);
	if (counted.code === 0 && /^\d+$/.test(counted.stdout.trim())) {
		pool.unpushedCount = Number(counted.stdout.trim());
	}
}

/** Local ancestry math over the (possibly just refreshed) remote-tracking refs. */
async function judgeAgainstRemote(
	tree: WorkspaceRecord,
	pools: readonly WorkspacePoolRecord[],
	context: ScanContext
): Promise<void> {
	if (!tree.owned) return;
	const counted = await git(['rev-list', '--count', 'HEAD', '--not', '--remotes'], tree.path, context);
	if (counted.code === 0 && /^\d+$/.test(counted.stdout.trim())) {
		tree.unpushedCount = Number(counted.stdout.trim());
	}
	const pool = tree.poolPath ? pools.find((candidate) => samePath(candidate.path, tree.poolPath!)) : undefined;
	if (!pool?.defaultBranch) return;
	const merged = await git(
		['merge-base', '--is-ancestor', 'HEAD', `refs/remotes/origin/${pool.defaultBranch}`],
		tree.path,
		context
	);
	if (merged.code === 0) tree.mergedIntoDefault = true;
	else if (merged.code === 1) tree.mergedIntoDefault = false;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function git(
	args: readonly string[],
	cwd: string,
	context: ScanContext,
	options: { timeoutMs?: number } = {}
): Promise<GitResult> {
	const signals: AbortSignal[] = [];
	if (context.signal) signals.push(context.signal);
	if (options.timeoutMs !== undefined) signals.push(AbortSignal.timeout(options.timeoutMs));
	const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
	try {
		const { error, stdout, stderr } = await execFileWithVerifiedCancellation('git', args, {
			cwd,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
			windowsHide: true,
			maxBuffer: 16 * 1024 * 1024,
			...(signal ? { signal } : {})
		});
		const code =
			error && typeof (error as { code?: unknown }).code === 'number'
				? ((error as { code?: number }).code ?? 1)
				: error
					? 1
					: 0;
		return { code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
	} catch (error) {
		if (error instanceof Error && error.name === 'ProcessTreeTerminationError') throw error;
		if (context.signal?.aborted) throw error;
		return { code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
	}
}

function parseWorktreeRegistrations(output: string): WorktreeRegistration[] {
	const registrations: WorktreeRegistration[] = [];
	let current: Partial<WorktreeRegistration> = {};
	const finish = (): void => {
		if (typeof current.path === 'string') {
			registrations.push({
				path: current.path,
				head: current.head ?? '',
				branch: current.branch ?? '',
				bare: current.bare === true
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
		else if (rawLine.startsWith('branch refs/heads/')) current.branch = rawLine.slice('branch refs/heads/'.length);
		else if (rawLine === 'bare') current.bare = true;
	}
	return registrations;
}

async function readStamp(gitDir: string): Promise<BindingStamp | null> {
	const path = join(gitDir, FLEET_WORKSPACE_STAMP_FILE);
	try {
		const stats = await fs.lstat(path);
		if (stats.isSymbolicLink() || !stats.isFile()) return null;
		const parsed = JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>;
		if (
			parsed.version !== 2 ||
			typeof parsed.bindingKey !== 'string' ||
			!parsed.bindingKey ||
			typeof parsed.branch !== 'string' ||
			!parsed.branch ||
			typeof parsed.poolPath !== 'string' ||
			typeof parsed.worktreePath !== 'string'
		) {
			return null;
		}
		return {
			bindingKey: parsed.bindingKey,
			branch: parsed.branch,
			poolPath: parsed.poolPath,
			worktreePath: parsed.worktreePath
		};
	} catch {
		return null;
	}
}

/** Mirrors the provider's intent-file naming so a pending intent is found by binding key. */
export function intentPath(poolPath: string, bindingKey: string): string {
	const key = createHash('sha256').update('workspace-intent-v1\0').update(bindingKey).digest('hex');
	return join(poolPath, FLEET_WORKSPACE_INTENTS_DIR, `${key}.json`);
}

/**
 * What `<worktree>/.mounts` is right now, and the links inside it.
 *
 * `.mounts` is the one path in a worktree that the MODEL can replace,
 * running as the node service account, and the provisioner deliberately
 * leaves a link there in place for a single-repository task
 * (`reconcileMountsDir`) rather than deleting it. So it is untrusted
 * input to the reaper as well, and it is `lstat`-ed here before anything
 * is enumerated: a bare `readdir` RESOLVES a junction, so the reaper
 * would have listed the entries of the junction's TARGET — another Task's
 * live checkout — and then unlinked them there while reporting that it
 * had only touched this worktree (review AO-1).
 *
 * Each entry is `lstat`-ed again for the same reason `reconcileMountsDir`
 * does it: the `Dirent` type is a snapshot, the unlink happens later.
 */
export type MountsDirState = 'absent' | 'directory' | 'foreign' | 'unknown';

export interface MountsDirInventory {
	state: MountsDirState;
	/** Links to unlink before Git removes the worktree; only ever non-empty for `'directory'`. */
	links: string[];
}

export async function inspectMountsDir(worktreePath: string): Promise<MountsDirInventory> {
	const mountsDir = join(worktreePath, FLEET_TASK_WORKSPACE_MOUNTS_DIR);
	let stats: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		stats = await fs.lstat(mountsDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent', links: [] };
		return { state: 'unknown', links: [] };
	}
	if (stats.isSymbolicLink() || !stats.isDirectory()) return { state: 'foreign', links: [] };
	let entries: Dirent[];
	try {
		entries = await fs.readdir(mountsDir, { withFileTypes: true });
	} catch {
		return { state: 'unknown', links: [] };
	}
	const links: string[] = [];
	for (const entry of entries) {
		const entryPath = join(mountsDir, entry.name);
		const entryStats = await lstatOrNull(entryPath);
		if (!entryStats) continue;
		if (entryStats.isSymbolicLink()) links.push(entryPath);
	}
	return { state: 'directory', links };
}

/** `.mounts/*` entries that are links right now; the reaper unlinks these before Git removes the worktree. */
export async function listMountLinks(worktreePath: string): Promise<string[]> {
	return (await inspectMountsDir(worktreePath)).links;
}

/**
 * Whether the worktree holds output under the fleet's OWN exclude rules
 * — `.ever-works/`, the owner-question channel and the agent meta
 * directory (review AO-4).
 *
 * `git status --porcelain --untracked-files=all`, which is the reaper's
 * entire "no uncommitted work" proof, reports NOTHING for these paths:
 * the node writes `/.ever-works` and `.ever-works` into the pool's shared
 * `info/exclude` itself (`FLEET_TASK_WORKSPACE_EXCLUDE_RULES`). So the
 * one directory the fleet designates for non-committed model output is
 * structurally invisible to the rule that decides whether a worktree may
 * be deleted, and a run interrupted between writing `QUESTION.md` and
 * `collectOwnerQuestion` reading it looked perfectly clean.
 *
 * Scoped to the fleet's own rules on purpose. Consulting the OWNER's
 * `.gitignore` (via `--ignored`) would make almost every worktree read as
 * dirty — `node_modules`, `dist`, caches — and the reaper would never
 * reclaim anything, which is the defect this slice exists to close.
 * Anything found here is left for an operator, because the normal path
 * REMOVES the question file (and its directory) as soon as it is
 * collected: a `.ever-works` still on disk means nobody read it.
 */
export async function hasFleetExcludedOutput(worktreePath: string): Promise<Tristate> {
	const metaDir = join(worktreePath, FLEET_AGENT_TASK_META_DIR);
	let stats: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		stats = await fs.lstat(metaDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		return 'unknown';
	}
	// A link or a file where the meta DIRECTORY belongs is not something
	// this reaper is entitled to reason about, let alone delete through.
	if (stats.isSymbolicLink() || !stats.isDirectory()) return 'unknown';
	try {
		return (await fs.readdir(metaDir)).length > 0;
	} catch {
		return 'unknown';
	}
}

function normalizedPath(value: string): string {
	const normalized = resolve(value);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function isCanonical(path: string): Promise<boolean> {
	try {
		const stats = await fs.lstat(path);
		if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
		return samePath(await fs.realpath(path), path);
	} catch {
		return false;
	}
}

async function lstatOrNull(path: string) {
	try {
		return await fs.lstat(path);
	} catch {
		return null;
	}
}

async function readdirSafe(path: string): Promise<Dirent[]> {
	try {
		return await fs.readdir(path, { withFileTypes: true });
	} catch {
		return [];
	}
}

async function newestMtime(paths: readonly string[]): Promise<number | null> {
	let newest: number | null = null;
	for (const path of paths) {
		const stats = await lstatOrNull(path);
		if (!stats) continue;
		if (newest === null || stats.mtimeMs > newest) newest = stats.mtimeMs;
	}
	return newest;
}

/**
 * Bytes under a directory, never following links: a `.mounts/<dir>`
 * junction points at another Task's checkout, which must be counted (and
 * later removed) as ITS OWN workspace, not as this one's.
 */
export async function directorySize(path: string): Promise<number> {
	let total = 0;
	const pending: string[] = [path];
	while (pending.length > 0) {
		const current = pending.pop()!;
		for (const entry of await readdirSafe(current)) {
			const entryPath = join(current, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				pending.push(entryPath);
				continue;
			}
			const stats = await lstatOrNull(entryPath);
			if (stats?.isFile()) total += stats.size;
		}
	}
	return total;
}
