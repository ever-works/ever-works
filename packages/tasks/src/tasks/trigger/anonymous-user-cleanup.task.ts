import { schedules } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { AnonymousUserCleanupService } from '@ever-works/agent/services';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';

/**
 * EW-617 G2 — nightly purge of expired anonymous users.
 *
 * Runs every day at 03:17 UTC (off-peak, deliberately staggered from the
 * other scheduled jobs to avoid a coincident burst on the database). The
 * service consults `users.is_anonymous=true AND users.anonymous_expires_at <
 * now`, then deletes each row; cascade on `work.userId` removes the orphan
 * Works.
 */
export const anonymousUserCleanupTask = schedules.task({
    id: 'anonymous-user-cleanup',
    cron: '17 3 * * *',
    run: async () => {
        const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);

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
