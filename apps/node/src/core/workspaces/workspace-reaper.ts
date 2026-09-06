import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { execFileWithVerifiedCancellation, LocalWorkspacePlugin } from '@ever-works/local-workspace-plugin';
import type { WorkspaceHandle } from '@ever-works/plugin';
import type { Scheduler } from '../heartbeat';
import { systemScheduler } from '../heartbeat';
import type { Logger } from '../logger';
import { formatBytes } from '../resource-limits';
import type { NodeWorkspaceGcPolicy } from '../types';
import {
	acquireWorkspaceLease,
	defaultIsProcessAlive,
	releaseWorkspaceLease,
	removeMountLink,
	samePath
} from './fleet-task-workspace';
import {
	FLEET_WORKSPACE_INTENTS_DIR,
	intentPath,
	listMountLinks,
	scanWorkspaceRoot,
	type WorkspaceInventory,
	type WorkspacePoolRecord,
	type WorkspaceRecord
} from './workspace-inventory';

/**
 * Workspace reaper — the thing that was missing (self-build program note
 * §6, R8): every Task on every repository left a worktree on every machine
 * forever, until the founder's own PC hit 38 MB free.
 *
 * ## Fail closed, by construction
 *
 * The reaper never removes a worktree it cannot PROVE is safe to remove.
 * "Prove" means every one of these, from local evidence plus one remote
 * round trip, and the reason for the first one that fails is reported:
 *
 *   1. ownership — the provider's stamp AND an exact Git registration;
 *   2. no provisioning intent pending (a provision may be mid-way);
 *   3. no live lease (a job is running in it — this process or another);
 *   4. not a binding this process is using right now;
 *   5. no uncommitted or untracked changes, no Git lock file;
 *   6. no commit on HEAD that is not reachable from a remote ref;
 *   7. the remote was reachable, AND the branch is gone from it or merged
 *      into its default branch — a branch still open there stays;
 *   8. unused for longer than the max age.
 *
 * Unknown always means keep. An offline scan therefore never removes.
 * The count budget only ever chooses AMONG worktrees that already pass
 * rules 1–7; it never overrides a safety rule.
 *
 * ## Never a raw delete
 *
 * A worktree is removed through the provider's own `teardown` — the
 * ownership proof, `git worktree remove --force`, `git worktree prune`,
 * and a refusal if the path is somehow still there — after every
 * `.mounts/*` link has been unlinked, because a recursive delete that
 * followed a junction would empty ANOTHER Task's checkout. A bare pool is
 * deleted only once Git lists no worktree for it, no intent is pending, its
 * remote was refreshed by this scan, and no commit on any of its LOCAL
 * branches is missing from the remote — `git worktree remove` leaves the
 * branch behind, so an emptied pool can still hold unpushed work.
 */

export interface WorkspaceReapPolicy {
	maxAgeMs: number;
	/** Keep at most this many worktrees (LRU among the safe ones), or null. */
	maxCount: number | null;
	/**
	 * Keep worktrees that carry no usage record. Set by `gc` in a separate
	 * process while a worker-session marker exists: a worktree from before
	 * this node build learned to lease could be in use by that worker
	 * without any lease to say so. The in-process timer never needs it —
	 * its own jobs always lease.
	 */
	requireUsageRecord?: boolean;
	/** Plan only; the executor performs no write at all. */
	dryRun?: boolean;
}

export interface WorkspaceReapVerdict {
	record: WorkspaceRecord;
	reason: string;
}

export interface WorkspacePoolVerdict {
	pool: WorkspacePoolRecord;
	reason: string;
}

export interface WorkspaceReapPlan {
	policy: WorkspaceReapPolicy;
	plannedAt: number;
	remove: WorkspaceReapVerdict[];
	keep: WorkspaceReapVerdict[];
	removePools: WorkspacePoolVerdict[];
	keepPools: WorkspacePoolVerdict[];
	reclaimableBytes: number;
}

/** Days → ms, as the CLI and the config store speak in days. */
export function policyFromConfig(policy: NodeWorkspaceGcPolicy): WorkspaceReapPolicy {
	return { maxAgeMs: policy.maxAgeDays * 24 * 60 * 60_000, maxCount: policy.maxCount };
}

