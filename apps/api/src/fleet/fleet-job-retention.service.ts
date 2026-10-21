import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { config } from '@ever-works/agent/config';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { FleetCommandRepository, FleetJobRepository } from '@ever-works/agent/fleet';

/** Rows one purge batch touches. */
export const FLEET_JOB_PURGE_BATCH_SIZE = 200;
/** Batches one nightly pass may run before leaving the rest to tomorrow. */
export const FLEET_JOB_PURGE_MAX_BATCHES = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Self-build slice AP — the nightly retention pass over `fleet_jobs` bodies.
 *
 * A fleet job row carried its full `payload` — the whole assembled prompt,
 * up to 256 KB — and its `result` — up to 256 KB, now including the run's
 * redacted transcript — FOREVER: nothing purged, pruned or partitioned it.
 * This pass NULLs both bodies on every TERMINAL job (`done` / `failed`)
 * whose `completedAt` is older than the retention window, stamps
 * `bodiesPurgedAt`, and keeps the row: status, node, attempts, timings,
 * cost, error. What a run DID survives the purge where it belongs — in the
 * AgentRun, its `agent_run_logs` timeline (slice AP's step records) and the
 * Task — and the run still names its job through `agent_runs.remoteId`.
 *
 * The window is `FLEET_JOB_RETENTION_DAYS` (default 30, clamped to
 * [1, 3650]); `FLEET_JOB_PURGE_ENABLED=false` switches the pass off. Both
 * documented in `docs/features/fleet.md`.
 *
 * ## Same idiom as its siblings
 *
 * `SafetyRefusalPruneService` / `PluginUsageCleanupService`: a `@Cron`, a
 * {@link DistributedTaskLockService} guard so exactly one replica runs it,
 * bounded batches, and a failure that logs and returns — never throws out
 * of a cron tick. The cut-off is computed from `now`, not a stored cursor,
 * so tomorrow's pass picks up whatever this one left.
 *
 * ## 03:35 UTC
 *
 * Offset from the neighbours so the nightly passes do not stack on one
 * connection pool: transcript sweep 03:17, safety prune 03:20, plugin-usage
 * prune 04:00.
 *
 * Idempotent by construction: a purged row carries `bodiesPurgedAt` and the
 * batch query only ever selects rows where it is NULL.
 */
@Injectable()
export class FleetJobRetentionService {
    private readonly logger = new Logger(FleetJobRetentionService.name);

    constructor(
        private readonly jobs: FleetJobRepository,
        private readonly taskLock: DistributedTaskLockService,
        // Commands on computers (FL-12 P3, T-27): the stored heads and tails of
        // ended command runs. Appended LAST + @Optional(): unbound (Commands not
        // mounted), the second pass does nothing.
        @Optional() private readonly commandRuns?: FleetCommandRepository,
    ) {}

    /**
     * Commands on computers (FL-12 P3, T-27) — the nightly pass over
     * `fleet_command_runs`: the first and last 64 KiB stored for each ended run
     * are cleared once the run ended more than the fleet retention window ago
     * (`FLEET_JOB_RETENTION_DAYS`, default 30); the row stays (status, exit
     * code, timings, the refusal), and the machine's own copy of its last 30
     * runs is the machine's business. Same switch, lock idiom and batch bounds
     * as the job-body pass; 03:45 UTC so the two never share a minute.
     */
    @Cron('45 3 * * *')
    async purgeExpiredCommandOutputs(): Promise<void> {
        if (!config.fleet.isJobPurgeEnabled() || !this.commandRuns) return;
        await this.taskLock.runExclusive(
            'fleet-commands:purge-outputs',
            async () => {
                try {
                    const purged = await this.purgeCommandOutputs();
                    if (purged > 0) {
                        this.logger.log(
                            `Fleet command retention cleared the stored output of ${purged} run(s) older than ${config.fleet.getJobRetentionDays()} days`,
                        );
                    }
                } catch (error) {
                    this.logger.error('Fleet command retention purge failed:', error);
                }
            },
            {
                ttlMs: 60 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping the fleet command retention purge because another instance holds the task lock',
                    ),
            },
        );
    }

    /** The command-output pass in bounded batches; returns the runs cleared. */
    async purgeCommandOutputs(
        now: Date = new Date(),
        batchSize: number = FLEET_JOB_PURGE_BATCH_SIZE,
        maxBatches: number = FLEET_JOB_PURGE_MAX_BATCHES,
    ): Promise<number> {
        if (!this.commandRuns) return 0;
        const cutoff = new Date(now.getTime() - config.fleet.getJobRetentionDays() * DAY_MS);
        let total = 0;
        for (let batch = 0; batch < maxBatches; batch += 1) {
            const purged = await this.commandRuns.purgeEndedOutputs(cutoff, batchSize);
            total += purged;
            if (purged < batchSize) return total;
        }
        this.logger.warn(
            `Fleet command retention stopped at ${maxBatches} batches (${total} runs); the remainder is left to the next pass`,
        );
        return total;
    }

    @Cron('35 3 * * *')
    async purgeExpiredJobBodies(): Promise<void> {
        if (!config.fleet.isJobPurgeEnabled()) return;
        await this.taskLock.runExclusive(
            'fleet-jobs:purge-bodies',
            async () => {
                try {
                    const purged = await this.purge();
                    if (purged > 0) {
                        this.logger.log(
                            `Fleet job retention purged the payload/result of ${purged} terminal job(s) older than ${config.fleet.getJobRetentionDays()} days`,
                        );
                    }
                } catch (error) {
                    this.logger.error('Fleet job retention purge failed:', error);
                }
            },
            {
                ttlMs: 60 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping the fleet job retention purge because another instance holds the task lock',
                    ),
            },
        );
    }

    /**
     * Purge in bounded batches until one comes back short (the horizon is
     * clear) or the per-pass ceiling is reached. Returns the rows purged.
     */
    async purge(
        now: Date = new Date(),
        batchSize: number = FLEET_JOB_PURGE_BATCH_SIZE,
        maxBatches: number = FLEET_JOB_PURGE_MAX_BATCHES,
    ): Promise<number> {
        const cutoff = new Date(now.getTime() - config.fleet.getJobRetentionDays() * DAY_MS);
        let total = 0;
        for (let batch = 0; batch < maxBatches; batch += 1) {
            const purged = await this.jobs.purgeTerminalBodies(cutoff, batchSize, now);
            total += purged;
            if (purged < batchSize) return total;
        }
        this.logger.warn(
            `Fleet job retention stopped at ${maxBatches} batches (${total} rows); the remainder is left to the next pass`,
        );
        return total;
    }
}
