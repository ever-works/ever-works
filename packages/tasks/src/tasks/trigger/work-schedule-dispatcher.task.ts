import { schedules } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { config } from '@ever-works/agent/config';
import { WorkScheduleDispatcherService } from '@ever-works/agent/services';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';
import { INestApplicationContext } from '@nestjs/common';

// Security: clamp interval to [1, 60] so a misconfigured env var (e.g. 9999999)
// cannot produce a semantically useless cron expression that silently disables
// the dispatcher. The radix-10 parseInt fix belongs in packages/agent/src/config.
const interval = Math.min(60, Math.max(1, config.subscriptions.getDispatchIntervalMinutes()));
const cronExpression = `*/${interval} * * * *`;

export const workScheduleDispatcherTask = schedules.task({
    id: 'work-schedule-dispatcher',
    cron: cronExpression,
    run: async () => {
        const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);

        appContext.useLogger(createTriggerLogger('ScheduleDispatcher'));

        try {
            const dispatcher = appContext.get(WorkScheduleDispatcherService);
            const summary = await dispatcher.dispatchDue();

            return {
                intervalMinutes: interval,
                ...summary,
            };
        } finally {
            await appContext.close();
        }
    },
});
