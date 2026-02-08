import { schedules } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { config } from '@ever-works/agent/config';
import { DirectoryScheduleDispatcherService } from '@ever-works/agent/services';
import { TriggerLogger } from '../../trigger/worker/trigger-logger';

const interval = Math.max(1, config.subscriptions.getDispatchIntervalMinutes());
const cronExpression = `*/${interval} * * * *`;

export const directoryScheduleDispatcherTask = schedules.task({
    id: 'directory-schedule-dispatcher',
    cron: cronExpression,
    run: async () => {
        const appContext = await NestFactory.createApplicationContext(TriggerInternalModule, {
            logger: new TriggerLogger('ScheduleDispatcher'),
        });

        try {
            const dispatcher = appContext.get(DirectoryScheduleDispatcherService);
            const dispatched = await dispatcher.dispatchDue();

            return {
                dispatched,
                intervalMinutes: interval,
            };
        } finally {
            await appContext.close();
        }
    },
});
