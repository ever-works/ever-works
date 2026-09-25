import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AppBuildSweepService } from '@ever-works/agent/app-builds';
import { config } from '@ever-works/agent/config';
import { APP_BUILD_SWEEP_CRON } from '@ever-works/contracts';

/**
 * APW-05 T21 (first slice) — the Builds sweep when Trigger.dev is not the
 * runtime (plan §7.4, `APW05-G20`).
 *
 * On a Trigger.dev install the `app-build-sweep` scheduled task fires the tick
 * and RPCs `runSweep()` back into this process. Every other install — the local
 * e2e stack, a different job-runtime plugin, or none at all — would otherwise
 * never re-drive a requested Build whose prepare failed (§9.2) and never fail a
 * never-adopted Build as `lost` (§7.4), so the Build would sit `queued` forever.
 *
 * The established fallback shape (`SkillReadinessSweepCronService`,
 * `MemoryFactGcCronService`): a Nest `@Cron` on the SAME contracts constant the
 * Trigger task registers, gated on `!config.trigger.shouldUseTrigger()` so the
 * two never both run.
 *
 * One deliberate difference: no `runExclusive` here. `runSweep` takes
 * `app-builds:sweep` (90-second lease) itself, because the Trigger task reaches
 * it over the internal RPC channel where a lock callback cannot travel; a second
 * `runExclusive` on the same key around it would never acquire. One API replica
 * therefore runs a tick and the others answer `skipped: locked`. The log line is
 * counters only.
 */
@Injectable()
export class AppBuildSweepCronService {
    private readonly logger = new Logger(AppBuildSweepCronService.name);

    constructor(private readonly sweeps: AppBuildSweepService) {}

    @Cron(APP_BUILD_SWEEP_CRON)
    async runSweepTick(): Promise<void> {
        if (config.trigger.shouldUseTrigger()) {
            // The `app-build-sweep` Trigger.dev schedule owns the tick.
            return;
        }

        try {
            const summary = await this.sweeps.runSweep();
            if (summary.skipped === 'lockUnavailable') {
                this.logger.warn(`app-build-sweep pass skipped: ${summary.skipped}`);
                return;
            }
            if (summary.skipped) {
                this.logger.debug(`app-build-sweep pass skipped: ${summary.skipped}`);
                return;
            }
            const failures = summary.passesFailed + summary.redriveFailed + summary.lostFailed;
            if (summary.redriveWorks > 0 || summary.lostMarked > 0 || failures > 0) {
                this.logger.log(
                    `app-build-sweep pass: ${summary.redriveRequested}/${summary.redriveWorks} work(s) re-driven, ` +
                        `${summary.lostMarked} lost (${summary.lostFinalized} finalized), ${failures} failure(s)`,
                );
            }
        } catch (error) {
            const stack = error instanceof Error ? error.stack : String(error);
            this.logger.error('app-build-sweep pass failed', stack);
        }
    }
}
