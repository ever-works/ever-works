import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheEntry } from '@ever-works/agent/entities';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
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
 * - provide `DistributedTaskLockService` directly (no agent-side module
 *   import needed),
 * - expose `DataSyncService` to other API modules (Phase 6 force-sync
 *   controller, Phase 4 dispatcher entry, Phase 5 webhook handler).
 *
 * Phase 3 of EW-628 lands this surface; the gate logic itself follows
 * in a separate commit.
 */
@Module({
    imports: [TypeOrmModule.forFeature([CacheEntry])],
    controllers: [DataSyncController],
    providers: [DataSyncService, DistributedTaskLockService],
    exports: [DataSyncService],
})
export class DataSyncModule {}
