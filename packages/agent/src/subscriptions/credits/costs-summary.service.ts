import { Injectable } from '@nestjs/common';
import { AgentRunRepository } from '@src/database/repositories/agent-run.repository';
import { PluginUsageRepository } from '@src/database/repositories/plugin-usage.repository';
import type { AgentRun } from '@src/entities/agent-run.entity';

/**
 * Costs dashboard — the rolling windows the Costs view offers.
 *
 * Deliberately NOT the Usage & Credits page's `YYYY-MM | 7d | 30d`
 * period vocabulary: Costs answers "what has this account been burning
 * lately", which is a rolling question, and it needs a 90-day arm the
 * calendar-month grammar has no way to express. The two selectors stay
 * independent so neither page's contract has to move.
 */
export const COSTS_WINDOW_DAYS = [7, 30, 90] as const;
export type CostsWindowDays = (typeof COSTS_WINDOW_DAYS)[number];

/** Default window when the caller sends none. */
export const COSTS_DEFAULT_WINDOW_DAYS: CostsWindowDays = 30;

/** Default / maximum rows the top-runs table returns. */
export const COSTS_TOP_RUNS_DEFAULT_LIMIT = 20;
export const COSTS_TOP_RUNS_MAX_LIMIT = 50;

/**
 * How many Agent series the stacked daily chart keeps separate before
 * folding the tail into {@link COSTS_OTHER_SERIES_KEY}. Beyond this the
 * stack stops being readable and the legend stops fitting.
 */
export const COSTS_DAILY_MAX_SERIES = 6;

/**
 * Series keys for the two buckets that are not an Agent id. Both are
 * safe sentinels: every real key is a UUID, so neither can collide.
 *
 * - `unattributed` — real spend that never ran inside an Agent (the
 *   Work-generator flow, ad-hoc facade calls). Shown, never dropped.
 * - `other`        — the folded tail of the per-Agent series.
 */
export const COSTS_UNATTRIBUTED_SERIES_KEY = 'unattributed';
export const COSTS_OTHER_SERIES_KEY = 'other';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Stable-named error so the API boundary maps a bad window to a 400
 * (never an unmapped 500) — sibling of `InvalidUsagePeriodError`.
 */
export class InvalidCostsWindowError extends Error {
    constructor(windowDays: unknown) {
        super(
            `Invalid windowDays (expected one of ${COSTS_WINDOW_DAYS.join(', ')}): ${windowDays}`,
        );
        this.name = 'InvalidCostsWindowError';
    }
}

/** Resolved half-open `[from, to)` aggregation window. */
export interface CostsWindow {
    windowDays: CostsWindowDays;
    from: Date;
    to: Date;
}

/**
 * Pure, exported for unit tests + the API DTO layer: resolve a window
 * length to a half-open `[from, to)` range ending "now".
 *
 * `from` is snapped to UTC midnight so the daily chart's first bucket is
 * a WHOLE day rather than a partial one whose bar is short for reasons
 * that have nothing to do with spend. `to` stays "now" so the newest
 * events are included the moment they land.
 */
export function resolveCostsWindow(windowDays?: number, now: Date = new Date()): CostsWindow {
    const requested = windowDays ?? COSTS_DEFAULT_WINDOW_DAYS;
    if (!(COSTS_WINDOW_DAYS as readonly number[]).includes(requested)) {
        throw new InvalidCostsWindowError(windowDays);
    }
    const days = requested as CostsWindowDays;
    // `days - 1` because the current (partial) day is one of them: a 7d
    // window is "today plus the six whole days before it", not "today
    // plus seven", which would render eight buckets.
    const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return {
        windowDays: days,
        from: new Date(startOfToday - (days - 1) * DAY_MS),
        to: now,
    };
}

/** Every Costs payload echoes the window it was computed over. */
interface CostsWindowEcho {
    windowDays: CostsWindowDays;
    from: string;
    to: string;
}

/** Headline numbers for the window. */
export interface CostsSummary extends CostsWindowEcho {
    /** Metered spend in the window (`plugin_usage_events.costCents`). */
    totalCostCents: number;
    /** Agent runs created in the window (settled or not). */
    runsCount: number;
    /** `totalCostCents / runsCount`, rounded; 0 when there were no runs. */
    avgPerRunCents: number;
}

