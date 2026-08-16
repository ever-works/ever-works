import { schedules } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { GoalOrchestratorService } from '@ever-works/agent/goals';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';

/**
 * Autonomy layer — Goal execution-loop dispatcher.
 *
 * The sibling of `goal-evaluate-dispatcher`: that one asks "is the number
 * there yet?", this one asks "should we keep WORKING on this?". Fires
 * every five minutes rather than every minute, because one tick can start
 * a paid agent run and an iteration takes minutes to hours — a per-minute
 * cadence would buy nothing but four wasted queries out of every five.
 *
 * `advanceDue()` scans Goals with `loopStatus = 'running'` (a NULL
 * loopStatus — every Goal that never opted into the loop — never matches,
 * so the cheap case is one indexed lookup returning zero rows), rolls up
 * spend from the linked runs, and for each one either dispatches the next
 * iteration to the routed agent or stops the loop with a recorded reason.
 * Every decision, including the reasoning that produced it, lands in
 * `goal_events` — the Orchestrator tab reads exactly that.
 *
 * The service resolves as a remote proxy (TriggerInternalModule) — the
 * real GoalOrchestratorService runs inside the API, where the Tasks
 * runtime and the dispatch gate live.
 */
export const goalAdvanceDispatcherTask = schedules.task({
    id: 'goal-advance-dispatcher',
    cron: '*/5 * * * *',
    run: async () => {
        const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
        appContext.useLogger(createTriggerLogger('GoalAdvanceDispatcher'));

        try {
            const orchestrator = appContext.get(GoalOrchestratorService);
            const summary = await orchestrator.advanceDue();
            return summary;
        } finally {
            await appContext.close();
        }
    },
});
