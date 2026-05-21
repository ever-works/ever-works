import { schedules } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import {
    AnonymousUserCleanupService,
    ANON_CLEANUP_STORAGE_PLUGIN,
    type StorageGcBackend,
} from '@ever-works/agent/services';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';

/**
 * EW-617 G2 / EW-637 follow-up — nightly purge of expired anonymous users
 * AND their uploaded files.
 *
 * Runs every day at 03:17 UTC (off-peak, deliberately staggered from the
 * other scheduled jobs to avoid a coincident burst on the database). The
 * service consults `users.is_anonymous=true AND users.anonymous_expires_at <
 * now`, then:
 *
 *   1. Asks the active storage backend to delete every file owned by the
 *      user (via `IStoragePlugin.deleteAllByOwner`). Without this step,
 *      the row goes away but files leak forever on disk / S3 / GitHub.
 *   2. Deletes the user row; cascade on `work.userId` removes orphan Works.
 *
 * The storage backend is resolved via `getActiveStorageBackend()` —
 * dynamically imported so the agent/tasks package doesn't take a hard
 * dependency on the API process. The factory throws if storage isn't
 * configured, in which case we still want the user-row cleanup to run —
 * so we resolve the backend in a try/catch and pass `undefined` on
 * failure (the cleanup service handles that gracefully and logs).
 */
async function resolveStorageBackend(): Promise<StorageGcBackend | undefined> {
    try {
        // Resolved by path because @ever-works/agent shouldn't transitively
        // depend on apps/api types — the import is purely runtime.
        type FactoryModule = {
            getActiveStorageBackend: () => Promise<StorageGcBackend>;
        };
        const mod: FactoryModule = (await import(
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-expect-error — resolved at runtime from the API workspace
            '@src/uploads/storage-backend.factory'
        )) as FactoryModule;
        return await mod.getActiveStorageBackend();
    } catch {
        return undefined;
    }
}

@Module({
    imports: [TriggerInternalModule],
    providers: [
        {
            provide: ANON_CLEANUP_STORAGE_PLUGIN,
            useFactory: resolveStorageBackend,
        },
    ],
})
class AnonymousUserCleanupTaskModule {}

export const anonymousUserCleanupTask = schedules.task({
    id: 'anonymous-user-cleanup',
    cron: '17 3 * * *',
    run: async () => {
        const appContext = await NestFactory.createApplicationContext(
            AnonymousUserCleanupTaskModule,
        );

        appContext.useLogger(createTriggerLogger('AnonymousUserCleanup'));

        try {
            const cleanup = appContext.get(AnonymousUserCleanupService);
            const summary = await cleanup.purgeExpired();
            return summary;
        } finally {
            await appContext.close();
        }
    },
});