/** `3 d`, `5 h`, `12 min` — for verdict reasons and the CLI. */
export function describeAge(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return 'unknown';
	const minutes = ms / 60_000;
	if (minutes < 60) return `${Math.round(minutes)} min`;
	const hours = minutes / 60;
	if (hours < 48) return `${Math.round(hours)} h`;
	return `${Math.round(hours / 24)} d`;
}

/**
 * Decide, from evidence alone, what the reaper would do. Pure: the same
 * inventory and clock always yield the same plan, and `doctor` prints this
 * without ever calling the executor.
 */
export function planWorkspaceReap(
	inventory: WorkspaceInventory,
	policy: WorkspaceReapPolicy,
	now: number,
	activeBindings: ReadonlySet<string> = new Set()
): WorkspaceReapPlan {
	const plan: WorkspaceReapPlan = {
		policy,
		plannedAt: now,
		remove: [],
		keep: [],
		removePools: [],
		keepPools: [],
		reclaimableBytes: 0
	};
	// Safe = passes every rule EXCEPT age. Age (and the count budget) only
	// ever chooses among these.
	const safe: Array<{ record: WorkspaceRecord; age: number }> = [];
	for (const repository of inventory.repositories) {
		for (const record of repository.worktrees) {
			const unsafe = whyUnsafe(record, policy, activeBindings);
			if (unsafe) {
				plan.keep.push({ record, reason: unsafe });
				continue;
			}
			safe.push({ record, age: now - (record.lastUsedAt as number) });
		}
	}
	const young: Array<{ record: WorkspaceRecord; age: number }> = [];
	for (const candidate of safe) {
		if (candidate.age > policy.maxAgeMs) {
			plan.remove.push({
				record: candidate.record,
				reason: `${eligibleWhy(candidate.record)}; unused for ${describeAge(candidate.age)}`
			});
		} else {
			young.push(candidate);
		}
	}
	// Count budget: trim the least-recently-used SAFE worktrees beyond it.
	const total = plan.remove.length + plan.keep.length + young.length;
	if (policy.maxCount !== null && total - plan.remove.length > policy.maxCount) {
		let excess = total - plan.remove.length - policy.maxCount;
		for (const candidate of [...young].sort((left, right) => right.age - left.age)) {
			if (excess <= 0) break;
			plan.remove.push({
				record: candidate.record,
				reason: `${eligibleWhy(candidate.record)}; beyond the ${policy.maxCount}-workspace budget (least recently used, ${describeAge(candidate.age)} ago)`
			});
			young.splice(young.indexOf(candidate), 1);
			excess -= 1;
		}
	}
	for (const candidate of young) {
		plan.keep.push({
			record: candidate.record,
			reason: `used ${describeAge(candidate.age)} ago (within the max age)`
		});
	}

	for (const repository of inventory.repositories) {
		for (const pool of repository.pools) {
			const stillReferenced = repository.worktrees.some(
				(record) => record.poolPath !== null && samePath(record.poolPath, pool.path)
			);
			if (!pool.owned) {
				plan.keepPools.push({ pool, reason: pool.ownershipNote ?? 'ownership unproven' });
			} else if (pool.registeredWorktrees > 0 || stillReferenced) {
				plan.keepPools.push({
					pool,
					reason: `${Math.max(pool.registeredWorktrees, 1)} worktree(s) still registered`
				});
			} else if (pool.pendingIntents > 0) {
				plan.keepPools.push({ pool, reason: `${pool.pendingIntents} provisioning intent(s) pending` });
			} else if (!pool.remoteRefreshed) {
				plan.keepPools.push({ pool, reason: 'remote state unknown (offline or unreachable)' });
			} else if (pool.unpushedCount === 'unknown') {
				plan.keepPools.push({ pool, reason: 'local branch state unknown' });
			} else if (pool.unpushedCount > 0) {
				plan.keepPools.push({
					pool,
					reason: `${pool.unpushedCount} commit(s) on local branches not on any remote`
				});
			} else if (pool.lastUsedAt === null) {
				plan.keepPools.push({ pool, reason: 'last use unknown' });
			} else if (now - pool.lastUsedAt <= policy.maxAgeMs) {
				plan.keepPools.push({
					pool,
					reason: `used ${describeAge(now - pool.lastUsedAt)} ago (within the max age)`
				});
			} else {
				plan.removePools.push({
					pool,
					reason: `no worktree registered; unused for ${describeAge(now - pool.lastUsedAt)}`
				});
			}
		}
	}
	plan.reclaimableBytes =
		plan.remove.reduce((sum, verdict) => sum + verdict.record.sizeBytes, 0) +
		plan.removePools.reduce((sum, verdict) => sum + verdict.pool.sizeBytes, 0);
	return plan;
}

