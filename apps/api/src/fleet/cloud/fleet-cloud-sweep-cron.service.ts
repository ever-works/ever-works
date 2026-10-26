import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { config } from '@ever-works/agent/config';
import { FleetCloudSweepService } from '@ever-works/agent/fleet';
import { FLEET_CLOUD_BOOTSTRAP_WATCH_CRON, FLEET_CLOUD_RECONCILE_CRON } from '@ever-works/contracts';

const RECONCILE_LOCK_KEY = 'fleet-cloud:reconcile';
const WATCH_LOCK_KEY = 'fleet-cloud:bootstrap-watch';

/**
 * Cloud computers (FL-17, plan §10, T-19) — the two sweeps when Trigger.dev is
 * not the runtime: the `FleetVirtualReconcileCronService` shape — a Nest
 * `@Cron` on the SAME shared schedule, gated on `!config.trigger.shouldUseTrigger()`
 * so it and the `fleet-cloud-*` tasks never both run, inside
 * `DistributedTaskLockService` so one API replica runs a pass. Does nothing
 * while `FLEET_CLOUD_ENABLED` is off.
 *
 *  - reconcile (hourly, FR-29): a machine the provider forgot reads `gone`;
 *  - bootstrap watch (every minute): a create the provider never answered
 *    fails, a booted machine moves to `installing`, a pending power / destroy
 *    settles.
 */
@Injectable()
export class FleetCloudSweepCronService {
    private readonly logger = new Logger(FleetCloudSweepCronService.name);

    constructor(
        private readonly sweeps: FleetCloudSweepService,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(FLEET_CLOUD_RECONCILE_CRON)
    async runReconcile(): Promise<void> {
        if (config.trigger.shouldUseTrigger() || !config.fleet.isCloudEnabled()) return;
        await this.taskLockService.runExclusive(
            RECONCILE_LOCK_KEY,
            async () => {
                try {
                    const summary = await this.sweeps.reconcile();
                    if (summary.changed > 0) {
                        this.logger.log(
                            `fleet-cloud-reconcile pass: ${summary.machines} machine(s) read, ${summary.changed} updated`,
                        );
                    }
                } catch (error) {
                    const stack = error instanceof Error ? error.stack : String(error);
                    this.logger.error('fleet-cloud-reconcile pass failed', stack);
                }
            },
            {
                ttlMs: 30 * 60 * 1000,
                onLocked: () => this.logger.debug('Skipping fleet-cloud-reconcile: another instance holds the lock'),
            },
        );
    }

    @Cron(FLEET_CLOUD_BOOTSTRAP_WATCH_CRON)
    async runBootstrapWatch(): Promise<void> {
        if (config.trigger.shouldUseTrigger() || !config.fleet.isCloudEnabled()) return;
        await this.taskLockService.runExclusive(
            WATCH_LOCK_KEY,
            async () => {
                try {
                    const summary = await this.sweeps.watchBootstrap();
                    if (summary.changed > 0) {
                        this.logger.log(
                            `fleet-cloud-bootstrap-watch pass: ${summary.checked} machine(s) checked, ${summary.changed} updated`,
                        );
                    }
                } catch (error) {
                    const stack = error instanceof Error ? error.stack : String(error);
                    this.logger.error('fleet-cloud-bootstrap-watch pass failed', stack);
                }
            },
            {
                ttlMs: 50 * 1000,
                onLocked: () => this.logger.debug('Skipping fleet-cloud-bootstrap-watch: another instance holds the lock'),
            },
        );
    }
}
