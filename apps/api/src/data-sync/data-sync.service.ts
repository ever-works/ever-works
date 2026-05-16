import { Injectable, Logger } from '@nestjs/common';
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
 * call, activity-feed writes, and `isLocked` body all throw `not yet
 * implemented` so dependent phases (4-6) can import the symbols and
 * compile. The actual three-gate body lands in the follow-up `feat:`
 * commit for Phase 3 — kept separate so the change is reviewable.
 */
@Injectable()
export class DataSyncService {
    private readonly logger = new Logger(DataSyncService.name);

    constructor(private readonly taskLockService: DistributedTaskLockService) {}

    /**
     * Run one sync attempt for `workId` with three ordered gates inside
     * the lock. See class-level JSDoc and spec §5.4 for the contract.
     *
     * Returns the terminal outcome the caller will log in the activity
     * feed. Never throws; failures inside the lock return
     * `{ status: 'failed', ... }` and write the retry-backoff cache
     * entry so the dispatcher backs off naturally.
     *
     * TODO(EW-628 Phase 3 follow-up): implement the three gates per
     * `plan.md` §6 pseudo-code. The signature is final; only the body
     * is missing.
     */
    async runDataSync(workId: string, source: SyncSource): Promise<DataSyncOutcome> {
        this.logger.warn(
            `DataSyncService.runDataSync stub called for work=${workId} source=${source} — gate logic lands in EW-628 Phase 3 follow-up`,
        );
        // Voiding the unused-arg lints; the real impl will use these.
        void this.taskLockService;
        throw new Error('DataSyncService.runDataSync not yet implemented (EW-628 Phase 3)');
    }

    /**
     * Peek whether a `data-sync:<workId>` lock is currently held. Used
     * by the schedule dispatcher to defer generation runs while a sync
     * is mid-flight (spec §5.5).
     *
     * TODO(EW-628 Phase 3 follow-up): probe the `cache_entries` row
     * `task-lock:data-sync:<workId>` directly so this stays O(1).
     */
    async isLocked(workId: string): Promise<boolean> {
        this.logger.debug(`DataSyncService.isLocked stub for work=${workId}`);
        // Conservative: return false until the gate logic is real, so the
        // generation dispatcher's behaviour doesn't change in this commit.
        return false;
    }
}
