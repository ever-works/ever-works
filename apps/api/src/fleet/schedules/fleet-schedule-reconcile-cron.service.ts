import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { config } from '@ever-works/agent/config';
import { FleetScheduleService } from '@ever-works/agent/fleet';
import { FLEET_SCHEDULE_RECONCILE_CRON } from '@ever-works/contracts';

const FLEET_SCHEDULE_RECONCILE_LOCK_KEY = 'fleet-schedules:reconcile';

/**
 * Schedules on computers (FL-13, plan §10, T-28) — the five-minute pass:
 * every computer holding a schedule whose link is up gets its set re-sent
 * when it has not acknowledged it, and is asked for the runs it made
 * (`schedule.runs`), which are folded in idempotently by run id; the failure
 * streak pauses a schedule at five (CONTRACTS §6).
 *
 * It runs HERE, in the API, on every install — Trigger.dev or not — because
 * the node link lives in this process: a job-runtime task could only call
 * back into it (lane-log decision 7). Inside `DistributedTaskLockService` so
 * one replica runs a pass (a link another replica holds is reached through
 * the relay bus). Nothing happens while `FLEET_COMMANDS_ENABLED` is off.
 */
@Injectable()
export class FleetScheduleReconcileCronService {
    private readonly logger = new Logger(FleetScheduleReconcileCronService.name);

    constructor(
        private readonly schedules: FleetScheduleService,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(FLEET_SCHEDULE_RECONCILE_CRON)
    async runReconcile(): Promise<void> {
        if (!config.fleet.isCommandsEnabled()) return;
        await this.taskLockService.runExclusive(
            FLEET_SCHEDULE_RECONCILE_LOCK_KEY,
            async () => {
                try {
                    const summary = await this.schedules.reconcileAll();
                    if (summary.runs > 0 || summary.paused > 0 || summary.synced > 0) {
                        this.logger.log(
                            `fleet-schedule-reconcile: ${summary.nodes} computer(s), ${summary.synced} re-synced, ${summary.runs} run(s) folded in, ${summary.paused} paused after failures`,
                        );
                    }
                } catch (error) {
                    const stack = error instanceof Error ? error.stack : String(error);
                    this.logger.error('fleet-schedule-reconcile pass failed', stack);
                }
            },
            {
                // A pass is bounded (each computer: one sync, five pages of runs);
                // a crashed replica's lease must lapse before the next tick.
                ttlMs: 4 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping fleet-schedule-reconcile because another instance holds the task lock',
                    ),
            },
        );
    }
}