/** One series of the stacked daily chart. */
export interface CostsDailySeries {
    /** Agent id, or one of the two sentinel keys. */
    key: string;
    /** Agent name; null for the sentinel series (the UI localizes those). */
    label: string | null;
    /** Series total across the whole window — drives the legend order. */
    costCents: number;
}

/** One day of the stacked daily chart (dense — zero days included). */
export interface CostsDailyBucket {
    /** `YYYY-MM-DD`, UTC. */
    day: string;
    totalCostCents: number;
    /** Cents per series key. Keys absent from a day simply had no spend. */
    costs: Record<string, number>;
}

export interface CostsDaily extends CostsWindowEcho {
    series: CostsDailySeries[];
    days: CostsDailyBucket[];
}

/** One row of the per-Agent breakdown table. */
export interface CostsByAgentRow {
    /** Null for spend recorded outside any Agent run. */
    agentId: string | null;
    /** Agent name; null when unattributed or the Agent was deleted. */
    name: string | null;
    costCents: number;
    /** Runs this Agent started in the window (0 for the unattributed row). */
    runs: number;
    /** `costCents / runs`, rounded; 0 when `runs` is 0. */
    avgPerRunCents: number;
}

export interface CostsByAgent extends CostsWindowEcho {
    rows: CostsByAgentRow[];
}

/** One row of the per-model breakdown. */
export interface CostsByModelRow {
    /** Null for capabilities that never go through a model (search, …). */
    modelId: string | null;
    units: number;
    costCents: number;
    /** Share of the window's total spend, 0–100, one decimal place. */
    sharePercent: number;
}

export interface CostsByModel extends CostsWindowEcho {
    totalCostCents: number;
    rows: CostsByModelRow[];
}

/** One row of the top-runs table. */
export interface CostsTopRunRow {
    runId: string;
    costCents: number;
    agentId: string;
    agentName: string | null;
    taskId: string | null;
    taskTitle: string | null;
    // Deliberately no `workId`: the row would carry an id the UI has no
    // name for and therefore cannot render, and a wire field with no
    // consumer is the kind of half-wiring that rots. Add it together
    // with the Work-name resolution when a Work column is wanted.
    /** The run's dominant model; null when its events carry no model id. */
    modelId: string | null;
    /** Terminal state — a failed run that still cost money matters. */
    status: string;
    /** `heartbeat | manual | task | chat | event` — labels a task-less run. */
    triggerKind: string;
    /** ISO timestamp, or null on a run that never started. */
    startedAt: string | null;
}

export interface CostsTopRuns extends CostsWindowEcho {
    rows: CostsTopRunRow[];
}

/**
 * Costs dashboard — owner-scoped AI-spend aggregations behind
 * `GET /api/usage/costs/*`.
 *
 * Reads ONLY, and derives everything from rows that already exist:
 * `plugin_usage_events` is the per-call metering source of truth and
 * `agent_runs.costCents` is its per-run rollup (stamped by
 * `RunCostSettlementService` on every terminal transition). Nothing here
 * writes, and nothing here re-derives a cost the settlement path already
 * computed.
 *
 * Every panel is a bounded number of grouped queries — one per
 * dimension, plus at most one `IN` name-resolution query — never a
 * lookup per row.
 *
 * ## Cache-hit rate is deliberately absent
 *
 * The per-agent table has no cache-hit column because the platform does
 * not record one. `PluginUsageService.record` stores
 * `{ promptTokens, completionTokens }` in `metadata`; nothing on the
 * dispatch path reports `cache_read_input_tokens` (the one plugin that
 * receives it — `claude-managed-agent` — surfaces it as pipeline metrics
 * that are never persisted). `WorkRunsSummary` documents the same
 * finding for its token rollup. Deriving a percentage from data that
 * does not exist would be a fabricated number, so the column is omitted
 * until the emission seam carries the field; see
 * `docs/internal/feat-costs-notes.md` for the follow-up.
 */
@Injectable()
export class CostsSummaryService {
    constructor(
        private readonly pluginUsageRepository: PluginUsageRepository,
        private readonly agentRunRepository: AgentRunRepository,
    ) {}

    /** Headline total + run count + average cost per run. */
    async getSummary(userId: string, windowDays?: number): Promise<CostsSummary> {
        const window = resolveCostsWindow(windowDays);
        const [totalCostCents, counts] = await Promise.all([
            this.pluginUsageRepository.getTotalSpendCentsForUser(userId, window.from, window.to),
            this.pluginUsageRepository.getUsageCountsForUser(userId, window.from, window.to),
        ]);

        return {
            ...echo(window),
            totalCostCents,
            runsCount: counts.agentRuns,
            avgPerRunCents: perRun(totalCostCents, counts.agentRuns),
        };
    }

