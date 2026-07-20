import { schedules } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { GoalEvaluationService } from '@ever-works/agent/goals';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';

/**
 * Goals & Metrics — PR-8 (spec FR-12). Goal evaluation dispatcher.
 *
 * Fires every minute (mirrors the mission-tick wrapper shape). The
 * per-Goal cadence stored on `Goal.checkFrequencyMinutes` — clamped
 * to ≥ 15 minutes at the service layer — is what actually decides
 * whether each Goal runs this tick: `evaluateDue()` scans ACTIVE
 * Goals with `nextCheckAt <= now`, claims each with an atomic CAS
 * (advance-before-evaluate, so provider failures can't tight-loop),
 * reads the metric through the budget-guarded `MetricsFacadeService`,
 * appends a sample, and applies the auto-outcome rules (ACHIEVED /
 * MISSED — both human-overridable, spec FR-13).
 *
 * The tick is cheap when nothing is due: one indexed SELECT
 * (`idx_goals_status_next_check`) returning zero rows.
 *
 * Invariant I-4 (FR-14): evaluation never touches Missions — a
 * Mission is completed only by an explicit human action.
 *
 * The service resolves as a remote proxy (TriggerInternalModule) —
 * the real GoalEvaluationService runs inside the API where the
 * metrics-provider plugins are loaded.
 */
export const goalEvaluateDispatcherTask = schedules.task({
    id: 'goal-evaluate-dispatcher',
    cron: '* * * * *',
    run: async () => {
        const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
        appContext.useLogger(createTriggerLogger('GoalEvaluateDispatcher'));

        try {
            const evaluationService = appContext.get(GoalEvaluationService);
            const summary = await evaluationService.evaluateDue();
            return summary;
        } finally {
            await appContext.close();
        }
    },
});
