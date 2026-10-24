import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { config } from '@ever-works/agent/config';
import { FleetPrEnrichmentService } from './fleet-pr-enrichment.service';

const FLEET_SESSION_GIT_TICK_LOCK_KEY = 'fleet-session-git:tick';

/**
 * Session git & actions (FL-06, plan §10) — the minute tick: the git-line
 * cadence of checkouts sessions work in (spec FR-11) and the pull-request
 * enrichment (spec FR-7). One replica at a time (the distributed task lock);
 * dark while `FLEET_SESSIONS_ENABLED` or `FLEET_CHECKOUTS_ENABLED` is off.
 *
 * It runs in the API whatever the job runtime: the enrichment keeps the
 * facts the relevance rules read (mergeability, open review comments) in this
 * process for a minute (plan §4), and the GitHub App credentials live here.
 * A Trigger.dev twin (`fleet-pr-enrichment`) is a follow-up in the lane log.
 */
@Injectable()
export class FleetSessionGitCronService {
    private readonly logger = new Logger(FleetSessionGitCronService.name);

    constructor(
        private readonly enrichment: FleetPrEnrichmentService,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(CronExpression.EVERY_MINUTE)
    async runTick(): Promise<void> {
        if (!config.fleet.isSessionsEnabled() || !config.fleet.isCheckoutsEnabled()) return;
        await this.taskLockService.runExclusive(
            FLEET_SESSION_GIT_TICK_LOCK_KEY,
            async () => {
                try {
                    const summary = await this.enrichment.tick();
                    if (summary.refreshed > 0 || summary.enriched > 0) {
                        this.logger.debug(
                            `fleet-session-git tick: ${summary.refreshed} git line(s) refreshed, ${summary.enriched} pull request(s) resolved`,
                        );
                    }
                } catch (error) {
                    const stack = error instanceof Error ? error.stack : String(error);
                    this.logger.error('fleet-session-git tick failed', stack);
                }
            },
            {
                // A tick is bounded (500 sessions, 80 provider asks); a crashed replica's lease lapses before the next.
                ttlMs: 55 * 1000,
                onLocked: () =>
                    this.logger.debug('Skipping fleet-session-git tick because another instance holds the task lock'),
            },
        );
    }
}
