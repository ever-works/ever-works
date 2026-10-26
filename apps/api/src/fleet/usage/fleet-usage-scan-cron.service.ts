import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { config } from '@ever-works/agent/config';
import { FleetUsageDispatchService } from '@ever-works/agent/fleet';
import { FLEET_USAGE_SCAN_CRON } from '@ever-works/contracts';

const FLEET_USAGE_SCAN_LOCK_KEY = 'fleet-usage:scan-dispatch';

/**
 * Usage & cost on the fleet (FL-20, plan §10, T-14) — the 15-minute
 * dispatcher: every opted-in, online computer without a scan waiting gets one
 * `usage-scan` job.
 *
 * Runs in the API on every install (no Trigger.dev task in this phase): the
 * pass is one read and one enqueue per computer, idempotent by
 * `usage-scan:<nodeId>:<window>`, inside `DistributedTaskLockService` so one
 * replica runs it. Does nothing while `FLEET_USAGE_SCAN_ENABLED` is off.
 */
@Injectable()
export class FleetUsageScanCronService {
    private readonly logger = new Logger(FleetUsageScanCronService.name);

    constructor(
        private readonly dispatcher: FleetUsageDispatchService,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(FLEET_USAGE_SCAN_CRON)
    async runDispatch(): Promise<void> {
        if (!config.fleet.isUsageScanEnabled()) return;
        await this.taskLockService.runExclusive(
            FLEET_USAGE_SCAN_LOCK_KEY,
            async () => {
                try {
                    const summary = await this.dispatcher.dispatch();
                    if (summary.enqueued > 0) {
                        this.logger.log(
                            `fleet-usage-scan-dispatcher: ${summary.enqueued} scan(s) enqueued over ${summary.nodes} opted-in computer(s)`,
                        );
                    }
                } catch (error) {
                    const stack = error instanceof Error ? error.stack : String(error);
                    this.logger.error('fleet-usage-scan-dispatcher pass failed', stack);
                }
            },
            {
                // A pass is bounded (2 000 computers); a crashed replica's lease
                // must lapse before the next tick.
                ttlMs: 10 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping fleet-usage-scan-dispatcher pass because another instance holds the task lock',
                    ),
            },
        );
    }
}
