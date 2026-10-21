import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { config } from '@ever-works/agent/config';
import { FleetSessionSweepService } from '@ever-works/agent/fleet';
import { FLEET_SESSION_SWEEP_CRON } from '@ever-works/contracts';

const FLEET_SESSION_SWEEP_LOCK_KEY = 'fleet-sessions:sweep';

/**
 * Sessions on computers (FL-04, T-30) — the session sweeper when Trigger.dev
 * is not the runtime.
 *
 * On a Trigger.dev install the `fleet-session-sweeper` scheduled task fires
 * the pass (and RPCs `sweepStale()` back into this process). Every other
 * install runs it here: the fallback shape `FleetHealthRollupCronService`
 * uses — a Nest `@Cron` on the SAME shared schedule, gated on
 * `!config.trigger.shouldUseTrigger()` so the two never both run, inside
 * `DistributedTaskLockService` so one API replica runs a pass. The pass is
 * idempotent either way (conditional ends), and does nothing at all while
 * `FLEET_SESSIONS_ENABLED` is off.
 */
@Injectable()
export class FleetSessionSweepCronService {
    private readonly logger = new Logger(FleetSessionSweepCronService.name);

    constructor(
        private readonly sweeper: FleetSessionSweepService,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(FLEET_SESSION_SWEEP_CRON)
    async runSweep(): Promise<void> {
        if (config.trigger.shouldUseTrigger()) return;
        if (!config.fleet.isSessionsEnabled()) return;
        await this.taskLockService.runExclusive(
            FLEET_SESSION_SWEEP_LOCK_KEY,
            async () => {
                try {
                    const summary = await this.sweeper.sweepStale();
                    if (summary.ended > 0) {
                        this.logger.log(
                            `fleet-session-sweeper pass: ${summary.ended} session(s) that never confirmed their start ended`,
                        );
                    }
                } catch (error) {
                    const stack = error instanceof Error ? error.stack : String(error);
                    this.logger.error('fleet-session-sweeper pass failed', stack);
                }
            },
            {
                // A pass is bounded (200 rows); a crashed replica's lease must
                // lapse before the next five-minute tick.
                ttlMs: 4 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping fleet-session-sweeper pass because another instance holds the task lock',
                    ),
            },
        );
    }
}
