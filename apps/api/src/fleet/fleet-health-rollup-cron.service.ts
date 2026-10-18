import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { config } from '@ever-works/agent/config';
import { FleetNodeHealthService } from '@ever-works/agent/fleet';
import { FLEET_HEALTH_ROLLUP_CRON } from '@ever-works/contracts';

const FLEET_HEALTH_ROLLUP_LOCK_KEY = 'fleet-health:rollup';

/**
 * Computer health (FL-03) — the hourly roll-up and retention when Trigger.dev
 * is not the runtime.
 *
 * On a Trigger.dev install the `fleet-health-rollup` scheduled task fires the
 * pass (and RPCs `rollupAndPrune()` back into this process). Every other
 * install — a different job-runtime plugin, or none — would otherwise never
 * roll up or prune the health history, and the raw table would grow without
 * bound the moment `FLEET_HEALTH_HISTORY_ENABLED` is switched on.
 *
 * The established fallback shape (`SkillReadinessSweepCronService`): a Nest
 * `@Cron` on the SAME shared schedule, gated on
 * `!config.trigger.shouldUseTrigger()` so the two never both run, wrapped in
 * `DistributedTaskLockService` so only one API replica runs a pass. The pass
 * itself is idempotent either way. The log line is counters only.
 */
@Injectable()
export class FleetHealthRollupCronService {
    private readonly logger = new Logger(FleetHealthRollupCronService.name);

    constructor(
        private readonly health: FleetNodeHealthService,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(FLEET_HEALTH_ROLLUP_CRON)
    async runHourlyRollup(): Promise<void> {
        if (config.trigger.shouldUseTrigger()) {
            // The `fleet-health-rollup` Trigger.dev schedule owns the pass.
            return;
        }
        // Runs with the history switched off too: the pass then rolls nothing
        // and only ages out rows written before it was switched off.

        await this.taskLockService.runExclusive(
            FLEET_HEALTH_ROLLUP_LOCK_KEY,
            async () => {
                try {
                    const summary = await this.health.rollupAndPrune();
                    if (
                        summary.rolledHours > 0 ||
                        summary.prunedRaw > 0 ||
                        summary.prunedHourly > 0
                    ) {
                        this.logger.log(
                            `fleet-health-rollup pass: ${summary.rolledHours} hour(s) rolled into ${summary.hourlyRows} row(s), ` +
                                `${summary.prunedRaw} raw and ${summary.prunedHourly} hourly row(s) past retention removed`,
                        );
                    }
                } catch (error) {
                    const stack = error instanceof Error ? error.stack : String(error);
                    this.logger.error('fleet-health-rollup pass failed', stack);
                }
            },
            {
                // A pass is bounded (48 hours rolled), and a lease left by a
                // crashed replica must lapse well before the next hourly tick.
                ttlMs: 30 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping fleet-health-rollup pass because another instance holds the task lock',
                    ),
            },
        );
    }
}
