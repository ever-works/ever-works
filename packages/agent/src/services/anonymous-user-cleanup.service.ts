import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    MemoryFolderRepository,
    OrganizationRepository,
    TenantRepository,
    UserRepository,
} from '../database';

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
 * Knowledge library — an anonymous account can belong to an Organization
 * and create its shared folders. A shared folder records its creator in
 * `memory_folders.userId`, whose FK is `ON DELETE CASCADE`, so deleting
 * the row would delete the Organization's folders with it. Before the row
 * goes, those folders are handed to another member of the Organization
 * (see {@link handOverSharedFolders}); only when nobody else is left does
 * the cascade take them, along with the Organization's last member.
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
        // Optional so every existing wiring (and the unit specs) still
        // constructs; `DatabaseModule` provides all three in production.
        @Optional() private readonly memoryFolders?: MemoryFolderRepository,
        @Optional() private readonly organizations?: OrganizationRepository,
        @Optional() private readonly tenants?: TenantRepository,
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
            // Step 0: hand the user's shared folders to another member of
            // each Organization. A failure skips this user for the run —
            // deleting the row anyway would cascade the folders away — and
            // the next nightly run retries.
            try {
                await this.handOverSharedFolders(user.id);
            } catch (cause) {
                summary.failed += 1;
                const error = cause instanceof Error ? cause.message : String(cause);
                summary.failures.push({ userId: user.id, error });
                this.logger.error(
                    `anonymous-user-cleanup: shared-folder hand-over failed for ${user.id} (user kept for the next run): ${error}`,
                );
                continue;
            }

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

    /**
     * Re-attribute every shared folder `userId` created to another member of
     * the same Organization, so the `memory_folders.userId` cascade does not
     * delete it with the account.
     *
     * The successor is the Organization's Tenant owner — the account the
     * Organization lives under, and the only elevated role the schema has
     * (`OrganizationMembershipService.ensureAdmin` is membership today) —
     * unless that is the user being deleted; then another member of the
     * Tenant (`UserRepository.findOtherTenantMember`). With no other member
     * the folders are left to the cascade: the Organization has lost its
     * last member too.
     *
     * A no-op when the folder repositories are not wired.
     */
    private async handOverSharedFolders(userId: string): Promise<void> {
        if (!this.memoryFolders || !this.organizations || !this.tenants) return;

        const organizationIds =
            await this.memoryFolders.listOrganizationIdsWithFoldersCreatedBy(userId);
        for (const organizationId of organizationIds) {
            const successorId = await this.findSharedFolderSuccessor(organizationId, userId);
            if (!successorId) {
                this.logger.log(
                    `anonymous-user-cleanup: ${userId} was the last member of organization ${organizationId}; its shared folders go with the account`,
                );
                continue;
            }
            const moved = await this.memoryFolders.reassignOrganizationFolders(
                organizationId,
                userId,
                successorId,
            );
            this.logger.log(
                `anonymous-user-cleanup: handed ${moved} shared folder(s) of organization ${organizationId} from ${userId} to ${successorId}`,
            );
        }
    }

    private async findSharedFolderSuccessor(
        organizationId: string,
        userId: string,
    ): Promise<string | null> {
        const organization = await this.organizations!.findById(organizationId);
        if (!organization?.tenantId) return null;

        const tenant = await this.tenants!.findById(organization.tenantId);
        if (tenant && tenant.ownerUserId !== userId) {
            const owner = await this.userRepository.findById(tenant.ownerUserId);
            if (owner && owner.tenantId === organization.tenantId) {
                return owner.id;
            }
        }

        const member = await this.userRepository.findOtherTenantMember(
            organization.tenantId,
            userId,
        );
        return member?.id ?? null;
    }
}
