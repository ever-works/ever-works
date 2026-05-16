import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CacheEntry } from '@ever-works/agent/entities';
import { CACHE_MANAGER, Cache, DistributedTaskLockService } from '@ever-works/agent/cache';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { ActivityActionType, ActivityStatus, GenerateStatusType } from '@ever-works/agent/entities';
import { WorkRepository } from '@ever-works/agent/database';
import { MarkdownGeneratorService } from '@ever-works/agent/generators';
import { config } from '@ever-works/agent/config';
import type {
    SyncEventErrorClass,
    SyncEventFailed,
    SyncEventPayload,
    SyncEventSkipped,
    SyncEventSuccess,
} from '@ever-works/contracts/api';
import type {
    DataSyncOutcome,
    DataSyncSuccessStats,
    SyncReason,
    SyncSource,
} from './data-sync.types';

/**
 * Owns the per-Work sync run lifecycle for EW-628 (data-repo instant-sync).
 *
 * Spec: `docs/specs/features/data-repo-instant-sync/spec.md` §5.4 and §5.5.
 * Plan: `docs/specs/features/data-repo-instant-sync/plan.md` §6 (pseudo-code).
 *
 * The public surface is intentionally small:
 *
 * - `runDataSync(workId, source)` — entry called by both the EW-628
 *   dispatcher (Phase 4) and the force-sync endpoint (Phase 6). Acquires
 *   the `data-sync:<workId>` lock via {@link DistributedTaskLockService}
 *   and runs three gates in order inside the callback:
 *
 *     1. Retry-backoff gate — short-circuits if a recent failure wrote
 *        `data-sync:retry-after:<workId>` to the cache.
 *     2. Pipeline-RUNNING gate — defers when the full generation
 *        pipeline is mid-flight; rate-limits the `generation-in-progress`
 *        skip row via `data-sync:gen-in-progress-noise:<workId>` so a
 *        long generation run does not drown the activity feed.
 *     3. Render gate — calls
 *        {@link MarkdownGeneratorService.syncFromDataRepo} (Phase 2 entry),
 *        then UPDATEs `lastSyncedDataRepoSha`, clears
 *        `pendingSyncRequestedAt`, stamps `lastPolledAt`, and writes a
 *        `data_sync_success` activity row.
 *
 *   Never throws — failures are caught, converted to `data_sync_failed`
 *   rows, and a short retry-backoff is set in the cache so the dispatcher
 *   does not hot-loop a broken Work. The terminal `DataSyncOutcome`
 *   returned by this method is what the force-sync controller and the
 *   dispatcher surface to their callers.
 *
 * - `isLocked(workId)` — non-mutating peek the schedule dispatcher uses
 *   to skip Works whose sync is currently in flight. Symmetric mutex;
 *   the generation side defers when this returns true, sync side checks
 *   `generateStatus.status === GENERATING` inside its lock. See spec §5.5.
 *
 * Lock-key format (matches {@link DistributedTaskLockService} convention):
 *
 *   - `runExclusive` is called with `data-sync:<workId>` →
 *     `DistributedTaskLockService.buildKey` prefixes with `task-lock:` →
 *     full `cache_entries.key` is `task-lock:data-sync:<workId>`.
 *
 * `isLocked` peeks that same row directly so it stays O(1) (single
 * primary-key lookup) and does not compete for the lock itself.
 */
@Injectable()
export class DataSyncService {
    private readonly logger = new Logger(DataSyncService.name);

    constructor(
        private readonly taskLockService: DistributedTaskLockService,
        @InjectRepository(CacheEntry)
        private readonly cacheEntryRepository: Repository<CacheEntry>,
        @Inject(CACHE_MANAGER) private readonly cache: Cache,
        private readonly activityLogService: ActivityLogService,
        private readonly workRepository: WorkRepository,
        private readonly markdownGenerator: MarkdownGeneratorService,
    ) {}

    /**
     * Run one sync attempt for `workId` with three ordered gates inside
     * the lock. See class-level JSDoc and spec §5.4 for the contract.
     *
     * Never throws — caller gets one of:
     *   - `{ status: 'success', stats }`
     *   - `{ status: 'skipped', reason }` (5 documented reasons)
     *   - `{ status: 'failed', errorClass, errorTail }`
     */
    async runDataSync(workId: string, source: SyncSource): Promise<DataSyncOutcome> {
        const lockTtlMs = config.subscriptions.dataSync.getLockTtlSeconds() * 1000;
        const lockResult = await this.taskLockService.runExclusive(
            `data-sync:${workId}`,
            async () => this.runGates(workId, source),
            {
                ttlMs: lockTtlMs,
                onLocked: () => {
                    void this.emitSkipped(workId, source, 'sync-in-progress');
                },
            },
        );

        if (!lockResult.acquired) {
            return { status: 'skipped', reason: 'sync-in-progress' };
        }

        // `runGates` never throws (every branch returns a DataSyncOutcome),
        // so `result` is guaranteed defined on the acquired path.
        return lockResult.result as DataSyncOutcome;
    }

