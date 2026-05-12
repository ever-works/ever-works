import { schedules } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import superjson from 'superjson';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { TriggerInternalApiClient } from '../../trigger/worker/services/trigger-internal-api.client';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';

export const userResearchRerunDispatcherTask = schedules.task({
    id: 'user-research-rerun-dispatcher',
    cron: '0 3 * * *',
    run: async () => {
        const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
        appContext.useLogger(createTriggerLogger('UserResearchRerunDispatcher'));

        try {
            const apiClient = appContext.get(TriggerInternalApiClient);
            const result = await apiClient.callRemote(
                'WorkProposalsApiService',
                'runScheduledBatch',
                superjson.serialize([]),
            );
            return result as Record<string, unknown> | undefined;
        } finally {
            await appContext.close();
        }
    },
});
