import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { config } from '@ever-works/agent/config';
import { FleetActionsRunnersPollService } from '@ever-works/agent/fleet';
import { FLEET_ACTIONS_RUNNERS_POLL_CRON } from '@ever-works/contracts';

const FLEET_RUNNERS_POLL_LOCK_KEY = 'fleet-runners:poll';

/**
 * Actions runners on computers (FL-18, plan §10, T-18) — the off-page refresh
 * when Trigger.dev is not the runtime: the FL-16 reconcile shape — a Nest
 * `@Cron` on the SAME shared schedule, gated on
 * `!config.trigger.shouldUseTrigger()` so it and the `fleet-runners-poll` task
 * never both run, inside `DistributedTaskLockService` so one API replica runs
 * a pass. Does nothing while `FLEET_ACTIONS_RUNNERS_ENABLED` is off.
 */
@Injectable()
export class FleetActionsRunnersPollCronService {
    private readonly logger = new Logger(FleetActionsRunnersPollCronService.name);

    constructor(
        private readonly poll: FleetActionsRunnersPollService,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(FLEET_ACTIONS_RUNNERS_POLL_CRON)
    async runPoll(): Promise<void> {
        if (config.trigger.shouldUseTrigger()) return;
        if (!config.fleet.isActionsRunnersEnabled()) return;
        await this.taskLockService.runExclusive(
            FLEET_RUNNERS_POLL_LOCK_KEY,
            async () => {
                try {
                    const summary = await this.poll.reconcile();
                    if (summary.changed > 0) {
                        this.logger.log(
                            `fleet-runners-poll pass: ${summary.owners} owner(s), ${summary.runners} runner(s), ${summary.changed} changed`,
                        );
                    }
                } catch (error) {
                    const stack = error instanceof Error ? error.stack : String(error);
                    this.logger.error('fleet-runners-poll pass failed', stack);
                }
            },
            {
                ttlMs: 4 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug('Skipping fleet-runners-poll pass because another instance holds the task lock'),
            },
        );
    }
}
