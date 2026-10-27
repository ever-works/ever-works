import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { DesktopRecordingService } from '@ever-works/agent/computer';
import { config } from '@ever-works/agent/config';
import { FLEET_DESKTOP_RECORDING_GC_CRON } from '@ever-works/contracts';

const DESKTOP_RECORDING_GC_LOCK_KEY = 'fleet-desktop:recording-gc';

/**
 * Desktop view & control (FL-07 P2.C, T-40) — the recording retention sweep
 * when Trigger.dev is not the runtime.
 *
 * On a Trigger.dev install the `computer-recording-gc` scheduled task fires
 * the pass (and RPCs `sweepExpired()` back into this process). Every other
 * install runs it here, on the SAME schedule, gated on
 * `!config.trigger.shouldUseTrigger()` so the two never both run, inside
 * `DistributedTaskLockService` so one API replica runs a pass (the
 * `FleetSessionSweepCronService` shape). Object first, row second: a failed
 * object delete leaves the row for the next night.
 */
@Injectable()
export class FleetDesktopRecordingGcCronService {
    private readonly logger = new Logger(FleetDesktopRecordingGcCronService.name);

    constructor(
        private readonly recordings: DesktopRecordingService,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(FLEET_DESKTOP_RECORDING_GC_CRON)
    async runSweep(): Promise<void> {
        if (config.trigger.shouldUseTrigger()) return;
        await this.taskLockService.runExclusive(
            DESKTOP_RECORDING_GC_LOCK_KEY,
            async () => {
                try {
                    const summary = await this.recordings.sweepExpired();
                    if (summary.deleted > 0 || summary.failed > 0) {
                        this.logger.log(
                            `computer-recording-gc pass: ${summary.deleted} recording(s) deleted, ${summary.failed} left for the next pass`,
                        );
                    }
                } catch (error) {
                    const stack = error instanceof Error ? error.stack : String(error);
                    this.logger.error('computer-recording-gc pass failed', stack);
                }
            },
            {
                ttlMs: 30 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping computer-recording-gc pass because another instance holds the task lock',
                    ),
            },
        );
    }
}
