import { schedules } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { TaskRecurrenceDispatcherService } from '@ever-works/agent/tasks-domain';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';

/**
 * Tasks feature — Phase 17.7.
 *
 * Per-minute cron that drives the recurrence dispatcher. Fires
 * with `* * * * *` so any RRULE granularity (down to a minute) is
 * respected. The dispatcher itself does the cron-match-in-JS
 * filter — same posture as `mission-tick.task.ts`.
 *
 * The dispatcher returns a structured summary that gets attached
 * to the run handle so the operator dashboard can see the spawn
 * counts at a glance.
 */
export const taskRecurrenceDispatcherTask = schedules.task({
    id: 'task-recurrence-dispatcher',
    cron: '* * * * *',
    run: async () => {
        const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
        appContext.useLogger(createTriggerLogger('TaskRecurrenceDispatcher'));

        try {
            const dispatcher = appContext.get(TaskRecurrenceDispatcherService);
            const summary = await dispatcher.dispatchDue();
            return summary;
        } finally {
            await appContext.close();
        }
    },
});
