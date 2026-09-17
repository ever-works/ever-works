import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { config } from '@ever-works/agent/config';
import { SkillReadinessService } from '@ever-works/agent/skills';
import { SKILL_READINESS_SWEEP_CRON } from '@ever-works/contracts';

const SKILL_READINESS_SWEEP_LOCK_KEY = 'skills:readiness-sweep';

/**
 * Skills shelf — the hourly readiness sweep when Trigger.dev is not the runtime.
 *
 * On a Trigger.dev install the `skill-readiness-sweep` scheduled task fires
 * the pass (and RPCs `sweepStale()` back into this process). Every other
 * install — a different job-runtime plugin, or none at all — would otherwise
 * never re-check a cached verdict after a connection, credential or grant
 * changed without touching the Skill.
 *
 * The established fallback shape, not a new mechanism: exactly what
 * `WorkScheduleDispatcherCronService` does for its own Trigger.dev cron — a
 * Nest `@Cron` gated on `!config.trigger.shouldUseTrigger()` so the two never
 * both run, wrapped in `DistributedTaskLockService` so only one API replica
 * runs a pass.
 *
 * Same cron (`SKILL_READINESS_SWEEP_CRON`) and the same service call the
 * Trigger.dev task makes, so the pass is identical whichever scheduler fires
 * it. The log line is counters only.
 */
@Injectable()
export class SkillReadinessSweepCronService {
    private readonly logger = new Logger(SkillReadinessSweepCronService.name);

    constructor(
        private readonly readiness: SkillReadinessService,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(SKILL_READINESS_SWEEP_CRON)
    async runHourlySweep(): Promise<void> {
        if (config.trigger.shouldUseTrigger()) {
            // The `skill-readiness-sweep` Trigger.dev schedule owns the pass.
            return;
        }

        await this.taskLockService.runExclusive(
            SKILL_READINESS_SWEEP_LOCK_KEY,
            async () => {
                try {
                    const summary = await this.readiness.sweepStale();
                    if (summary.scanned > 0 || summary.failed > 0) {
                        this.logger.log(
                            `skill-readiness-sweep pass: ${summary.scanned} scanned, ${summary.changed} changed, ` +
                                `${summary.failed} failed (${summary.durationMs}ms)`,
                        );
                    }
                } catch (error) {
                    const stack = error instanceof Error ? error.stack : String(error);
                    this.logger.error('skill-readiness-sweep pass failed', stack);
                }
            },
            {
                // A pass is bounded (500 Skills), and a lease left by a crashed
                // replica must lapse well before the next hourly tick.
                ttlMs: 30 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping skill-readiness-sweep pass because another instance holds the task lock',
                    ),
            },
        );
    }
}
