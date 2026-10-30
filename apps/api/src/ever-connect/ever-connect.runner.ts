import {
    Inject,
    Injectable,
    Logger,
    OnApplicationBootstrap,
    OnModuleDestroy,
} from '@nestjs/common';
import { EVER_CONNECT_CONFIG, type EverConnectConfig } from './ever-connect.config';
import { EverConnectFeedService } from './ever-connect-feed.service';
import { EverConnectIntegrationService } from './ever-connect-integration.service';
import { EverConnectLeaseService } from './ever-connect-lease.service';
import { EverConnectOutboxWorker } from './ever-connect-outbox.service';
import { EverConnectService } from './ever-connect.service';
import { EverIdLoginHandler } from './identity/ever-id-login.handler';

/** The long-poll wait of one feed read (`longpoll` mode). */
export const FEED_LONGPOLL_WAIT_S = 25;
/** Between two feed reads in `interval` mode. */
export const FEED_INTERVAL_MS = 15 * 60_000;
/** Between two rounds of the worker (the outbox; the feed in `longpoll` mode). */
export const WORKER_ROUND_MS = 30_000;
/** At most this many feed pages are read in one round. */
export const FEED_PAGES_PER_ROUND = 10;

/**
 * Runs Ever Connect in the background once the API is up:
 *
 * 1. A connect code in `EVER_CONNECT_CODE` is used once, at the first boot
 *    that sees it (its hash is kept; a failed attempt is shown to the
 *    operator, who can connect from the admin route).
 * 2. When connected, the integration states are read and, with
 *    `ever_id_login` on, the Ever ID sign-in client is made sure of.
 * 3. On the replica holding the Ever Connect lease: the feed is read
 *    (long-poll, or every 15 minutes) and the outbox sent, every round.
 *
 * Nothing runs while the installation is not connected beyond reading the
 * local connection row.
 */
@Injectable()
export class EverConnectRunner implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(EverConnectRunner.name);
    private timer: NodeJS.Timeout | null = null;
    private stopped = false;
    private lastFeedReadAt = 0;

    constructor(
        @Inject(EVER_CONNECT_CONFIG) private readonly config: EverConnectConfig,
        private readonly connection: EverConnectService,
        private readonly integrations: EverConnectIntegrationService,
        private readonly login: EverIdLoginHandler,
        private readonly lease: EverConnectLeaseService,
        private readonly feed: EverConnectFeedService,
        private readonly outbox: EverConnectOutboxWorker,
    ) {}

    onApplicationBootstrap(): void {
        setImmediate(() => {
            this.boot()
                .catch((error) =>
                    this.logger.warn(`Ever Connect did not start: ${errorName(error)}`),
                )
                .finally(() => this.schedule(WORKER_ROUND_MS));
        });
    }

    async onModuleDestroy(): Promise<void> {
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        await this.lease.release().catch(() => undefined);
    }

    /** Step 1 and 2 above. */
    async boot(): Promise<void> {
        const code = this.config.connectCode;
        if (code && (await this.connection.status()).status === 'disconnected') {
            if (await this.connection.markEnvCodeUsed(code)) {
                try {
                    await this.connection.connect(code);
                } catch (error) {
                    this.logger.warn(
                        `The connect code from the environment was not used: ${errorName(error)}`,
                    );
                }
            }
        }
        if (!(await this.connection.client())) return;
        await this.integrations.refresh();
        if (await this.integrations.isEnabled()) await this.login.start();
    }

    /** One round of step 3; `true` when it ran on this replica. */
    async round(now = Date.now()): Promise<boolean> {
        if (!(await this.connection.client())) return false;
        if (!(await this.lease.hold(new Date(now)))) return false;
        const longpoll = this.config.feedMode === 'longpoll';
        if (longpoll || now - this.lastFeedReadAt >= FEED_INTERVAL_MS) {
            this.lastFeedReadAt = now;
            try {
                let pass = await this.feed.pollOnce(longpoll ? FEED_LONGPOLL_WAIT_S : 0);
                // A long backlog is read over several rounds, so the lease is
                // renewed and the outbox sent on schedule.
                for (
                    let page = 1;
                    pass.more && !this.stopped && page < FEED_PAGES_PER_ROUND;
                    page += 1
                ) {
                    pass = await this.feed.pollOnce(0);
                }
            } catch (error) {
                this.logger.warn(`Reading the Ever Platform feed failed: ${errorName(error)}`);
            }
        }
        await this.outbox.drainOnce();
        return true;
    }

    private schedule(delayMs: number): void {
        if (this.stopped) return;
        this.timer = setTimeout(() => {
            this.round()
                .catch((error) =>
                    this.logger.warn(`Ever Connect round failed: ${errorName(error)}`),
                )
                .finally(() => this.schedule(WORKER_ROUND_MS));
        }, delayMs);
        this.timer.unref?.();
    }
}

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'unknown';
}
