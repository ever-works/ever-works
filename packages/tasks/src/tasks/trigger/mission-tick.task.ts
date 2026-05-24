import { schedules } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { MissionTickService } from '@ever-works/agent/missions';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';

/**
 * Phase 3 PR J — Mission tick worker (spec §1.3, Decision A7).
 *
 * Fires every minute. The per-Mission cron stored on
 * `Mission.schedule` is what actually decides whether each
 * Mission runs this tick — `MissionTickService.tickDue()` does
 * the cron match in JS against the current UTC clock.
 *
 * Why every-minute instead of a coarser schedule:
 *   - User-defined Mission crons can be as fine-grained as "* * * * *".
 *   - The work-schedule-dispatcher (the other dispatcher pattern in
 *     this repo) also fires every N minutes, so per-minute fits the
 *     existing ops cadence.
 *   - The tick is cheap when no Missions match: a single
 *     `SELECT * FROM missions WHERE status='active' AND type='scheduled'`
 *     plus a JS cron-match on each row. Generator + DB writes only
 *     happen for matched Missions.
 *
 * Mirrors the WorkScheduleDispatcher Trigger.dev wrapper shape so
 * the dashboard shows a uniform structured summary per run.
 */
export const missionTickTask = schedules.task({
    id: 'mission-tick',
    cron: '* * * * *',
    run: async () => {
        const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
        appContext.useLogger(createTriggerLogger('MissionTick'));

        try {
            const tickService = appContext.get(MissionTickService);
            const summary = await tickService.tickDue();
            return summary;
        } finally {
            await appContext.close();
        }
    },
});
