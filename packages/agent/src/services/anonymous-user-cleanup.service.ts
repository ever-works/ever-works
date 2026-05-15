import { Injectable, Logger } from '@nestjs/common';
import { UserRepository } from '../database';

export interface AnonymousUserCleanupSummary {
    scanned: number;
    deleted: number;
    failed: number;
    failures: Array<{ userId: string; error: string }>;
}

/**
 * EW-617 G2 — nightly purge of expired anonymous users.
 *
 * The companion `anonymous-user-cleanup` Trigger.dev schedule (in
 * `packages/tasks/src/tasks/trigger/`) calls `purgeExpired()` once a day.
 * Each user row deletion cascades to their Works via the existing
 * `work.user` ON DELETE CASCADE.
 *
 * The service is intentionally idempotent and resilient: a single row
 * delete failure logs + continues so one stuck row doesn't block the rest
 * of the batch.
 */
@Injectable()
export class AnonymousUserCleanupService {
    private readonly logger = new Logger(AnonymousUserCleanupService.name);

    constructor(private readonly userRepository: UserRepository) {}

    async purgeExpired(now: Date = new Date()): Promise<AnonymousUserCleanupSummary> {
        const expired = await this.userRepository.findExpiredAnonymous(now);
        const summary: AnonymousUserCleanupSummary = {
            scanned: expired.length,
            deleted: 0,
            failed: 0,
            failures: [],
        };

        if (expired.length === 0) {
            return summary;
        }

        this.logger.log(`anonymous-user-cleanup found ${expired.length} expired user(s)`);

        for (const user of expired) {
            try {
                await this.userRepository.deleteAnonymous(user.id);
                summary.deleted += 1;
            } catch (cause) {
                summary.failed += 1;
                const error = cause instanceof Error ? cause.message : String(cause);
                summary.failures.push({ userId: user.id, error });
                this.logger.error(
                    `Failed to delete expired anonymous user ${user.id}: ${error}`,
                );
            }
        }

        this.logger.log(
            `anonymous-user-cleanup deleted=${summary.deleted} failed=${summary.failed} of ${summary.scanned}`,
        );

        return summary;
    }
}