    /** Daily spend, stacked by Agent, dense across the whole window. */
    async getDaily(userId: string, windowDays?: number): Promise<CostsDaily> {
        const window = resolveCostsWindow(windowDays);
        const buckets = await this.pluginUsageRepository.getDailySpendByAgentForUser(
            userId,
            window.from,
            window.to,
        );

        // Window totals per Agent decide which series survive the fold.
        const totalsByAgent = new Map<string | null, number>();
        for (const bucket of buckets) {
            totalsByAgent.set(
                bucket.agentId,
                (totalsByAgent.get(bucket.agentId) ?? 0) + bucket.costCents,
            );
        }

        const agentIds = Array.from(totalsByAgent.keys()).filter((id): id is string => id !== null);
        const names = await this.pluginUsageRepository.getAgentNames(agentIds);

        const ranked = agentIds
            .map((agentId) => ({ agentId, costCents: totalsByAgent.get(agentId) ?? 0 }))
            // Cost first, id second: without the tie-break two agents on
            // equal spend could swap places between two identical calls.
            .sort((a, b) => b.costCents - a.costCents || a.agentId.localeCompare(b.agentId));

        const keptIds = new Set(ranked.slice(0, COSTS_DAILY_MAX_SERIES).map((r) => r.agentId));
        const foldedIds = ranked.slice(COSTS_DAILY_MAX_SERIES);

        const seriesKeyFor = (agentId: string | null): string => {
            if (agentId === null) {
                return COSTS_UNATTRIBUTED_SERIES_KEY;
            }
            return keptIds.has(agentId) ? agentId : COSTS_OTHER_SERIES_KEY;
        };

        const series: CostsDailySeries[] = ranked
            .filter((row) => keptIds.has(row.agentId))
            .map((row) => ({
                key: row.agentId,
                label: names.get(row.agentId) ?? null,
                costCents: row.costCents,
            }));
        if (foldedIds.length > 0) {
            series.push({
                key: COSTS_OTHER_SERIES_KEY,
                label: null,
                costCents: foldedIds.reduce((sum, row) => sum + row.costCents, 0),
            });
        }
        if (totalsByAgent.has(null)) {
            series.push({
                key: COSTS_UNATTRIBUTED_SERIES_KEY,
                label: null,
                costCents: totalsByAgent.get(null) ?? 0,
            });
        }

        // Dense day axis: a gap day must render as an empty slot, not
        // vanish and make two non-adjacent days look adjacent.
        const days = new Map<string, CostsDailyBucket>();
        for (const day of enumerateDays(window)) {
            days.set(day, { day, totalCostCents: 0, costs: {} });
        }
        for (const bucket of buckets) {
            const target = days.get(bucket.day);
            if (!target) {
                // Defensive: an event exactly on the `to` boundary cannot
                // occur (half-open window), so this is unreachable in
                // practice — dropping it silently would be the bug.
                continue;
            }
            const key = seriesKeyFor(bucket.agentId);
            target.costs[key] = (target.costs[key] ?? 0) + bucket.costCents;
            target.totalCostCents += bucket.costCents;
        }

        return { ...echo(window), series, days: Array.from(days.values()) };
    }

    /** Per-Agent spend, run count and average cost per run. */
    async getByAgent(userId: string, windowDays?: number): Promise<CostsByAgent> {
        const window = resolveCostsWindow(windowDays);
        const [spendRows, runCounts] = await Promise.all([
            this.pluginUsageRepository.getSpendByAgentForUser(userId, window.from, window.to),
            this.agentRunRepository.countRunsByAgentForUser(userId, window.from, window.to),
        ]);

        const runsByAgent = new Map(runCounts.map((row) => [row.agentId, row.runs]));
        const names = await this.pluginUsageRepository.getAgentNames(
            spendRows.map((row) => row.key).filter((key): key is string => key !== null),
        );

        const rows: CostsByAgentRow[] = spendRows.map((row) => {
            // The unattributed bucket has no runs BY DEFINITION — its
            // events are the ones with no run behind them — so its
            // average stays 0 rather than dividing by an unrelated count.
            const runs = row.key === null ? 0 : (runsByAgent.get(row.key) ?? 0);
            return {
                agentId: row.key,
                name: row.key === null ? null : (names.get(row.key) ?? null),
                costCents: row.costCents,
                runs,
                avgPerRunCents: perRun(row.costCents, runs),
            };
        });

        return { ...echo(window), rows };
    }

