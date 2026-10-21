import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { FleetPortTunnelService } from '@ever-works/agent/fleet';

const FLEET_PORT_TUNNEL_SWEEP_LOCK_KEY = 'fleet-port-tunnels:sweep';

/** Every minute, off the minute boundary (plan §10's `1/1 * * * *`, with seconds). */
export const FLEET_PORT_TUNNEL_SWEEP_CRON = '17 * * * * *';

/**
 * Servers and ports, phase 2 (FL-10, plan §10, T-21) — the preview-tunnel
 * sweeper: closes every open tunnel that must close — ten idle minutes
 * (`idle`), an hour old (`hard`), its node gone, disabled or silent without a
 * link (`node-offline`), the kill switch (`kill-switch`) — each with its one
 * close audit row.
 *
 * Runs in the API on every install (one replica a pass, under
 * `DistributedTaskLockService`); the live request path closes an expired or
 * stopped tunnel at its next request too, so the sweeper is the floor. A pass
 * is idempotent (the close is a compare-and-set) and does nothing while
 * `FLEET_PORT_TUNNEL_ENABLED` is off.
 */
@Injectable()
export class FleetPortTunnelSweepCronService {
    private readonly logger = new Logger(FleetPortTunnelSweepCronService.name);

    constructor(
        private readonly tunnels: FleetPortTunnelService,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(FLEET_PORT_TUNNEL_SWEEP_CRON)
    async runSweep(): Promise<void> {
        if (!this.tunnels.isEnabled()) return;
        await this.taskLockService.runExclusive(
            FLEET_PORT_TUNNEL_SWEEP_LOCK_KEY,
            async () => {
                try {
                    const summary = await this.tunnels.sweep();
                    if (summary.closed > 0) {
                        this.logger.log(
                            `fleet-port-tunnel-sweeper pass: ${summary.closed} preview tunnel(s) closed`,
                        );
                    }
                } catch (error) {
                    const stack = error instanceof Error ? error.stack : String(error);
                    this.logger.error('fleet-port-tunnel-sweeper pass failed', stack);
                }
            },
            {
                ttlMs: 50 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping fleet-port-tunnel-sweeper pass because another instance holds the task lock',
                    ),
            },
        );
    }
}
