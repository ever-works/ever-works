import { TASK_COST_RUNS_LIMIT, type TaskCostRun, type TaskCostView } from '@ever-works/contracts';

/**
 * APW-08 T24 (cost half) — `GET /api/tasks/:id/cost`: what a Task cost.
 *
 * Read from the one ledger every other cost surface reads (`plugin_usage_events`), so a Task's cost
 * can never disagree with a run receipt or the Costs dashboard:
 *
 * - each run's cost is the sum of its own receipt lines (`getRunSpendLines`, failed calls
 *   excluded), `null` while the ledger holds no line for it;
 * - `totalCents` is every usage row attributed to the Task (`getTotalSpendCentsForTask`), which
 *   also covers usage outside an agent run;
 * - `builds` stays empty until per-Task Build accounting exists (see `TaskCostView.builds`).
 *
 * The caller checks access first (the Task route's own 404 for another account's Task).
 */

/** The two ledger reads, structural so a spec passes plain doubles. */
export interface TaskCostUsageReads {
    getTotalSpendCentsForTask(taskId: string, opts?: { currency?: string }): Promise<number>;
    getRunSpendLines(runId: string): Promise<Array<{ costCents: number }>>;
}

/** The Task's runs, newest first. */
export interface TaskCostRunReads {
    findRecentForTask(
        taskId: string,
        limit: number,
        offset?: number,
    ): Promise<
        Array<{
            id: string;
            status?: string | null;
            startedAt?: Date | string | null;
            createdAt?: Date | string | null;
        }>
    >;
}

const iso = (value: Date | string | null | undefined): string | null => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

/** The run's receipt page in the web app. */
export function runReceiptUrl(runId: string): string {
    return `/agents/sessions/${encodeURIComponent(runId)}`;
}

export async function buildTaskCostView(
    taskId: string,
    deps: { usage: TaskCostUsageReads; runs?: TaskCostRunReads | null },
    currency = 'usd',
): Promise<TaskCostView> {
    const [total, rows] = await Promise.all([
        deps.usage.getTotalSpendCentsForTask(taskId, { currency }),
        deps.runs
            ? deps.runs.findRecentForTask(taskId, TASK_COST_RUNS_LIMIT + 1)
            : Promise.resolve([]),
    ]);
    const listed = rows.slice(0, TASK_COST_RUNS_LIMIT);
    const runs: TaskCostRun[] = await Promise.all(
        listed.map(async (run) => {
            const lines = await deps.usage.getRunSpendLines(run.id).catch(() => null);
            const costCents =
                lines && lines.length > 0
                    ? lines.reduce((sum, line) => sum + (Number(line.costCents) || 0), 0)
                    : null;
            return {
                runId: run.id,
                costCents,
                receiptUrl: runReceiptUrl(run.id),
                status: run.status ?? null,
                startedAt: iso(run.startedAt ?? run.createdAt),
            };
        }),
    );
    return {
        taskId,
        runs,
        builds: [],
        totalCents: Number.isFinite(total) ? total : null,
        currency,
        runsLimit: TASK_COST_RUNS_LIMIT,
        runsTruncated: rows.length > TASK_COST_RUNS_LIMIT,
    };
}
