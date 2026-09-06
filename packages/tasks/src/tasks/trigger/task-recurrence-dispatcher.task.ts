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
            // Three scans per tick: recurring templates spawn+dispatch
            // instances, one-shot `scheduledAt` Tasks dispatch themselves,
            // and the task-graph fan-out starts TODO Tasks whose blockers
            // have cleared. Sequential on purpose — they share the tasks
            // table and one summary keeps the operator dashboard whole.
            //
            // The fan-out runs LAST so a Task the recurrence or schedule
            // scan just moved into `todo` is considered by the scan that
            // sees the freshest rows, and it is a no-op unless an operator
            // set TASK_FANOUT_MAX_STARTS_PER_OWNER.
            const recurrence = await dispatcher.dispatchDue();
            const scheduled = await dispatcher.dispatchDueScheduled();
            const fanout = await dispatcher.dispatchUnblockedTodo();
            return { recurrence, scheduled, fanout };
        } finally {
            await appContext.close();
        }
    },
});
