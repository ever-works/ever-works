import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { config } from '@ever-works/agent/config';
import { FleetVirtualReconcileService } from '@ever-works/agent/fleet';
import { FLEET_VIRTUAL_RECONCILE_CRON } from '@ever-works/contracts';

const FLEET_VIRTUAL_RECONCILE_LOCK_KEY = 'fleet-virtual:reconcile';

/**
 * Virtual computers (FL-16, plan §10, T-24) — the reconcile sweep when
 * Trigger.dev is not the runtime: the `FleetCheckoutReconcileCronService`
 * shape — a Nest `@Cron` on the SAME shared schedule, gated on
 * `!config.trigger.shouldUseTrigger()` so it and the `fleet-virtual-reconcile`
 * task never both run, inside `DistributedTaskLockService` so one API replica
 * runs a pass. Does nothing while `FLEET_VIRTUAL_ENABLED` is off.
 */
@Injectable()
export class FleetVirtualReconcileCronService {
    private readonly logger = new Logger(FleetVirtualReconcileCronService.name);

    constructor(
        private readonly reconciler: FleetVirtualReconcileService,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(FLEET_VIRTUAL_RECONCILE_CRON)
    async runReconcile(): Promise<void> {
        if (config.trigger.shouldUseTrigger()) return;
        if (!config.fleet.isVirtualEnabled()) return;
        await this.taskLockService.runExclusive(
            FLEET_VIRTUAL_RECONCILE_LOCK_KEY,
            async () => {
                try {
                    const summary = await this.reconciler.reconcile();
                    if (summary.changed > 0) {
                        this.logger.log(
                            `fleet-virtual-reconcile pass: ${summary.hosts} host(s) read, ${summary.changed} virtual computer(s) updated`,
                        );
                    }
                } catch (error) {
                    const stack = error instanceof Error ? error.stack : String(error);
                    this.logger.error('fleet-virtual-reconcile pass failed', stack);
                }
            },
            {
                ttlMs: 4 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping fleet-virtual-reconcile pass because another instance holds the task lock',
                    ),
            },
        );
    }
}
