import {
    Inject,
    Injectable,
    Logger,
    OnApplicationBootstrap,
    OnModuleDestroy,
} from '@nestjs/common';
import { InstanceStatsSenderService } from './instance-stats-sender.service';
import { INSTANCE_STATS_CONFIG, type InstanceStatsRuntimeConfig } from './instance-stats.tokens';

/** How often the schedule is looked at (never more often than once a second). */
export function instanceStatsTickMs(sendIntervalS: number): number {
    return Math.min(60_000, Math.max(1_000, Math.floor((sendIntervalS * 1000) / 2)));
}

/**
 * The timer of the anonymous usage statistics module. It exists only when the
 * module is loaded (`EVER_STATS_ENABLED` is not `false`).
 *
 * Every tick reads the operator switch and the shared schedule from the
 * database and calls {@link InstanceStatsSenderService.runDue}, which sends
 * only when a report is due and the switch is on. The tick itself makes no
 * request; the first possible send is a day after the installation's first
 * boot. Boot work never blocks or fails the API start.
 */
@Injectable()
export class InstanceStatsSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(InstanceStatsSchedulerService.name);
    private timer: ReturnType<typeof setInterval> | null = null;
    private running = false;

    constructor(
        private readonly sender: InstanceStatsSenderService,
        @Inject(INSTANCE_STATS_CONFIG) private readonly config: InstanceStatsRuntimeConfig,
    ) {}

    onApplicationBootstrap(): void {
        for (const warning of this.config.warnings) {
            this.logger.warn(`ever-stats: ${warning}`);
        }
        // Switched off by `EVER_STATS_ENABLED` although the module was loaded:
        // no identity, no schedule, no timer — nothing runs.
        if (!this.config.enabled) {
            this.logger.warn('ever-stats: loaded_while_switched_off (nothing runs)');
            return;
        }
        void this.sender.initialise().catch((error: unknown) => {
            this.logger.warn(`ever-stats: initialise_failed (${errorName(error)})`);
        });
        this.timer = setInterval(
            () => void this.tick(),
            instanceStatsTickMs(this.config.sendIntervalS),
        );
        // Never keep the process alive for statistics.
        this.timer.unref?.();
    }

    onModuleDestroy(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /** One look at the schedule; overlapping ticks are skipped. */
    async tick(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            await this.sender.runDue();
        } catch (error) {
            this.logger.warn(`ever-stats: run_failed (${errorName(error)})`);
        } finally {
            this.running = false;
        }
    }
}

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'error';
}