    /** Per-model spend with each model's share of the window total. */
    async getByModel(userId: string, windowDays?: number): Promise<CostsByModel> {
        const window = resolveCostsWindow(windowDays);
        const rows = await this.pluginUsageRepository.getSpendByModelForUser(
            userId,
            window.from,
            window.to,
        );

        // Share is computed against the SUM OF THESE ROWS, not against a
        // separately-queried total: the two queries could straddle a new
        // event and produce shares that do not add up to 100%.
        const totalCostCents = rows.reduce((sum, row) => sum + row.costCents, 0);

        return {
            ...echo(window),
            totalCostCents,
            rows: rows.map((row) => ({
                modelId: row.key,
                units: row.units,
                costCents: row.costCents,
                sharePercent: sharePercent(row.costCents, totalCostCents),
            })),
        };
    }

    /** The window's most expensive runs, with their Agent/Task/model. */
    async getTopRuns(
        userId: string,
        windowDays?: number,
        limit: number = COSTS_TOP_RUNS_DEFAULT_LIMIT,
    ): Promise<CostsTopRuns> {
        const window = resolveCostsWindow(windowDays);
        const take = clampLimit(limit);
        const runs = await this.agentRunRepository.findTopByCostForUser(
            userId,
            window.from,
            window.to,
            take,
        );

        const [agentNames, taskTitles, models] = await Promise.all([
            this.pluginUsageRepository.getAgentNames(unique(runs.map((run) => run.agentId))),
            this.pluginUsageRepository.getTaskTitles(
                unique(runs.map((run) => run.taskId).filter((id): id is string => !!id)),
            ),
            this.pluginUsageRepository.getDominantModelByRun(runs.map((run) => run.id)),
        ]);

        return {
            ...echo(window),
            rows: runs.map((run) => this.toTopRunRow(run, agentNames, taskTitles, models)),
        };
    }

    private toTopRunRow(
        run: AgentRun,
        agentNames: Map<string, string>,
        taskTitles: Map<string, string>,
        models: Map<string, string>,
    ): CostsTopRunRow {
        return {
            runId: run.id,
            costCents: run.costCents ?? 0,
            agentId: run.agentId,
            agentName: agentNames.get(run.agentId) ?? null,
            taskId: run.taskId ?? null,
            taskTitle: run.taskId ? (taskTitles.get(run.taskId) ?? null) : null,
            modelId: models.get(run.id) ?? null,
            status: run.status,
            triggerKind: run.triggerKind,
            startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : null,
        };
    }
}

function echo(window: CostsWindow): CostsWindowEcho {
    return {
        windowDays: window.windowDays,
        from: window.from.toISOString(),
        to: window.to.toISOString(),
    };
}

/** Integer-cent average; 0 runs means 0, never NaN or Infinity. */
function perRun(totalCostCents: number, runs: number): number {
    return runs > 0 ? Math.round(totalCostCents / runs) : 0;
}

/** Share as a percentage with one decimal; 0 total means 0, never NaN. */
function sharePercent(costCents: number, totalCostCents: number): number {
    if (totalCostCents <= 0) {
        return 0;
    }
    return Math.round((costCents / totalCostCents) * 1000) / 10;
}

function clampLimit(limit: number): number {
    if (!Number.isFinite(limit) || limit < 1) {
        return COSTS_TOP_RUNS_DEFAULT_LIMIT;
    }
    return Math.min(Math.floor(limit), COSTS_TOP_RUNS_MAX_LIMIT);
}

function unique(values: string[]): string[] {
    return Array.from(new Set(values));
}

/** Every UTC `YYYY-MM-DD` the window touches, ascending. */
function enumerateDays(window: CostsWindow): string[] {
    const days: string[] = [];
    const last = Date.UTC(
        window.to.getUTCFullYear(),
        window.to.getUTCMonth(),
        window.to.getUTCDate(),
    );
    for (let cursor = window.from.getTime(); cursor <= last; cursor += DAY_MS) {
        days.push(new Date(cursor).toISOString().slice(0, 10));
    }
    return days;
}
