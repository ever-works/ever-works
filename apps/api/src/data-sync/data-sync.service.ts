import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CacheEntry } from '@ever-works/agent/entities';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import type { DataSyncOutcome, SyncSource } from './data-sync.types';

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
 *        `data-sync:retry-after:<workId>` to `cache_entries`.
 *     2. Pipeline-RUNNING gate — defers when the full generation
 *        pipeline is mid-flight; rate-limits the `generation-in-progress`
 *        skip row via `data-sync:gen-in-progress-noise:<workId>` so a
 *        long generation run doesn't drown the activity feed.
 *     3. Render gate — calls
 *        `MarkdownGeneratorService.syncFromDataRepo` (Phase 2 entry).
 *
 * - `isLocked(workId)` — non-mutating peek the schedule dispatcher
 *   (`WorkScheduleDispatcherService.dispatchDue`) uses to skip Works
 *   whose sync is currently in flight. Symmetric mutex; the generation
 *   side defers when this returns true, sync side checks pipelineStatus
 *   inside its lock. See spec §5.5.
 *
 * NOTE: Phase 3 (this commit) lands the module + service surface and
 * wires `DistributedTaskLockService`. The gate logic, MarkdownGenerator
 * call, and activity-feed writes follow in EW-628 G3.
 *
 * Lock-key format (matches {@link DistributedTaskLockService} convention):
 *
 *   - `runExclusive` is called with `data-sync:<workId>` →
 *     `DistributedTaskLockService.buildKey` prefixes with `task-lock:` →
 *     full `cache_entries.key` is `task-lock:data-sync:<workId>`.
 *
 * `isLocked` peeks that same row directly so it stays O(1) (single
 * primary-key lookup) and doesn't compete for the lock itself.
 */
@Injectable()
export class DataSyncService {
    private readonly logger = new Logger(DataSyncService.name);

    constructor(
        private readonly taskLockService: DistributedTaskLockService,
        @InjectRepository(CacheEntry)
        private readonly cacheEntryRepository: Repository<CacheEntry>,
    ) {}

    /**
     * Run one sync attempt for `workId` with three ordered gates inside
     * the lock. See class-level JSDoc and spec §5.4 for the contract.
     *
     * Returns the terminal outcome the caller will log in the activity
     * feed. Never throws; failures inside the lock return
     * `{ status: 'failed', ... }` and write the retry-backoff cache
     * entry so the dispatcher backs off naturally.
     *
     * TODO(EW-628 G3): implement the three gates per `plan.md` §6
     * pseudo-code. The signature is final; only the body is missing.
     */
    async runDataSync(workId: string, source: SyncSource): Promise<DataSyncOutcome> {
        this.logger.warn(
            `DataSyncService.runDataSync stub called for work=${workId} source=${source} — gate logic lands in EW-628 G3`,
        );
        // Voiding the unused-arg lints; the real impl will use these.
        void this.taskLockService;
        throw new Error('DataSyncService.runDataSync not yet implemented (EW-628 G3)');
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
     *
     * Used by `WorkScheduleDispatcherService.dispatchDue` per spec §5.5
     * to defer a full-generation tick on a Work whose data-sync is
     * mid-flight.
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
}
