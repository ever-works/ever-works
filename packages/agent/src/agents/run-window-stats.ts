import {
    RUN_LEDGER_STATUSES,
    RUN_LEDGER_TERMINAL_STATUSES,
    RUN_REPEAT_FAILURE_THRESHOLD,
    type RunLedgerStatus,
    type RunLedgerWindow,
    type RunRepeatFailure,
    type RunWindowStats,
} from '@ever-works/contracts';
import type { RunLedgerAggregateRow } from '../database/repositories/agent-run.repository';

/**
 * Runs ledger (AW-09) — window statistics, as pure functions over grouped
 * rows. Nothing here reads a repository: the repository returns one row per
 * (status, trigger) group and one row per repeatedly-failing schedule, and
 * these functions turn that into the rail's headline numbers.
 */

/** One schedule's failure count inside a window. */
export interface RunRepeatFailureRow {
    agentId: string;
    failures: number;
}

const TERMINAL = new Set<string>(RUN_LEDGER_TERMINAL_STATUSES);

/** The schedule key the unified schedule list uses for an Agent heartbeat. */
export function heartbeatScheduleKey(agentId: string): string {
    return `agent_heartbeat:${agentId}`;
}

/** The schedule a run came from, or null when no schedule produced it. */
export function scheduleKeyForRun(run: { triggerKind: string; agentId: string }): string | null {
    return run.triggerKind === 'heartbeat' ? heartbeatScheduleKey(run.agentId) : null;
}

/**
 * Completed ÷ terminal as a percentage with one decimal place. Null when no
 * run in the window is terminal yet — a rate over nothing is not 0 % or 100 %.
 */
export function runSuccessRate(completed: number, terminal: number): number | null {
    if (!(terminal > 0)) return null;
    return Math.round((completed / terminal) * 1000) / 10;
}

/** Fold grouped rows + repeat-failure rows into the rail's statistics. */
export function computeRunWindowStats(
    window: RunLedgerWindow,
    rows: RunLedgerAggregateRow[],
    repeatRows: RunRepeatFailureRow[],
    agentNames: Map<string, string>,
): RunWindowStats {
    const byStatus = Object.fromEntries(RUN_LEDGER_STATUSES.map((s) => [s, 0])) as Record<
        RunLedgerStatus,
        number
    >;
    const byTrigger: Record<string, number> = {};
    let total = 0;
    let totalDurationMs = 0;
    let costCents = 0;
    let costedRuns = 0;
    let tokens = 0;
    let tokenRuns = 0;
    let terminal = 0;

    for (const row of rows) {
        const runs = safeCount(row.runs);
        if (runs === 0) continue;
        total += runs;
        if (row.status in byStatus) {
            byStatus[row.status as RunLedgerStatus] += runs;
        }
        if (TERMINAL.has(row.status)) terminal += runs;
        byTrigger[row.triggerKind] = (byTrigger[row.triggerKind] ?? 0) + runs;
        totalDurationMs += safeCount(row.durationMs);
        costCents += safeCount(row.costCents);
        costedRuns += safeCount(row.costedRuns);
        tokens += safeCount(row.tokens);
        tokenRuns += safeCount(row.tokenRuns);
    }

    return {
        window,
        total,
        byStatus,
        byTrigger,
        successRate: runSuccessRate(byStatus.completed, terminal),
        errorCount: byStatus.failed,
        totalDurationMs,
        costCents: costedRuns > 0 ? costCents : null,
        unsettledRuns: Math.max(0, total - costedRuns),
        tokens: {
            // The split is not recorded per run yet; only the total is.
            input: null,
            output: null,
            cacheRead: null,
            cacheWrite: null,
            total: tokenRuns > 0 ? tokens : null,
        },
        repeatFailures: computeRepeatFailures(repeatRows, agentNames),
    };
}

/** Schedules that failed at least {@link RUN_REPEAT_FAILURE_THRESHOLD} times, most failures first. */
export function computeRepeatFailures(
    rows: RunRepeatFailureRow[],
    agentNames: Map<string, string>,
    threshold: number = RUN_REPEAT_FAILURE_THRESHOLD,
): RunRepeatFailure[] {
    return rows
        .map((row) => ({ agentId: row.agentId, failures: safeCount(row.failures) }))
        .filter((row) => row.failures >= threshold)
        .sort((a, b) => b.failures - a.failures || a.agentId.localeCompare(b.agentId))
        .map((row) => ({
            scheduleKey: heartbeatScheduleKey(row.agentId),
            agentId: row.agentId,
            agentName: agentNames.get(row.agentId) ?? null,
            failures: row.failures,
        }));
}

/** Drivers hand SUM/COUNT back as strings (and NULL for empty groups). */
function safeCount(value: unknown): number {
    const n = Number(value ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
}
