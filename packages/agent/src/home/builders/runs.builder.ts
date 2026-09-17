import { Injectable, Optional } from '@nestjs/common';
import {
    HOME_RUN_ACTIVITY_MAX_CHARS,
    HOME_WORKING_NOW_MAX,
    truncateHomeText,
    type HomeRunningRow,
    type HomeWorkingNow,
    type RunLedgerRow,
    type RunWindowStats,
} from '@ever-works/contracts';
import { AgentRunRepository } from '../../database/repositories/agent-run.repository';
import type { AgentRun } from '../../entities/agent-run.entity';
import { RunLedgerService } from '../../agents/run-ledger.service';
import {
    HomeSourceUnavailableError,
    memoizeInBuild,
    type HomeBuildContext,
} from '../home-build-context';

/** The three run-derived glance counters. */
export interface HomeRunCounters {
    workingNow: number;
    doneToday: number;
    failedToday: number;
}

/** Map running ledger rows onto Working now rows. Pure. */
export function toHomeWorkingNow(rows: RunLedgerRow[], total: number, now: Date): HomeWorkingNow {
    const mapped: HomeRunningRow[] = rows.slice(0, HOME_WORKING_NOW_MAX).map((row) => {
        const started = row.startedAt ? Date.parse(row.startedAt) : Number.NaN;
        return {
            runId: row.id,
            agentId: row.agentId,
            agentName: row.agentName,
            activity: truncateHomeText(row.currentActivity, HOME_RUN_ACTIVITY_MAX_CHARS),
            startedAt: row.startedAt,
            elapsedMs: Number.isNaN(started) ? 0 : Math.max(0, now.getTime() - started),
        };
    });
    return { rows: mapped, total: Math.max(total, mapped.length) };
}

/** Read `done today` and `failed today` off the ledger's day stats. Pure. */
export function toHomeRunCounters(workingNow: number, stats: RunWindowStats): HomeRunCounters {
    return {
        workingNow,
        doneToday: stats.byStatus.completed ?? 0,
        failedToday: stats.byStatus.failed ?? 0,
    };
}

/**
 * Working now and the run counters — read through the surfaces that already
 * own runs: the Sessions list query (running, not waiting on a human,
 * longest-running first) and the Runs ledger's day stats, whose window is
 * the one the counters link to.
 */
@Injectable()
export class HomeRunsBuilder {
    constructor(
        @Optional() private readonly runLedger?: RunLedgerService,
        @Optional() private readonly agentRuns?: AgentRunRepository,
    ) {}

    async workingNow(context: HomeBuildContext): Promise<HomeWorkingNow> {
        if (!this.runLedger) throw new HomeSourceUnavailableError('runs');
        const { rows, total } = await this.running(context);
        return toHomeWorkingNow(await this.runLedger.toRows(rows), total, context.now);
    }

    async counters(context: HomeBuildContext): Promise<HomeRunCounters> {
        const runLedger = this.runLedger;
        if (!runLedger) throw new HomeSourceUnavailableError('runs');
        const [running, stats] = await Promise.all([
            this.running(context),
            runLedger.getStats(
                context.userId,
                { granularity: 'day', timezone: context.timezone, now: context.now },
                context.scope,
            ),
        ]);
        return toHomeRunCounters(running.total, stats);
    }

    /** Running Runs not waiting on a human — shared by both reads in one build. */
    private running(context: HomeBuildContext): Promise<{ rows: AgentRun[]; total: number }> {
        const agentRuns = this.agentRuns;
        if (!agentRuns) return Promise.reject(new HomeSourceUnavailableError('runs'));
        return memoizeInBuild(context, 'runs:running', async () => {
            const [rows, total] = await agentRuns.listSessionsForUser(
                context.userId,
                { status: 'running', awaitingInput: false, order: 'longest-running' },
                HOME_WORKING_NOW_MAX,
                0,
                context.scope,
            );
            return { rows, total };
        });
    }
}
