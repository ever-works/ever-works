import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheEntry } from '@ever-works/agent/entities';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import { DatabaseModule } from '@ever-works/agent/database';
import { MarkdownGeneratorModule } from '@ever-works/agent/generators';
import { DataSyncController } from './data-sync.controller';
import { DataSyncService } from './data-sync.service';

/**
 * Data-repo instant-sync feature module (EW-628).
 *
 * Spec: `docs/specs/features/data-repo-instant-sync/spec.md`.
 *
 * Wires the per-Work mutex on the existing `cache_entries` table per the
 * canonical pattern documented in
 * `docs/agent-services/distributed-task-lock.md#module-wiring`:
 *
 * - import `CacheEntry` via `TypeOrmModule.forFeature` so the lock
 *   service has its repository,
 * - provide `DistributedTaskLockService` directly,
 * - pull in `DatabaseModule` for `WorkRepository` (used by `runDataSync`
 *   to read `Work.generateStatus` for the pipeline-RUNNING gate and to
 *   persist `lastSyncedDataRepoSha` / clear `pendingSyncRequestedAt` /
 *   stamp `lastPolledAt` on success),
 * - pull in `ActivityLogModule` for `ActivityLogService` (writes the
 *   `data_sync_*` rows the activity feed renders),
 * - pull in `MarkdownGeneratorModule` for `MarkdownGeneratorService`
 *   (Phase 2 `syncFromDataRepo` entry that does the actual render +
 *   push to the main repo),
 * - expose `DataSyncService` to other API modules so the Phase 4
 *   dispatcher and Phase 5 webhook handler can converge on it.
 *
 * The Nest cache manager (`CACHE_MANAGER` / `Cache`) is registered as a
 * global module by `CacheFactory.TypeORM` in `api.module.ts`, so the
 * service injects it directly without an explicit import here.
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([CacheEntry]),
        DatabaseModule,
        ActivityLogModule,
        MarkdownGeneratorModule,
    ],
    controllers: [DataSyncController],
    providers: [DataSyncService, DistributedTaskLockService],
    exports: [DataSyncService],
})
export class DataSyncModule {}
