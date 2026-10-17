import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { config } from '@ever-works/agent/config';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { AgentRunLogRepository, AgentRunRepository } from '@ever-works/agent/database';

/** Runs one retention batch touches. */
export const AGENT_RUN_RETENTION_BATCH_SIZE = 200;
/** Batches one nightly pass may run, per phase, before leaving the rest to tomorrow. */
export const AGENT_RUN_RETENTION_MAX_BATCHES = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What one retention pass did. */
export interface AgentRunRetentionSummary {
    /** Terminal runs whose timeline was purged this pass. */
    runsWithLogsPurged: number;
    /** `agent_run_logs` rows deleted with them. */
    logRowsDeleted: number;
    /** Run ROWS deleted (opt-in, `AGENT_RUN_RETENTION_DAYS`). */
    runsDeleted: number;
}

/**
 * Self-build slice AT — platform data durability: the nightly retention pass
 * over agent runs.
 *
 * `agent_run_logs` (every run's step timeline — the fleet step records, the
 * cloud tool loop, chat turns) grew without bound: nothing purged it. This pass
 * deletes the timeline of every TERMINAL run that finished more than
 * `AGENT_RUN_LOG_RETENTION_DAYS` ago (default 90 — the same window the
 * workspace export already trims run logs to) and stamps `logsPurgedAt` on the
 * run. The run ROW — status, summary, cost, timings, check results — is kept,
 * the same "bodies go, the row stays" posture as {@link FleetJobRetentionService}.
 *
 * Deleting run rows themselves is OPT-IN (`AGENT_RUN_RETENTION_DAYS`, unset =
 * forever): cost dashboards, Task history and the audit tables name runs by
 * id, so an operator who wants rows gone says so and picks the window (≥ 30
 * days, and never before the row's logs were purged).
 *
 * Never touched: a run waiting on a human (`awaitingInput`) or parked for a
 * resume (`terminalEndedReason = 'parked'`), whatever its age.
 *
 * `AGENT_RUN_RETENTION_ENABLED=false` switches the whole pass off (an audit
 * hold). Same idiom as its siblings: a `@Cron`, one replica via
 * {@link DistributedTaskLockService}, bounded batches, a failure that logs and
 * returns. 03:45 UTC — after the fleet job purge (03:35), before the
 * plugin-usage prune (04:00).
 */
@Injectable()
export class AgentRunRetentionService {
    private readonly logger = new Logger(AgentRunRetentionService.name);

    constructor(
        private readonly runs: AgentRunRepository,
        private readonly runLogs: AgentRunLogRepository,
        private readonly taskLock: DistributedTaskLockService,
    ) {}

    @Cron('45 3 * * *')
    async purgeExpiredRuns(): Promise<void> {
        if (!config.agents.isRunRetentionEnabled()) return;
        await this.taskLock.runExclusive(
            'agent-runs:retention',
            async () => {
                try {
                    const summary = await this.purge();
                    if (summary.runsWithLogsPurged > 0 || summary.runsDeleted > 0) {
                        this.logger.log(
                            `Agent run retention: purged the timeline of ${summary.runsWithLogsPurged} run(s) ` +
                                `(${summary.logRowsDeleted} log rows, older than ${config.agents.getRunLogRetentionDays()} days)` +
                                (summary.runsDeleted > 0
                                    ? `; deleted ${summary.runsDeleted} run row(s) older than ${config.agents.getRunRetentionDays()} days`
                                    : ''),
                        );
                    }
                } catch (error) {
                    this.logger.error('Agent run retention pass failed:', error);
                }
            },
            {
                ttlMs: 60 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping the agent run retention pass because another instance holds the task lock',
                    ),
            },
        );
    }

    /**
     * Purge in bounded batches until one comes back short (the horizon is
     * clear) or the per-phase ceiling is reached.
     */
    async purge(
        now: Date = new Date(),
        batchSize: number = AGENT_RUN_RETENTION_BATCH_SIZE,
        maxBatches: number = AGENT_RUN_RETENTION_MAX_BATCHES,
    ): Promise<AgentRunRetentionSummary> {
        const summary: AgentRunRetentionSummary = {
            runsWithLogsPurged: 0,
            logRowsDeleted: 0,
            runsDeleted: 0,
        };

        const logCutoff = new Date(now.getTime() - config.agents.getRunLogRetentionDays() * DAY_MS);
        let finished = false;
        for (let batch = 0; batch < maxBatches; batch += 1) {
            const runIds = await this.runs.findLogRetentionCandidates(logCutoff, batchSize);
            if (runIds.length === 0) {
                finished = true;
                break;
            }
            // Logs first, stamp second: a pass that dies in between leaves the
            // marker unset, so tomorrow re-selects the run and deletes nothing
            // new — never a run marked purged whose rows survived.
            summary.logRowsDeleted += await this.runLogs.deleteForRuns(runIds);
            summary.runsWithLogsPurged += await this.runs.markLogsPurged(runIds, now);
            if (runIds.length < batchSize) {
                finished = true;
                break;
            }
        }
        if (!finished) {
            this.logger.warn(
                `Agent run retention stopped at ${maxBatches} timeline batches; the remainder is left to the next pass`,
            );
        }

        const runDays = config.agents.getRunRetentionDays();
        if (runDays > 0) {
            const runCutoff = new Date(now.getTime() - runDays * DAY_MS);
            for (let batch = 0; batch < maxBatches; batch += 1) {
                const deleted = await this.runs.deleteRetainedRuns(runCutoff, batchSize);
                summary.runsDeleted += deleted;
                if (deleted < batchSize) break;
            }
        }
        return summary;
    }
}
