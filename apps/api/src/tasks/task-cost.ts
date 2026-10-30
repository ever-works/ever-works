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

/** APW-08 T48 — the Cost view's containment half (`AppWorkTaskContainmentReader`), structural. */
export interface TaskCostContainmentReads {
    describeForTask(task: {
        id: string;
        userId: string;
        workId?: string | null;
        agentId?: string | null;
        tenantId?: string | null;
        organizationId?: string | null;
        /** Who is looking: Allow / Withdraw are offered only on that viewer's own nodes. */
        viewerUserId?: string | null;
    }): Promise<Pick<TaskCostView, 'containment' | 'containmentHolds'> | null>;
}

/**
 * APW-08 T48 / T12 (FR-70, S33, ACC-08-34) — add what the Task's latest Fleet run got and which
 * nodes hold its next run, for a Task on an App Work. Every other Task's view is returned exactly
 * as {@link buildTaskCostView} built it (no keys added), and so is any Task whose reader is
 * unbound or fails: the cost half must never be lost to the containment half.
 */
export async function withTaskContainment(
    view: TaskCostView,
    task: Parameters<TaskCostContainmentReads['describeForTask']>[0],
    reader?: TaskCostContainmentReads | null,
): Promise<TaskCostView> {
    if (!reader) return view;
    try {
        const described = await reader.describeForTask(task);
        if (!described) return view;
        return {
            ...view,
            containment: described.containment ?? null,
            containmentHolds: described.containmentHolds ?? [],
        };
    } catch {
        return view;
    }
}
