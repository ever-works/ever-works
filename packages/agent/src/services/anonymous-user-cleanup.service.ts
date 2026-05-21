import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { UserRepository } from '../database';

/**
 * Injection token for the active storage backend (an `IStoragePlugin`).
 * Provided by the API / trigger module that boots the cleanup task.
 * Declared as a string token because `IStoragePlugin` is a TypeScript
 * interface erased at runtime — Nest has nothing else to resolve.
 *
 * Optional in this service: when no provider binds it, storage GC
 * is skipped (the user row still gets deleted; only the file cleanup
 * is suppressed). Tests can leave it unset; cron-driven cleanup in
 * prod / dev / stage should wire it.
 */
export const ANON_CLEANUP_STORAGE_PLUGIN = 'ANON_CLEANUP_STORAGE_PLUGIN';

export interface StorageGcBackend {
    deleteAllByOwner?(ownerId: string): Promise<{ deleted: number }>;
    readonly providerName?: string;
}

export interface AnonymousUserCleanupSummary {
    scanned: number;
    deleted: number;
    failed: number;
    failures: Array<{ userId: string; error: string }>;
    /** Total number of storage objects removed across all expired users. */
    storageDeleted: number;
    /** Number of users whose storage-GC step errored (separate from row-delete failures). */
    storageFailed: number;
}

/**
 * EW-617 G2 / EW-637 follow-up — nightly purge of expired anonymous users.
 *
 * The companion `anonymous-user-cleanup` Trigger.dev schedule (in
 * `packages/tasks/src/tasks/trigger/`) calls `purgeExpired()` once a day.
 * Each user row deletion cascades to their Works via the existing
 * `work.user` ON DELETE CASCADE. Their uploaded files are NOT cascaded
 * by the DB — they live in the storage backend — so we ask the active
 * storage plugin to delete every key owned by the user *before* the row
 * goes away. Order matters: row-delete first would lose the userId we
 * need to derive the prefix.
 *
 * The service is intentionally idempotent and resilient: a single
 * row-delete or storage-delete failure logs + continues so one stuck
 * user doesn't block the rest of the batch.
 */
@Injectable()
export class AnonymousUserCleanupService {
    private readonly logger = new Logger(AnonymousUserCleanupService.name);

    constructor(
        private readonly userRepository: UserRepository,
        @Optional()
        @Inject(ANON_CLEANUP_STORAGE_PLUGIN)
        private readonly storage?: StorageGcBackend,
    ) {}

    async purgeExpired(now: Date = new Date()): Promise<AnonymousUserCleanupSummary> {
        const expired = await this.userRepository.findExpiredAnonymous(now);
        const summary: AnonymousUserCleanupSummary = {
            scanned: expired.length,
            deleted: 0,
            failed: 0,
            failures: [],
            storageDeleted: 0,
            storageFailed: 0,
        };

        if (expired.length === 0) {
            return summary;
        }

        this.logger.log(`anonymous-user-cleanup found ${expired.length} expired user(s)`);
        const storageGcAvailable = typeof this.storage?.deleteAllByOwner === 'function';
        if (!storageGcAvailable) {
            this.logger.warn(
                `anonymous-user-cleanup: no storage plugin wired (or plugin lacks deleteAllByOwner) — user rows will be deleted but uploaded files will not be GC'd. Wire ANON_CLEANUP_STORAGE_PLUGIN to fix.`,
            );
        }

        for (const user of expired) {
            // Step 1: GC the user's uploaded files. Best-effort — we log
            // and count failures but still delete the user row so the
            // TTL contract holds.
            if (storageGcAvailable) {
                try {
                    const out = await this.storage!.deleteAllByOwner!(user.id);
                    summary.storageDeleted += out.deleted;
                } catch (cause) {
                    summary.storageFailed += 1;
                    const error = cause instanceof Error ? cause.message : String(cause);
                    this.logger.error(
                        `anonymous-user-cleanup: storage GC failed for ${user.id} (will still delete user row): ${error}`,
                    );
                }
            }

            // Step 2: delete the user row (cascades work / refresh tokens / etc).
            try {
                await this.userRepository.deleteAnonymous(user.id);
                summary.deleted += 1;
            } catch (cause) {
                summary.failed += 1;
                const error = cause instanceof Error ? cause.message : String(cause);
                summary.failures.push({ userId: user.id, error });
                this.logger.error(`Failed to delete expired anonymous user ${user.id}: ${error}`);
            }
        }

        this.logger.log(
            `anonymous-user-cleanup deleted=${summary.deleted} failed=${summary.failed} of ${summary.scanned}; storageDeleted=${summary.storageDeleted} storageFailed=${summary.storageFailed}`,
        );

        return summary;
    }
}