/** The first safety rule the record fails, or null when it passes them all. Order is the rule order in the header. */
function whyUnsafe(
	record: WorkspaceRecord,
	policy: WorkspaceReapPolicy,
	activeBindings: ReadonlySet<string>
): string | null {
	if (!record.owned) return `ownership unproven: ${record.ownershipNote ?? 'no evidence'}`;
	if (record.intentPending) return 'provisioning in flight (intent pending)';
	if (record.lease && record.lease.alive) {
		return `leased by pid ${record.lease.pid} (${record.lease.purpose === 'gc' ? 'reaper' : 'running job'})`;
	}
	if (record.bindingKey !== null && activeBindings.has(record.bindingKey)) return 'in use by this process';
	if (record.dirty === 'unknown') return 'working tree state unknown';
	if (record.dirty) return 'uncommitted changes';
	if (record.hasLocks) return 'git lock file present';
	if (record.unpushedCount === 'unknown') return 'unpushed commit count unknown';
	if (record.unpushedCount > 0) return `${record.unpushedCount} commit(s) not on any remote`;
	if (record.remoteBranch === 'unknown') return 'remote state unknown (offline or unreachable)';
	if (record.remoteBranch === 'present' && record.mergedIntoDefault !== true) {
		return record.mergedIntoDefault === false
			? 'branch still open on the remote'
			: 'branch still on the remote (merge state unknown)';
	}
	if (policy.requireUsageRecord && !record.hasUsageRecord) {
		return 'no usage record while a worker session may be active';
	}
	if (record.lastUsedAt === null) return 'last use unknown';
	return null;
}