    /**
     * Peek whether the per-Work `data-sync:<workId>` lock is currently
     * held by reading `cache_entries` directly. O(1) primary-key lookup
     * so the schedule dispatcher can call this for every eligible Work
     * on each tick without flooding the lock service.
     *
     * Returns `true` only when a non-expired row exists. `expiresAt` is
     * stored as bigint epoch-ms by {@link DistributedTaskLockService};
     * a `null` value means the lock has no TTL (defensive — never
     * written by the current code path, but treated as held to err on
     * the side of safety).
     */
    async isLocked(workId: string): Promise<boolean> {
        const lockKey = `task-lock:data-sync:${workId}`;
        const row = await this.cacheEntryRepository.findOne({
            where: { key: lockKey },
            select: ['key', 'expiresAt'],
        });
        if (!row) {
            return false;
        }
        if (row.expiresAt === null) {
            return true;
        }
        return row.expiresAt > Date.now();
    }

    /**
     * The three-gate body that runs INSIDE the lock callback. Split out
     * so `runDataSync` keeps the acquire / onLocked branches readable.
     */
    private async runGates(workId: string, source: SyncSource): Promise<DataSyncOutcome> {
        // Gate 1 — retry-backoff after a recent failure. Without this gate,
        // the dispatcher re-enqueues every minute and we re-run the broken
        // render every tick. The cache entry's TTL drives when we retry.
        const retryAfterKey = `data-sync:retry-after:${workId}`;
        const backoff = await this.cache.get<string>(retryAfterKey);
        if (backoff) {
            await this.emitSkipped(workId, source, 'retry-backoff');
            return { status: 'skipped', reason: 'retry-backoff' };
        }

        // Gate 2 — generation pipeline already running. Rate-limit the
        // skip row via `gen-in-progress-noise` so a long generation run
        // does not flood the activity feed with ~120 skip rows.
        const work = await this.workRepository.findById(workId);
        if (!work) {
            // Work was deleted between dispatcher enqueue and lock acquire.
            // Surface as `failed` with a stable error class so dashboards
            // can pivot on it without parsing free-form text.
            await this.emitFailed(workId, source, 'work-not-found', `Work ${workId} not found`);
            return {
                status: 'failed',
                errorClass: 'work-not-found',
                errorTail: tailString(`Work ${workId} not found`),
            };
        }
        if (work.generateStatus?.status === GenerateStatusType.GENERATING) {
            const noiseKey = `data-sync:gen-in-progress-noise:${workId}`;
            const recentNoise = await this.cache.get<string>(noiseKey);
            if (!recentNoise) {
                await this.emitSkipped(workId, source, 'generation-in-progress');
                await this.cache.set(
                    noiseKey,
                    '1',
                    config.subscriptions.dataSync.getGenInProgressNoiseWindowMs(),
                );
            }
            return { status: 'skipped', reason: 'generation-in-progress' };
        }

        // Gate 3 — render. The owner user comes off the work row (eager
        // `relations: ['user']` in `WorkRepository.findById`).
        const startedAt = Date.now();
        try {
            const stats = await this.markdownGenerator.syncFromDataRepo(work, work.user, {});
            const successStats: DataSyncSuccessStats = {
                beforeSha: stats.beforeSha,
                afterSha: stats.afterSha,
                filesChanged: stats.filesChanged,
                durationMs: stats.durationMs ?? Date.now() - startedAt,
            };

            await this.workRepository.update(workId, {
                ...(successStats.afterSha ? { lastSyncedDataRepoSha: successStats.afterSha } : {}),
                pendingSyncRequestedAt: null,
                lastPolledAt: new Date(),
            });

            // Clear the gen-in-progress noise window so the next blocked
            // generation run can emit again immediately.
            await this.cache.del(`data-sync:gen-in-progress-noise:${workId}`);

            await this.emitSuccess(workId, source, successStats);
            return { status: 'success', stats: successStats };
        } catch (err) {
            const errorClass = classifyError(err);
            const errorTail = tailString(extractErrorMessage(err));

            await this.emitFailed(workId, source, errorClass, errorTail);

            // pendingSyncRequestedAt intentionally NOT cleared — the
            // dispatcher's next tick will retry once the backoff expires.
            await this.cache.set(
                `data-sync:retry-after:${workId}`,
                '1',
                config.subscriptions.dataSync.getRetryBackoffSeconds() * 1000,
            );

            return { status: 'failed', errorClass, errorTail };
        }
    }

    /**
     * Resolve a userId for the activity-log row. Synthetic system events
     * (e.g. Work not found) cannot use `work.user.id` because we never
     * loaded the work. Use the system marker `'system'` so listeners can
     * filter / route accordingly.
     */
    private async resolveActor(workId: string): Promise<string> {
        const work = await this.workRepository.findById(workId);
        return work?.user?.id ?? 'system';
    }

