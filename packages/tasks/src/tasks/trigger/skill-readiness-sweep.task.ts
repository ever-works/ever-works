import { logger, schedules } from '@trigger.dev/sdk';
import { SkillReadinessService } from '@ever-works/agent/skills';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * Hourly at :17 — off the top of the hour (heartbeats) and off the 03:xx / 08:37 sweeps.
 * A literal, read at module load where Trigger.dev indexes it;
 * `skill-readiness-sweep.task.spec.ts` pins it equal to the shared
 * `SKILL_READINESS_SWEEP_CRON` in `@ever-works/contracts` the API fallback uses.
 */
export const SKILL_READINESS_SWEEP_CRON = '17 * * * *';

/**
 * Skills shelf — hourly readiness sweep.
 *
 * A Skill's readiness badge is a cached verdict. It is recomputed whenever
 * the Skill or its bindings are written and whenever a person presses
 * Re-check — but the things a verdict depends on (a connection someone
 * switched off, a credential that was set, a tool-grant edit) change without
 * touching the Skill. This cron re-checks every Skill whose verdict is missing
 * or older than an hour, oldest first, at most 500 per tick and 200 per
 * workspace per tick, so the shelf converges within the hour without a
 * user-facing request ever waiting on it.
 *
 * The real `SkillReadinessService` lives in the API (repositories, the
 * tool-grant matrix and the credential port are wired there); the worker only
 * calls `sweepStale()` over the internal RPC channel — same shape as
 * memory-consolidation-tick / terminal-transcript-gc.
 *
 * ## On runtimes other than Trigger.dev
 *
 * This is the Trigger.dev registration of the sweep. When Trigger.dev is not
 * the configured runtime, the API runs the same pass itself —
 * `SkillReadinessSweepCronService` in `apps/api/src/skills/`, gated on
 * `!config.trigger.shouldUseTrigger()` and distributed-locked, the fallback
 * `WorkScheduleDispatcherCronService` established — so verdicts are re-checked
 * every hour on every install.
 *
 * The service isolates per-Skill failures, so one broken Skill never aborts
 * the tick. The logged summary is counters only — never a Skill body, a tag
 * or a credential key.
 */
export const skillReadinessSweepTask = schedules.task({
    id: 'skill-readiness-sweep',
    cron: SKILL_READINESS_SWEEP_CRON,
    run: async () => {
        return withWorkerContext(
            'SkillReadinessSweep',
            async (appContext) => {
                const svc = appContext.get(SkillReadinessService);
                const summary = await svc.sweepStale();
                // Quiet when there is nothing to say.
                if (summary.scanned > 0) {
                    logger.info('skill.readiness.sweep.completed', {
                        scanned: summary.scanned,
                        changed: summary.changed,
                        failed: summary.failed,
                        byState: summary.byState,
                        durationMs: summary.durationMs,
                    });
                }
                return summary;
            },
            TriggerInternalModule,
        );
    },
});
