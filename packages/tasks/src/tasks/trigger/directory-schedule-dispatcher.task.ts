import { schedules } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { TriggerInternalModule } from '../../trigger/trigger-internal.module';
import { config } from '@ever-works/agent/config';
import { RemoteDirectoryScheduleService } from '../../trigger/remote-directory-schedule.service';
import { TriggerLogger } from '../../trigger/trigger-logger';

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
            const dispatcher = appContext.get(RemoteDirectoryScheduleService);
            const { dispatched } = await dispatcher.dispatchDueSchedules();

            return {
                dispatched,
                intervalMinutes: interval,
            };
        } finally {
            await appContext.close();
        }
    },
});
