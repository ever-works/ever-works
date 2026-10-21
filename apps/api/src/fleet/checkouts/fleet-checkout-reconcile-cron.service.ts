import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { config } from '@ever-works/agent/config';
import { FleetCheckoutReconcileService } from '@ever-works/agent/fleet';
import { FLEET_CHECKOUT_BIN_PURGE_CRON, FLEET_CHECKOUT_RECONCILE_CRON } from '@ever-works/contracts';

const FLEET_CHECKOUT_RECONCILE_LOCK_KEY = 'fleet-checkouts:reconcile';
const FLEET_CHECKOUT_BIN_PURGE_LOCK_KEY = 'fleet-checkouts:bin-purge';

/**
 * Checkouts on computers (FL-14, plan §10, T-15) — the reconcile sweep when
 * Trigger.dev is not the runtime.
 *
 * On a Trigger.dev install the `fleet-checkout-reconcile` scheduled task
 * fires the pass (and RPCs `reconcile()` back into this process). Every other
 * install runs it here: the `FleetSessionSweepCronService` shape — a Nest
 * `@Cron` on the SAME shared schedule, gated on
 * `!config.trigger.shouldUseTrigger()` so the two never both run, inside
 * `DistributedTaskLockService` so one API replica runs a pass. The pass is
 * idempotent (compare-and-set on `updatedAt`) and does nothing while
 * `FLEET_CHECKOUTS_ENABLED` is off.
 */
@Injectable()
export class FleetCheckoutReconcileCronService {
    private readonly logger = new Logger(FleetCheckoutReconcileCronService.name);

    constructor(
        private readonly reconciler: FleetCheckoutReconcileService,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(FLEET_CHECKOUT_RECONCILE_CRON)
    async runReconcile(): Promise<void> {
        if (config.trigger.shouldUseTrigger()) return;
        if (!config.fleet.isCheckoutsEnabled()) return;
        await this.taskLockService.runExclusive(
            FLEET_CHECKOUT_RECONCILE_LOCK_KEY,
            async () => {
                try {
                    const summary = await this.reconciler.reconcile();
                    if (summary.swept > 0 || summary.asked > 0) {
                        this.logger.log(
                            `fleet-checkout-reconcile pass: ${summary.swept} stuck checkout(s) marked missing, ${summary.asked} computer(s) asked`,
                        );
                    }
                } catch (error) {
                    const stack = error instanceof Error ? error.stack : String(error);
                    this.logger.error('fleet-checkout-reconcile pass failed', stack);
                }
            },
            {
                // A pass is bounded (200 rows, 100 nodes); a crashed replica's
                // lease must lapse before the next ten-minute tick.
                ttlMs: 8 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping fleet-checkout-reconcile pass because another instance holds the task lock',
                    ),
            },
        );
    }

    /** P3 (spec FR-33): the daily bin purge, same posture as the reconcile pass. */
    @Cron(FLEET_CHECKOUT_BIN_PURGE_CRON)
    async runBinPurge(): Promise<void> {
        if (config.trigger.shouldUseTrigger()) return;
        if (!config.fleet.isCheckoutsEnabled()) return;
        await this.taskLockService.runExclusive(
            FLEET_CHECKOUT_BIN_PURGE_LOCK_KEY,
            async () => {
                try {
                    const summary = await this.reconciler.purgeBin();
                    if (summary.purged > 0) {
                        this.logger.log(`fleet-checkout-bin-purge: ${summary.purged} bin row(s) purged`);
                    }
                } catch (error) {
                    const stack = error instanceof Error ? error.stack : String(error);
                    this.logger.error('fleet-checkout-bin-purge pass failed', stack);
                }
            },
            {
                ttlMs: 30 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping fleet-checkout-bin-purge because another instance holds the task lock',
                    ),
            },
        );
    }
}