function eligibleWhy(record: WorkspaceRecord): string {
	return record.remoteBranch === 'absent'
		? 'clean, branch gone from the remote'
		: 'clean, merged into the default branch';
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

export interface WorkspaceReapDeps {
	/** Provider whose `teardown` owns the actual removal. Defaults to the real local-workspace provider. */
	plugin?: { teardown(handle: WorkspaceHandle): Promise<void> };
	isProcessAlive?: (pid: number) => boolean;
	now?: () => number;
	logger?: Logger;
	signal?: AbortSignal;
	/** Also delete pools this run emptied (default true). */
	removeEmptiedPools?: boolean;
}

export interface WorkspaceReapResult {
	dryRun: boolean;
	removed: Array<{ record: WorkspaceRecord; freedBytes: number }>;
	/** Everything not removed — the plan's keeps plus removals that failed their final re-check. */
	kept: WorkspaceReapVerdict[];
	removedPools: Array<{ pool: WorkspacePoolRecord; freedBytes: number }>;
	keptPools: WorkspacePoolVerdict[];
	freedBytes: number;
	/** Removals that threw, one message each. */
	errors: string[];
}

/** Execute a plan. A `dryRun` policy makes this a pure read; otherwise each removal re-proves itself right before acting. */
export async function runWorkspaceReap(
	plan: WorkspaceReapPlan,
	deps: WorkspaceReapDeps = {}
): Promise<WorkspaceReapResult> {
	const result: WorkspaceReapResult = {
		dryRun: plan.policy.dryRun === true,
		removed: [],
		kept: [...plan.keep],
		removedPools: [],
		keptPools: [...plan.keepPools],
		freedBytes: 0,
		errors: []
	};
	if (result.dryRun) {
		result.removed = plan.remove.map((verdict) => ({
			record: verdict.record,
			freedBytes: verdict.record.sizeBytes
		}));
		result.removedPools = plan.removePools.map((verdict) => ({
			pool: verdict.pool,
			freedBytes: verdict.pool.sizeBytes
		}));
		result.freedBytes = plan.reclaimableBytes;
		return result;
	}
	const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
	const now = deps.now ?? (() => Date.now());
	const plugin = deps.plugin ?? new LocalWorkspacePlugin();

	const emptiedPools = new Map<string, WorkspacePoolRecord>();
	const poolsByPath = new Map<string, WorkspacePoolRecord>();
	for (const verdict of [...plan.keepPools, ...plan.removePools]) poolsByPath.set(verdict.pool.path, verdict.pool);
	const poolHadKeep = new Set<string>();
	for (const verdict of plan.keep) if (verdict.record.poolPath) poolHadKeep.add(verdict.record.poolPath);

	for (const verdict of plan.remove) {
		if (deps.signal?.aborted) {
			result.kept.push({ record: verdict.record, reason: 'reaper stopped before this workspace' });
			continue;
		}
		const outcome = await removeWorktree(verdict.record, { plugin, isProcessAlive, now, signal: deps.signal });
		if (outcome.ok) {
			result.removed.push({ record: verdict.record, freedBytes: verdict.record.sizeBytes });
			result.freedBytes += verdict.record.sizeBytes;
			deps.logger?.info(
				`Removed workspace ${verdict.record.path} (${formatBytes(verdict.record.sizeBytes)}): ${verdict.reason}`
			);
			const pool = verdict.record.poolPath ? poolsByPath.get(verdict.record.poolPath) : undefined;
			if (pool && !poolHadKeep.has(pool.path)) emptiedPools.set(pool.path, pool);
		} else {
			result.kept.push({ record: verdict.record, reason: outcome.reason });
			if (outcome.error) result.errors.push(`${verdict.record.path}: ${outcome.reason}`);
			deps.logger?.warn(`Kept workspace ${verdict.record.path}: ${outcome.reason}`);
			if (verdict.record.poolPath) poolHadKeep.add(verdict.record.poolPath);
		}
	}

	const poolCandidates: WorkspacePoolVerdict[] = [...plan.removePools];
	if (deps.removeEmptiedPools !== false) {
		for (const pool of emptiedPools.values()) {
			if (poolHadKeep.has(pool.path)) continue;
			if (plan.removePools.some((verdict) => verdict.pool.path === pool.path)) continue;
			// An emptied pool still has to pass the rules the plan applies to
			// an orphan one: remote refreshed by this scan, no unpushed commit
			// on any local branch (re-proven live in `removePool`).
			if (!pool.remoteRefreshed || pool.unpushedCount !== 0) continue;
			poolCandidates.push({ pool, reason: 'emptied by this run' });
		}
	}
	for (const verdict of poolCandidates) {
		if (deps.signal?.aborted) {
			result.keptPools.push({ pool: verdict.pool, reason: 'reaper stopped before this pool' });
			continue;
		}
		const outcome = await removePool(verdict.pool, deps.signal);
		if (outcome.ok) {
			result.removedPools.push({ pool: verdict.pool, freedBytes: verdict.pool.sizeBytes });
			result.freedBytes += verdict.pool.sizeBytes;
			deps.logger?.info(
				`Removed repository pool ${verdict.pool.path} (${formatBytes(verdict.pool.sizeBytes)}): ${verdict.reason}`
			);
			await removeEmptyRepositoryRoot(verdict.pool.repositoryRoot);
		} else {
			result.keptPools.push({ pool: verdict.pool, reason: outcome.reason });
			if (outcome.error) result.errors.push(`${verdict.pool.path}: ${outcome.reason}`);
		}
	}
	return result;
}

type RemovalOutcome = { ok: true } | { ok: false; reason: string; error?: boolean };

/**
 * Remove one worktree: take the reaper's lease, re-read every piece of
 * evidence that can change cheaply, unlink the mount links, then hand the
 * removal to the provider. Anything that fails keeps the worktree and
 * says why; nothing here ever calls `fs.rm` on a checkout.
 */
async function removeWorktree(
	record: WorkspaceRecord,
	deps: {
		plugin: { teardown(handle: WorkspaceHandle): Promise<void> };
		isProcessAlive: (pid: number) => boolean;
		now: () => number;
		signal: AbortSignal | undefined;
	}
): Promise<RemovalOutcome> {
	if (!record.owned || !record.gitDir || !record.bindingKey || !record.branch || !record.poolPath) {
		return { ok: false, reason: 'ownership evidence incomplete' };
	}
	const gitDir = record.gitDir;
	const acquisition = await acquireWorkspaceLease(
		gitDir,
		{ version: 1, purpose: 'gc', pid: process.pid, since: new Date(deps.now()).toISOString() },
		deps.isProcessAlive
	).catch((error: unknown) => ({ acquired: false as const, failure: error }));
	if (!acquisition.acquired) {
		if ('heldBy' in acquisition) {
			return {
				ok: false,
				reason: `leased by pid ${acquisition.heldBy.pid} (${acquisition.heldBy.purpose === 'gc' ? 'reaper' : 'running job'})`
			};
		}
		return { ok: false, reason: `lease could not be taken: ${describeError(acquisition.failure)}`, error: true };
	}
	try {
		if (await exists(intentPath(record.poolPath, record.bindingKey))) {
			return { ok: false, reason: 'provisioning intent appeared' };
		}
		if ((await exists(join(gitDir, 'index.lock'))) || (await exists(join(gitDir, 'HEAD.lock')))) {
			return { ok: false, reason: 'git lock file appeared' };
		}
		const status = await gitOutput(['status', '--porcelain', '--untracked-files=all'], record.path, deps.signal);
		if (status === null) return { ok: false, reason: 'working tree state could not be re-read' };
		if (status.trim().length > 0) return { ok: false, reason: 'uncommitted changes appeared' };
		for (const link of await listMountLinks(record.path)) {
			await removeMountLink(link);
		}
		await deps.plugin.teardown({
			path: record.path,
			bindingKey: record.bindingKey,
			branch: record.branch,
			baseSha: record.headSha ?? '',
			reused: true
		});
		if (await exists(record.path)) {
			return { ok: false, reason: 'path still exists after Git removed the registration', error: true };
		}
		return { ok: true };
	} catch (error) {
		if (error instanceof Error && error.name === 'ProcessTreeTerminationError') throw error;
		return { ok: false, reason: `removal failed: ${describeError(error)}`, error: true };
	} finally {
		// Git deletes the gitdir with the worktree; when it is still there the
		// removal did not happen and the reaper's lease must not linger.
		if (await exists(gitDir)) await releaseWorkspaceLease(gitDir, process.pid, 'gc').catch(() => undefined);
	}
}

/**
 * Delete a bare pool only when Git lists nothing for it, no intent is
 * pending and no local branch carries a commit missing from every
 * remote-tracking ref — all re-proven right now, not from the scan.
 */
async function removePool(pool: WorkspacePoolRecord, signal: AbortSignal | undefined): Promise<RemovalOutcome> {
	try {
		const stats = await fs.lstat(pool.path);
		if (stats.isSymbolicLink() || !stats.isDirectory())
			return { ok: false, reason: 'pool is a link or not a directory' };
		if (!samePath(await fs.realpath(pool.path), pool.path))
			return { ok: false, reason: 'pool resolves through an alias' };
		if (!(await exists(join(pool.path, 'HEAD')))) return { ok: false, reason: 'not a bare Git repository' };
		const listed = await gitOutput(['worktree', 'list', '--porcelain'], pool.path, signal);
		if (listed === null) return { ok: false, reason: 'worktree registrations could not be re-read' };
		const registered = listed
			.split(/\r?\n/)
			.filter((line) => line.startsWith('worktree '))
			.map((line) => line.slice('worktree '.length))
			.filter((path) => !samePath(path, pool.path));
		if (registered.length > 0) return { ok: false, reason: `${registered.length} worktree(s) still registered` };
		let intents: string[] = [];
		try {
			intents = (await fs.readdir(join(pool.path, FLEET_WORKSPACE_INTENTS_DIR))).filter((name) =>
				name.endsWith('.json')
			);
		} catch {
			intents = [];
		}
		if (intents.length > 0) return { ok: false, reason: `${intents.length} provisioning intent(s) pending` };
		const counted = await gitOutput(['rev-list', '--count', '--branches', '--not', '--remotes'], pool.path, signal);
		if (counted === null || !/^\d+$/.test(counted.trim())) {
			return { ok: false, reason: 'local branch state could not be re-read' };
		}
		if (Number(counted.trim()) > 0) {
			return { ok: false, reason: `${counted.trim()} commit(s) on local branches not on any remote` };
		}
		await fs.rm(pool.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: `pool removal failed: ${describeError(error)}`, error: true };
	}
}

/** Drop the `repos/`, `worktrees/` and repository directories once they are empty — non-recursive, so a surprise stays. */
async function removeEmptyRepositoryRoot(repositoryRoot: string): Promise<void> {
	for (const child of ['repos', 'worktrees']) {
		await fs.rmdir(join(repositoryRoot, child)).catch(() => undefined);
	}
	await fs.rmdir(repositoryRoot).catch(() => undefined);
}

async function gitOutput(
	args: readonly string[],
	cwd: string,
	signal: AbortSignal | undefined
): Promise<string | null> {
	try {
		const { error, stdout } = await execFileWithVerifiedCancellation('git', args, {
			cwd,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
			windowsHide: true,
			maxBuffer: 16 * 1024 * 1024,
			...(signal ? { signal } : {})
		});
		if (error) return null;
		return String(stdout ?? '');
	} catch (error) {
		if (error instanceof Error && error.name === 'ProcessTreeTerminationError') throw error;
		return null;
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await fs.lstat(path);
		return true;
	} catch {
		return false;
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// timer
// ---------------------------------------------------------------------------

/** Cadence of the in-process reaper. Disk fills over days, not minutes. */
export const DEFAULT_WORKSPACE_REAPER_INTERVAL_MS = 6 * 60 * 60_000;
/** First run after start: lets the heartbeat and the first lease settle before the reaper fetches anything. */
export const DEFAULT_WORKSPACE_REAPER_INITIAL_DELAY_MS = 60_000;
/** Re-arm delay when a run was skipped because the worker was busy. */
export const WORKSPACE_REAPER_BUSY_RETRY_MS = 30 * 60_000;

export interface WorkspaceReaperTimerOptions {
	rootPath: string;
	policy: WorkspaceReapPolicy;
	scheduler?: Scheduler;
	intervalMs?: number;
	initialDelayMs?: number;
	logger?: Logger;
	/** Bindings the running provisioner holds; belt and braces over the on-disk lease. */
	activeBindings?: () => ReadonlySet<string>;
	/** True while jobs run: the run is skipped and retried later rather than competing for the uplink. */
	isBusy?: () => boolean;
	scan?: typeof scanWorkspaceRoot;
	reap?: typeof runWorkspaceReap;
	now?: () => number;
}

export interface WorkspaceReaperTimer {
	stop(): void;
	/** Run a cycle now, outside the cadence. Null when one is already running or the timer is stopped. */
	runNow(): Promise<WorkspaceReapResult | null>;
}

/**
 * Run the reaper shortly after start and then on a cadence, in the worker
 * process, with the injected scheduler so tests never wait on wall time.
 */
export function startWorkspaceReaperTimer(options: WorkspaceReaperTimerOptions): WorkspaceReaperTimer {
	const scheduler = options.scheduler ?? systemScheduler;
	const intervalMs = options.intervalMs ?? DEFAULT_WORKSPACE_REAPER_INTERVAL_MS;
	const scan = options.scan ?? scanWorkspaceRoot;
	const reap = options.reap ?? runWorkspaceReap;
	const now = options.now ?? (() => Date.now());
	let stopped = false;
	let timer: unknown = null;
	let inFlight: Promise<WorkspaceReapResult | null> | null = null;

	const arm = (delay: number): void => {
		if (stopped) return;
		timer = scheduler.setTimeout(() => {
			timer = null;
			void cycle().then((result) =>
				arm(result === null && !stopped ? WORKSPACE_REAPER_BUSY_RETRY_MS : intervalMs)
			);
		}, delay);
	};

	const cycle = async (): Promise<WorkspaceReapResult | null> => {
		if (stopped || inFlight) return null;
		if (options.isBusy?.()) return null;
		inFlight = (async () => {
			try {
				const inventory = await scan(options.rootPath, { refreshRemote: true, now });
				const plan = planWorkspaceReap(inventory, options.policy, now(), options.activeBindings?.());
				const result = await reap(plan, { logger: options.logger, now });
				options.logger?.info(
					`Workspace reaper: removed ${result.removed.length} worktree(s) and ${result.removedPools.length} pool(s) (${formatBytes(
						result.freedBytes
					)} freed), kept ${result.kept.length}${result.errors.length > 0 ? `, ${result.errors.length} error(s)` : ''}`
				);
				return result;
			} catch (error) {
				options.logger?.warn(`Workspace reaper failed: ${describeError(error)}`);
				return null;
			} finally {
				inFlight = null;
			}
		})();
		return inFlight;
	};

	arm(options.initialDelayMs ?? DEFAULT_WORKSPACE_REAPER_INITIAL_DELAY_MS);
	return {
		stop: () => {
			stopped = true;
			if (timer !== null) {
				scheduler.clearTimeout(timer);
				timer = null;
			}
		},
		runNow: () => cycle()
	};
}