    /**
     * Single emit point — types the `details` payload as the canonical
     * `SyncEventPayload` discriminated union from `@ever-works/contracts`
     * so the API emitter and the web `SyncEventRow` renderer cannot
     * drift. Resolves the actor user once per emit (so a Gate 1
     * short-circuit row still gets the right userId attribution).
     *
     * Catches and warns on its own — activity-log failures must NEVER
     * propagate to the caller, since they cannot rescue a missed row.
     */
    private async emit(workId: string, payload: SyncEventPayload): Promise<void> {
        try {
            const userId = await this.resolveActor(workId);
            const { actionType, status, action, summary } = describePayload(payload);
            await this.activityLogService.log({
                userId,
                workId,
                actionType,
                action,
                status,
                summary,
                details: payload as unknown as Record<string, unknown>,
            });
        } catch (err) {
            this.logger.warn(
                `Failed to write ${payload.kind} activity row for work=${workId}: ${(err as Error).message ?? err}`,
            );
        }
    }

    private emitSuccess(workId: string, source: SyncSource, stats: DataSyncSuccessStats) {
        const payload: SyncEventSuccess = {
            kind: 'success',
            source,
            beforeSha: stats.beforeSha,
            afterSha: stats.afterSha,
            filesChanged: stats.filesChanged,
            durationMs: stats.durationMs,
        };
        return this.emit(workId, payload);
    }

    private emitSkipped(workId: string, source: SyncSource, reason: SyncReason) {
        const payload: SyncEventSkipped = {
            kind: 'skipped',
            source,
            reason,
        };
        return this.emit(workId, payload);
    }

    private emitFailed(
        workId: string,
        source: SyncSource,
        errorClass: SyncEventErrorClass,
        errorTail: string,
    ) {
        const payload: SyncEventFailed = {
            kind: 'failed',
            source,
            errorClass,
            errorTail,
        };
        return this.emit(workId, payload);
    }
}

/**
 * Project the typed `SyncEventPayload` into the legacy CreateActivityLogDto
 * fields the `activity_log` row carries — keeps the JSON `details` shape
 * canonical while letting the existing summary / actionType / status
 * machinery feed dashboards that pivot on those columns directly.
 */
function describePayload(payload: SyncEventPayload): {
    actionType: ActivityActionType;
    status: ActivityStatus;
    action: string;
    summary: string;
} {
    switch (payload.kind) {
        case 'success':
            return {
                actionType: ActivityActionType.DATA_SYNC_SUCCESS,
                status: ActivityStatus.COMPLETED,
                action: 'data-sync.success',
                summary: `Synced data repo (${payload.filesChanged} file${payload.filesChanged === 1 ? '' : 's'} updated)`,
            };
        case 'skipped':
            return {
                actionType: ActivityActionType.DATA_SYNC_SKIPPED,
                status: ActivityStatus.CANCELLED,
                action: 'data-sync.skipped',
                summary: `Sync skipped: ${payload.reason}`,
            };
        case 'failed':
            return {
                actionType: ActivityActionType.DATA_SYNC_FAILED,
                status: ActivityStatus.FAILED,
                action: 'data-sync.failed',
                summary: `Sync failed: ${payload.errorClass}`,
            };
    }
}

/**
 * Map a thrown error to a stable, low-cardinality `errorClass` string the
 * activity feed renders verbatim and dashboards pivot on. The set is
 * deliberately small per spec §5.6 — adding a new class is a deliberate
 * schema decision, not an autopilot fallback.
 */
function classifyError(err: unknown): SyncEventErrorClass {
    const message = extractErrorMessage(err).toLowerCase();

    if (/\b(404|not found|enotfound|getaddrinfo)\b/.test(message)) {
        return 'data-repo-unreachable';
    }
    if (/\b(403|forbidden|permission denied)\b/.test(message)) {
        return 'data-repo-unreachable';
    }
    if (/\b(reject|non-fast-forward|protected branch|merge conflict)\b/.test(message)) {
        return 'main-repo-push-rejected';
    }
    if (/\b(timeout|timed out|etimedout)\b/.test(message)) {
        return 'timeout';
    }
    return 'unknown';
}

function extractErrorMessage(err: unknown): string {
    if (typeof err === 'string') {
        return err;
    }
    if (err && typeof err === 'object') {
        const e = err as { stderr?: unknown; message?: unknown };
        if (typeof e.stderr === 'string' && e.stderr.length > 0) {
            return e.stderr;
        }
        if (typeof e.message === 'string') {
            return e.message;
        }
    }
    return String(err);
}

function tailString(input: string, max = 200): string {
    if (!input) return '';
    return input.length <= max ? input : input.slice(-max);
}
