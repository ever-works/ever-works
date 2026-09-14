import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
    Between,
    In,
    LessThan,
    Repository,
    type ObjectLiteral,
    type SelectQueryBuilder,
} from 'typeorm';
import { PluginUsageCapability, PluginUsageEvent } from '@src/entities/plugin-usage-event.entity';
import { UsageOutcome } from '@src/entities/_types';
import { Agent } from '@src/entities/agent.entity';
import { AgentRun } from '@src/entities/agent-run.entity';
import { Task, TaskStatus } from '@src/entities/task.entity';
import { Work } from '@src/entities/work.entity';
import { Mission } from '@src/entities/mission.entity';

export type PerPluginSpend = {
    pluginId: string;
    capability: PluginUsageCapability;
    units: number;
    costCents: number;
};

export type DailySpendBucket = {
    day: string;
    costCents: number;
};

/**
 * Costs dashboard — one (day, agent) cell of the stacked daily chart.
 * `agentId` is `null` for usage recorded outside an Agent run.
 */
export type DailyAgentSpendBucket = {
    day: string;
    agentId: string | null;
    costCents: number;
};

export type CrossUserSpendRow = {
    userId: string;
    workId: string;
    units: number;
    costCents: number;
};

/** Pricing Wave 9 M2 — one run's metered spend, grouped per plugin. */
export type RunPluginSpend = {
    pluginId: string;
    costCents: number;
};

/** Run receipt (AW-09) — one run's usage for one (capability, model) pair. */
export type RunSpendLine = {
    capability: string;
    modelId: string | null;
    calls: number;
    units: number;
    costCents: number;
};

/**
 * Wave 13 (Billing/Usage UI) — one grouped account-wide spend row.
 * `key` is the raw grouping value (modelId / agentId / workId); NULL
 * when the source events carry no attribution (e.g. non-Agent calls
 * have `agentId = NULL`) — surfaced honestly, never silently dropped.
 */
export type UserSpendGroupRow = {
    key: string | null;
    units: number;
    costCents: number;
};

/**
 * AW-17 — one run's rows grouped by how they settle: plugin, meter, payer and
 * the fixed price (if any) that priced them. The run settlement reads this
 * beside `getRunCostByPlugin` to debit fixed prices and convert the rest.
 */
export type RunMeterGroup = {
    pluginId: string;
    meter: string | null;
    payer: string | null;
    priceKey: string | null;
    priceVersion: number | null;
    calls: number;
    costCents: number;
    creditsCharged: number;
};

/**
 * AW-17 — one run's rows grouped for the receipt's meter itemisation:
 * meter × price key × capability × outcome × payer.
 */
export type RunMeterLine = {
    meter: string | null;
    priceKey: string | null;
    priceVersion: number | null;
    capability: string;
    outcome: string | null;
    payer: string | null;
    calls: number;
    costCents: number;
    creditsCharged: number;
};

/**
 * AW-17 — one account-wide grouped row with the meter figures: calls,
 * provider cost and credits. `key` is the raw grouping value (price key /
 * Mission id); NULL is surfaced honestly (e.g. "Not in a Mission").
 */
export type UserMeteredGroupRow = {
    key: string | null;
    /** A representative capability for the group (a price key maps to one). */
    capability: string | null;
    calls: number;
    costCents: number;
    credits: number;
};

/** AW-17 — one user's rows in a window grouped by meter × outcome × payer. */
export type UserMeterSpendRow = {
    meter: string | null;
    outcome: string | null;
    payer: string | null;
    calls: number;
    costCents: number;
    credits: number;
};

/** Wave 13 — §4.2 consumption counts for the Usage & Credits page. */
export type UserUsageCounts = {
    tasksCompleted: number;
    worksActive: number;
    agentRuns: number;
};

@Injectable()
export class PluginUsageRepository {
    constructor(
        @InjectRepository(PluginUsageEvent)
        private readonly repository: Repository<PluginUsageEvent>,
    ) {}

    async record(entry: Partial<PluginUsageEvent>): Promise<PluginUsageEvent> {
        const created = this.repository.create(entry);
        return this.repository.save(created);
    }

    async getTotalSpendCents(
        workId: string,
        periodStart: Date,
        periodEnd: Date,
        pluginId?: string,
        currency?: string,
    ): Promise<number> {
        const qb = this.repository
            .createQueryBuilder('e')
            .select('COALESCE(SUM(e.costCents), 0)', 'total')
            .where('e.workId = :workId', { workId })
            .andWhere('e.occurredAt >= :start', { start: periodStart })
            .andWhere('e.occurredAt < :end', { end: periodEnd });
        excludeFailedCalls(qb);

        if (pluginId) {
            qb.andWhere('e.pluginId = :pluginId', { pluginId });
        }

        // EW-602 follow-up: budgets are denominated in a single currency
        // (default usd). Summing across mixed-currency events would compare
        // apples to oranges — filter to the budget's currency so the cap
        // check stays honest if a plugin ever records non-usd usage.
        if (currency) {
            qb.andWhere('e.currency = :currency', { currency });
        }

        const row = await qb.getRawOne<{ total: string }>();
        return Number(row?.total ?? 0);
    }

    /**
     * Phase 7 PR II — account-wide spend rollup for a single user.
     * Sums `costCents` across every PluginUsageEvent attributed to
     * the user this period, regardless of Work / Mission / Idea
     * owner. Drives the new `GET /me/usage/account-wide` endpoint
     * and the Dashboard's `Month Spend` tile (spec §5.1 / PR II).
     *
     * Uses the `(userId, occurredAt)` index already on the entity
     * so a busy user's history still aggregates fast — no new
     * migration needed.
     */
    async getTotalSpendCentsForUser(
        userId: string,
        periodStart: Date,
        periodEnd: Date,
        currency?: string,
    ): Promise<number> {
        const qb = this.repository
            .createQueryBuilder('e')
            .select('COALESCE(SUM(e.costCents), 0)', 'total')
            .where('e.userId = :userId', { userId })
            .andWhere('e.occurredAt >= :start', { start: periodStart })
            .andWhere('e.occurredAt < :end', { end: periodEnd });
        excludeFailedCalls(qb);

        if (currency) {
            qb.andWhere('e.currency = :currency', { currency });
        }

        const row = await qb.getRawOne<{ total: string }>();
        return Number(row?.total ?? 0);
    }

    /**
     * Phase 7 PR T — polymorphic-owner spend rollup. Same
     * period-window + currency filter as `getTotalSpendCents`, but
     * keyed on the `ownerType + ownerId` pair so per-Mission and
     * per-Idea budgets can compute their current-period spend.
     *
     * For the Work owner case (`ownerType='work', ownerId=workId`)
     * this returns the same number as `getTotalSpendCents(workId,
     * ...)` because the PR 0.3 backfill populated both columns
     * consistently.
     */
    async getTotalSpendCentsForOwner(
        ownerType: string,
        ownerId: string,
        periodStart: Date,
        periodEnd: Date,
        pluginId?: string,
        currency?: string,
    ): Promise<number> {
        const qb = this.repository
            .createQueryBuilder('e')
            .select('COALESCE(SUM(e.costCents), 0)', 'total')
            .where('e.ownerType = :ownerType', { ownerType })
            .andWhere('e.ownerId = :ownerId', { ownerId })
            .andWhere('e.occurredAt >= :start', { start: periodStart })
            .andWhere('e.occurredAt < :end', { end: periodEnd });
        excludeFailedCalls(qb);

        if (pluginId) {
            qb.andWhere('e.pluginId = :pluginId', { pluginId });
        }
        if (currency) {
            qb.andWhere('e.currency = :currency', { currency });
        }

        const row = await qb.getRawOne<{ total: string }>();
        return Number(row?.total ?? 0);
    }

    /**
     * Fleet cost accounting (EW-777) — the per-Agent budget precheck's
     * input: one user's spend attributed to ONE Agent inside a period,
     * whatever executed it. A cloud run's facade rows and a fleet run's
     * `fleet-node:*` row are the same column, so the precheck sees both
     * without a second accounting. Uses
     * `idx_plugin_usage_events_user_agent_occurred`.
     */
    async getTotalSpendCentsForAgent(
        userId: string,
        agentId: string,
        periodStart: Date,
        periodEnd: Date,
        currency?: string,
    ): Promise<number> {
        const qb = this.repository
            .createQueryBuilder('e')
            .select('COALESCE(SUM(e.costCents), 0)', 'total')
            .where('e.userId = :userId', { userId })
            .andWhere('e.agentId = :agentId', { agentId })
            .andWhere('e.occurredAt >= :start', { start: periodStart })
            .andWhere('e.occurredAt < :end', { end: periodEnd });
        excludeFailedCalls(qb);
        if (currency) {
            qb.andWhere('e.currency = :currency', { currency });
        }
        const row = await qb.getRawOne<{ total: string }>();
        return Number(row?.total ?? 0);
    }

    /**
     * Tasks feature — Phase 15.7. Per-Task spend rollup. Caller
     * filters by `since` (defaults to "all-time") + optional
     * `currency`. Returns the total cost in cents for usage events
     * attributed to the Task via the `taskId` column added by the
     * Phase-11 migration.
     */
    async getTotalSpendCentsForTask(
        taskId: string,
        opts: { since?: Date; until?: Date; currency?: string } = {},
    ): Promise<number> {
        const qb = this.repository
            .createQueryBuilder('e')
            .select('COALESCE(SUM(e.costCents), 0)', 'total')
            .where('e.taskId = :taskId', { taskId });
        excludeFailedCalls(qb);
        if (opts.since) {
            qb.andWhere('e.occurredAt >= :since', { since: opts.since });
        }
        if (opts.until) {
            qb.andWhere('e.occurredAt < :until', { until: opts.until });
        }
        if (opts.currency) {
            qb.andWhere('e.currency = :currency', { currency: opts.currency });
        }
        const row = await qb.getRawOne<{ total: string }>();
        return Number(row?.total ?? 0);
    }

    /**
     * Pricing Wave 9 M2 — the run-cost accumulator's input: this run's
     * metered spend summed per plugin. Grouped by plugin (rather than a
     * single SUM) so the settlement can exclude plugins whose calls ran
     * on user-supplied keys (BYOK — free per founder decision P2/P3)
     * without a second query. Uses the `(runId, occurredAt)` index from
     * the 1783600000000 migration. Rows recorded before per-run tagging
     * existed have `runId = NULL` and are honestly not attributable.
     */
    async getRunCostByPlugin(runId: string): Promise<RunPluginSpend[]> {
        const rows = await this.repository
            .createQueryBuilder('e')
            .select('e.pluginId', 'pluginId')
            .addSelect('COALESCE(SUM(e.costCents), 0)', 'costCents')
            .where('e.runId = :runId', { runId })
            .andWhere(FAILED_CALLS_EXCLUDED, { failedOutcome: UsageOutcome.FAILED })
            .groupBy('e.pluginId')
            .getRawMany<{ pluginId: string; costCents: string }>();

        return rows.map((r) => ({
            pluginId: r.pluginId,
            costCents: Number(r.costCents ?? 0),
        }));
    }

    async getSpendByPlugin(
        workId: string,
        periodStart: Date,
        periodEnd: Date,
    ): Promise<PerPluginSpend[]> {
        const rows = await this.repository
            .createQueryBuilder('e')
            .select('e.pluginId', 'pluginId')
            .addSelect('e.capability', 'capability')
            .addSelect('SUM(e.units)', 'units')
            .addSelect('SUM(e.costCents)', 'costCents')
            .where('e.workId = :workId', { workId })
            .andWhere('e.occurredAt >= :start', { start: periodStart })
            .andWhere('e.occurredAt < :end', { end: periodEnd })
            .andWhere(FAILED_CALLS_EXCLUDED, { failedOutcome: UsageOutcome.FAILED })
            .groupBy('e.pluginId')
            .addGroupBy('e.capability')
            .orderBy('"costCents"', 'DESC')
            .getRawMany<{
                pluginId: string;
                capability: PluginUsageCapability;
                units: string;
                costCents: string;
            }>();

        return rows.map((r) => ({
            pluginId: r.pluginId,
            capability: r.capability,
            units: Number(r.units ?? 0),
            costCents: Number(r.costCents ?? 0),
        }));
    }

    async getDailySpend(
        workId: string,
        periodStart: Date,
        periodEnd: Date,
    ): Promise<DailySpendBucket[]> {
        // `to_char(...)` is PostgreSQL-only — SQLite + MySQL crash the
        // query. Fetch raw rows and bucket in JS so the budgets endpoint
        // works against every supported driver (SQLite in CI/dev,
        // Postgres in prod). The data volume is bounded by a single
        // Work's spend in one billing window so an in-memory aggregation
        // is cheap.
        const events = await this.repository
            .createQueryBuilder('e')
            .select(['e.occurredAt', 'e.costCents'])
            .where('e.workId = :workId', { workId })
            .andWhere('e.occurredAt >= :start', { start: periodStart })
            .andWhere('e.occurredAt < :end', { end: periodEnd })
            .andWhere(FAILED_CALLS_EXCLUDED, { failedOutcome: UsageOutcome.FAILED })
            .getMany();

        const byDay = new Map<string, number>();
        for (const event of events) {
            const day = event.occurredAt.toISOString().slice(0, 10); // YYYY-MM-DD
            byDay.set(day, (byDay.get(day) ?? 0) + Number(event.costCents ?? 0));
        }
        return Array.from(byDay.entries())
            .map(([day, costCents]) => ({ day, costCents }))
            .sort((a, b) => a.day.localeCompare(b.day));
    }

    /**
     * Wave 13 (Billing/Usage UI) — account-wide daily spend buckets for
     * ONE user. Same driver-agnostic JS bucketing as `getDailySpend`
     * (no DB date functions — SQLite in CI/dev, Postgres in prod), but
     * keyed on `userId` via the existing `(userId, occurredAt)` index.
     * Volume is bounded by one user's events in one period window.
     */
    async getDailySpendForUser(
        userId: string,
        periodStart: Date,
        periodEnd: Date,
    ): Promise<DailySpendBucket[]> {
        const events = await this.repository
            .createQueryBuilder('e')
            .select(['e.occurredAt', 'e.costCents'])
            .where('e.userId = :userId', { userId })
            .andWhere('e.occurredAt >= :start', { start: periodStart })
            .andWhere('e.occurredAt < :end', { end: periodEnd })
            .andWhere(FAILED_CALLS_EXCLUDED, { failedOutcome: UsageOutcome.FAILED })
            .getMany();

        const byDay = new Map<string, number>();
        for (const event of events) {
            const day = event.occurredAt.toISOString().slice(0, 10); // YYYY-MM-DD
            byDay.set(day, (byDay.get(day) ?? 0) + Number(event.costCents ?? 0));
        }
        return Array.from(byDay.entries())
            .map(([day, costCents]) => ({ day, costCents }))
            .sort((a, b) => a.day.localeCompare(b.day));
    }

    /**
     * Wave 13 — shared account-wide grouped rollup: ONE grouped query
     * over the user's events in the window (owner-scoped, no N+1). The
     * column is an internal whitelist — never caller-supplied.
     */
    private async getSpendGroupedForUser(
        column: 'modelId' | 'agentId' | 'workId',
        userId: string,
        periodStart: Date,
        periodEnd: Date,
    ): Promise<UserSpendGroupRow[]> {
        const rows = await this.repository
            .createQueryBuilder('e')
            .select(`e.${column}`, 'key')
            .addSelect('COALESCE(SUM(e.units), 0)', 'units')
            .addSelect('COALESCE(SUM(e.costCents), 0)', 'costCents')
            .where('e.userId = :userId', { userId })
            .andWhere('e.occurredAt >= :start', { start: periodStart })
            .andWhere('e.occurredAt < :end', { end: periodEnd })
            .andWhere(FAILED_CALLS_EXCLUDED, { failedOutcome: UsageOutcome.FAILED })
            .groupBy(`e.${column}`)
            .orderBy('"costCents"', 'DESC')
            .getRawMany<{ key: string | null; units: string; costCents: string }>();

        return rows.map((r) => ({
            key: r.key ?? null,
            units: Number(r.units ?? 0),
            costCents: Number(r.costCents ?? 0),
        }));
    }

    /** Wave 13 — user's spend per `modelId` in the window (one query). */
    async getSpendByModelForUser(
        userId: string,
        periodStart: Date,
        periodEnd: Date,
    ): Promise<UserSpendGroupRow[]> {
        return this.getSpendGroupedForUser('modelId', userId, periodStart, periodEnd);
    }

    /** Wave 13 — user's spend per Agent in the window (one query). */
    async getSpendByAgentForUser(
        userId: string,
        periodStart: Date,
        periodEnd: Date,
    ): Promise<UserSpendGroupRow[]> {
        return this.getSpendGroupedForUser('agentId', userId, periodStart, periodEnd);
    }

    /** Wave 13 — user's spend per Work in the window (one query). */
    async getSpendByWorkForUser(
        userId: string,
        periodStart: Date,
        periodEnd: Date,
    ): Promise<UserSpendGroupRow[]> {
        return this.getSpendGroupedForUser('workId', userId, periodStart, periodEnd);
    }

    /**
     * Wave 13 — §4.2 consumption counts for the Usage & Credits page:
     * Tasks completed in the window, currently-active Works, and Agent
     * runs started in the window — all owner-scoped to one user.
     *
     * Cross-entity counts ride `repository.manager` (same precedent as
     * `WorkRepository.getStatsForUser` counting Missions/Ideas): three
     * COUNT queries in parallel, no N+1, no new module wiring. Each is
     * `.catch(() => 0)`-guarded so a missing table on a half-migrated
     * dev box degrades to 0 instead of failing the whole summary.
     */
    async getUsageCountsForUser(
        userId: string,
        periodStart: Date,
        periodEnd: Date,
    ): Promise<UserUsageCounts> {
        const manager = this.repository.manager;
        const [tasksCompleted, worksActive, agentRuns] = await Promise.all([
            manager
                .count(Task, {
                    where: {
                        userId,
                        status: TaskStatus.DONE,
                        completedAt: Between(periodStart, periodEnd),
                    },
                })
                .catch(() => 0),
            manager.count(Work, { where: { userId, status: 'active' } }).catch(() => 0),
            manager
                .count(AgentRun, {
                    where: { userId, createdAt: Between(periodStart, periodEnd) },
                })
                .catch(() => 0),
        ]);
        return { tasksCompleted, worksActive, agentRuns };
    }

    /**
     * Costs dashboard — the stacked daily chart's input: one row per
     * (day, agent) with non-zero events for this user in the window.
     *
     * Bucketed in JS, not SQL, for the same reason as
     * {@link getDailySpendForUser}: `to_char`/`date_trunc` are
     * PostgreSQL-only and the CI + e2e stacks run better-sqlite3. The
     * scan is narrowed by the `(userId, occurredAt)` index and projects
     * three columns only, so a 90-day window of a heavy account reads
     * three ints/dates per event rather than whole rows.
     *
     * `agentId` is `null` for usage that never ran inside an Agent (the
     * Work-generator flow, ad-hoc facade calls) — surfaced honestly as
     * its own bucket, never dropped.
     */
    async getDailySpendByAgentForUser(
        userId: string,
        periodStart: Date,
        periodEnd: Date,
    ): Promise<DailyAgentSpendBucket[]> {
        const rows = await this.repository
            .createQueryBuilder('e')
            .select('e.occurredAt', 'occurredAt')
            .addSelect('e.agentId', 'agentId')
            .addSelect('e.costCents', 'costCents')
            .where('e.userId = :userId', { userId })
            .andWhere('e.occurredAt >= :start', { start: periodStart })
            .andWhere('e.occurredAt < :end', { end: periodEnd })
            .andWhere(FAILED_CALLS_EXCLUDED, { failedOutcome: UsageOutcome.FAILED })
            .getRawMany<{ occurredAt: Date | string; agentId: string | null; costCents: number }>();

        // Composite map key: the day and the agent id can never collide
        // because the day segment is a fixed-width `YYYY-MM-DD`.
        const byDayAgent = new Map<string, number>();
        for (const row of rows) {
            const occurredAt =
                row.occurredAt instanceof Date ? row.occurredAt : new Date(row.occurredAt);
            const day = occurredAt.toISOString().slice(0, 10);
            const key = `${day}\0${row.agentId ?? ''}`;
            byDayAgent.set(key, (byDayAgent.get(key) ?? 0) + Number(row.costCents ?? 0));
        }

        return Array.from(byDayAgent.entries())
            .map(([key, costCents]) => {
                const [day, agentId] = key.split('\0');
                return { day, agentId: agentId === '' ? null : agentId, costCents };
            })
            .sort((a, b) => a.day.localeCompare(b.day));
    }

    /**
     * Costs dashboard — the dominant model of each run in `runIds`, for
     * the top-runs table's "model" column.
     *
     * ONE grouped query over `(runId, modelId)` rather than a lookup per
     * run: a run can call several models (escalation, a cheap
     * summarizer), so "the model" is defined as the one that accounts
     * for the most spend, with the highest unit count breaking a tie.
     * Runs whose events carry no model id (or that predate per-run
     * tagging) are simply absent from the map.
     */
    async getDominantModelByRun(runIds: string[]): Promise<Map<string, string>> {
        if (runIds.length === 0) {
            return new Map();
        }
        const rows = await this.repository
            .createQueryBuilder('e')
            .select('e.runId', 'runId')
            .addSelect('e.modelId', 'modelId')
            .addSelect('COALESCE(SUM(e.costCents), 0)', 'costCents')
            .addSelect('COALESCE(SUM(e.units), 0)', 'units')
            .where('e.runId IN (:...runIds)', { runIds })
            .andWhere('e.modelId IS NOT NULL')
            .andWhere(FAILED_CALLS_EXCLUDED, { failedOutcome: UsageOutcome.FAILED })
            .groupBy('e.runId')
            .addGroupBy('e.modelId')
            .getRawMany<{
                runId: string;
                modelId: string;
                costCents: string;
                units: string;
            }>();

        const best = new Map<string, { modelId: string; costCents: number; units: number }>();
        for (const row of rows) {
            const costCents = Number(row.costCents ?? 0);
            const units = Number(row.units ?? 0);
            const current = best.get(row.runId);
            if (
                !current ||
                costCents > current.costCents ||
                (costCents === current.costCents && units > current.units)
            ) {
                best.set(row.runId, { modelId: row.modelId, costCents, units });
            }
        }
        return new Map(Array.from(best.entries()).map(([runId, v]) => [runId, v.modelId]));
    }

    /**
     * Run receipt (AW-09) — one run's metered usage grouped by
     * `(capability, modelId)`: call count, units and cost per line. The
     * same rows `getRunCostByPlugin` settles and the Costs dashboard
     * aggregates, so a receipt line can never disagree with either. Uses
     * the `(runId, occurredAt)` index; most expensive line first.
     */
    async getRunSpendLines(runId: string): Promise<RunSpendLine[]> {
        const rows = await this.repository
            .createQueryBuilder('e')
            .select('e.capability', 'capability')
            .addSelect('e.modelId', 'modelId')
            .addSelect('COUNT(e.id)', 'calls')
            .addSelect('COALESCE(SUM(e.units), 0)', 'units')
            .addSelect('COALESCE(SUM(e.costCents), 0)', 'costCents')
            .where('e.runId = :runId', { runId })
            .andWhere(FAILED_CALLS_EXCLUDED, { failedOutcome: UsageOutcome.FAILED })
            .groupBy('e.capability')
            .addGroupBy('e.modelId')
            .getRawMany<{
                capability: string;
                modelId: string | null;
                calls: string | number;
                units: string | number;
                costCents: string | number;
            }>();

        return rows
            .map((row) => ({
                capability: String(row.capability),
                modelId: row.modelId ?? null,
                calls: Number(row.calls ?? 0) || 0,
                units: Number(row.units ?? 0) || 0,
                costCents: Number(row.costCents ?? 0) || 0,
            }))
            .sort(
                (a, b) =>
                    b.costCents - a.costCents ||
                    a.capability.localeCompare(b.capability) ||
                    (a.modelId ?? '').localeCompare(b.modelId ?? ''),
            );
    }

    /**
     * AW-17 — the run settlement's classified view of one run: rows grouped by
     * (plugin, meter, payer, price key, price version). Same `(runId,
     * occurredAt)` index as `getRunCostByPlugin`; the two reads cover the
     * same rows (this one also counts failed calls, which carry no cost), so
     * their cost sums always agree.
     */
    async getRunMeterGroups(runId: string): Promise<RunMeterGroup[]> {
        const rows = await this.repository
            .createQueryBuilder('e')
            .select('e.pluginId', 'pluginId')
            .addSelect('e.meter', 'meter')
            .addSelect('e.payer', 'payer')
            .addSelect('e.priceKey', 'priceKey')
            .addSelect('e.priceVersion', 'priceVersion')
            .addSelect('COUNT(e.id)', 'calls')
            .addSelect('COALESCE(SUM(e.costCents), 0)', 'costCents')
            .addSelect('COALESCE(SUM(e.creditsCharged), 0)', 'creditsCharged')
            .where('e.runId = :runId', { runId })
            .groupBy('e.pluginId')
            .addGroupBy('e.meter')
            .addGroupBy('e.payer')
            .addGroupBy('e.priceKey')
            .addGroupBy('e.priceVersion')
            .getRawMany<Record<string, string | number | null>>();

        return rows.map((row) => ({
            pluginId: String(row.pluginId),
            meter: nullableString(row.meter),
            payer: nullableString(row.payer),
            priceKey: nullableString(row.priceKey),
            priceVersion: nullableNumber(row.priceVersion),
            calls: Number(row.calls ?? 0) || 0,
            costCents: Number(row.costCents ?? 0) || 0,
            creditsCharged: Number(row.creditsCharged ?? 0) || 0,
        }));
    }

    /**
     * AW-17 — the run receipt's meter itemisation input: one run's rows
     * grouped by (meter, price key, price version, capability, outcome,
     * payer). The service folds these into per-meter lines.
     */
    async getRunMeterLines(runId: string): Promise<RunMeterLine[]> {
        const rows = await this.repository
            .createQueryBuilder('e')
            .select('e.meter', 'meter')
            .addSelect('e.priceKey', 'priceKey')
            .addSelect('e.priceVersion', 'priceVersion')
            .addSelect('e.capability', 'capability')
            .addSelect('e.outcome', 'outcome')
            .addSelect('e.payer', 'payer')
            .addSelect('COUNT(e.id)', 'calls')
            .addSelect('COALESCE(SUM(e.costCents), 0)', 'costCents')
            .addSelect('COALESCE(SUM(e.creditsCharged), 0)', 'creditsCharged')
            .where('e.runId = :runId', { runId })
            .groupBy('e.meter')
            .addGroupBy('e.priceKey')
            .addGroupBy('e.priceVersion')
            .addGroupBy('e.capability')
            .addGroupBy('e.outcome')
            .addGroupBy('e.payer')
            .getRawMany<Record<string, string | number | null>>();

        return rows.map((row) => ({
            meter: nullableString(row.meter),
            priceKey: nullableString(row.priceKey),
            priceVersion: nullableNumber(row.priceVersion),
            capability: String(row.capability ?? ''),
            outcome: nullableString(row.outcome),
            payer: nullableString(row.payer),
            calls: Number(row.calls ?? 0) || 0,
            costCents: Number(row.costCents ?? 0) || 0,
            creditsCharged: Number(row.creditsCharged ?? 0) || 0,
        }));
    }

    /**
     * AW-17 — the meter cards' input: one user's rows in the window grouped
     * by (meter, outcome, payer). Rows with `meter IS NULL` come back as
     * their own group and are NEVER folded into a named meter here — the
     * caller reports them as recorded before meters were separated. Leads
     * with `userId, meter` for `idx_plugin_usage_meter_user_occurred`.
     */
    async getSpendByMeterForUser(
        userId: string,
        periodStart: Date,
        periodEnd: Date,
    ): Promise<UserMeterSpendRow[]> {
        const rows = await this.repository
            .createQueryBuilder('e')
            .select('e.meter', 'meter')
            .addSelect('e.outcome', 'outcome')
            .addSelect('e.payer', 'payer')
            .addSelect('COUNT(e.id)', 'calls')
            .addSelect('COALESCE(SUM(e.costCents), 0)', 'costCents')
            .addSelect('COALESCE(SUM(e.creditsCharged), 0)', 'credits')
            .where('e.userId = :userId', { userId })
            .andWhere('e.occurredAt >= :start', { start: periodStart })
            .andWhere('e.occurredAt < :end', { end: periodEnd })
            .groupBy('e.meter')
            .addGroupBy('e.outcome')
            .addGroupBy('e.payer')
            .getRawMany<Record<string, string | number | null>>();

        return rows.map((row) => ({
            meter: nullableString(row.meter),
            outcome: nullableString(row.outcome),
            payer: nullableString(row.payer),
            calls: Number(row.calls ?? 0) || 0,
            costCents: Number(row.costCents ?? 0) || 0,
            credits: Number(row.credits ?? 0) || 0,
        }));
    }

    /**
     * AW-17 — "by tool": one user's CLASSIFIED rows in the window grouped by
     * price key, ranked by credits then provider cost. Pre-meter rows
     * (`meter IS NULL`) are excluded; the meter summary reports them apart.
     */
    async getSpendByPriceKeyForUser(
        userId: string,
        periodStart: Date,
        periodEnd: Date,
    ): Promise<UserMeteredGroupRow[]> {
        return this.getMeteredGroupedForUser('priceKey', userId, periodStart, periodEnd);
    }

    /**
     * AW-17 — "by Mission": one user's CLASSIFIED rows grouped by the Mission
     * of their Task. NULL is spend with no Mission (no Task, or a Task filed
     * against none) and is returned as its own row, never attributed by
     * inference.
     */
    async getSpendByMissionForUser(
        userId: string,
        periodStart: Date,
        periodEnd: Date,
    ): Promise<UserMeteredGroupRow[]> {
        return this.getMeteredGroupedForUser('missionId', userId, periodStart, periodEnd);
    }

    /**
     * AW-17 — shared grouped rollup over classified rows. The column is an
     * internal whitelist — never caller-supplied.
     */
    private async getMeteredGroupedForUser(
        column: 'priceKey' | 'missionId',
        userId: string,
        periodStart: Date,
        periodEnd: Date,
    ): Promise<UserMeteredGroupRow[]> {
        const rows = await this.repository
            .createQueryBuilder('e')
            .select(`e.${column}`, 'key')
            .addSelect('MIN(e.capability)', 'capability')
            .addSelect('COUNT(e.id)', 'calls')
            .addSelect('COALESCE(SUM(e.costCents), 0)', 'costCents')
            .addSelect('COALESCE(SUM(e.creditsCharged), 0)', 'credits')
            .where('e.userId = :userId', { userId })
            .andWhere('e.occurredAt >= :start', { start: periodStart })
            .andWhere('e.occurredAt < :end', { end: periodEnd })
            .andWhere('e.meter IS NOT NULL')
            .groupBy(`e.${column}`)
            .getRawMany<Record<string, string | number | null>>();

        return rows
            .map((row) => ({
                key: nullableString(row.key),
                capability: nullableString(row.capability),
                calls: Number(row.calls ?? 0) || 0,
                costCents: Number(row.costCents ?? 0) || 0,
                credits: Number(row.credits ?? 0) || 0,
            }))
            .sort(
                (a, b) =>
                    b.credits - a.credits ||
                    b.costCents - a.costCents ||
                    (a.key ?? '').localeCompare(b.key ?? ''),
            );
    }

    /**
     * AW-17 — Mission titles for grouped rows (one `IN` query, never per
     * row). Sibling of `getAgentNames` / `getTaskTitles`.
     */
    async getMissionTitles(ids: string[]): Promise<Map<string, string>> {
        if (ids.length === 0) {
            return new Map();
        }
        const missions = await this.repository.manager.find(Mission, {
            where: { id: In(ids) },
            select: ['id', 'title'],
        });
        return new Map(missions.map((mission) => [mission.id, mission.title]));
    }

    /**
     * AW-17 — how many rows `findPageForUserExport` would stream for the same
     * (user, window, organization). The export is refused BEFORE streaming
     * when this exceeds the published row limit.
     */
    async countForUserExport(
        userId: string,
        periodStart: Date,
        periodEnd: Date,
        options: { organizationId?: string | null } = {},
    ): Promise<number> {
        const qb = this.repository
            .createQueryBuilder('e')
            .where('e.userId = :userId', { userId })
            .andWhere('e.occurredAt >= :start', { start: periodStart })
            .andWhere('e.occurredAt < :end', { end: periodEnd });
        // The same rows the export streams: failed calls are not exported.
        excludeFailedCalls(qb);
        if (options.organizationId) {
            qb.andWhere('e.organizationId = :organizationId', {
                organizationId: options.organizationId,
            });
        }
        return qb.getCount();
    }

    /**
     * Wave 13 — display-name resolution for grouped rows: ONE `IN`
     * query per entity type (never per row). Unknown/deleted ids are
     * simply absent from the map; callers label them honestly.
     */
    async getAgentNames(ids: string[]): Promise<Map<string, string>> {
        if (ids.length === 0) {
            return new Map();
        }
        const agents = await this.repository.manager.find(Agent, {
            where: { id: In(ids) },
            select: ['id', 'name'],
        });
        return new Map(agents.map((a) => [a.id, a.name]));
    }

    /** Wave 13 — Work display names for grouped rows (one `IN` query). */
    async getWorkNames(ids: string[]): Promise<Map<string, string>> {
        if (ids.length === 0) {
            return new Map();
        }
        const works = await this.repository.manager.find(Work, {
            where: { id: In(ids) },
            select: ['id', 'name'],
        });
        return new Map(works.map((w) => [w.id, w.name]));
    }

    /**
     * Costs dashboard — Task titles for the top-runs table (one `IN`
     * query, never per row). Sibling of `getAgentNames`/`getWorkNames`;
     * lives here because this repository already reaches `Task` through
     * `repository.manager` for the §4.2 counts.
     */
    async getTaskTitles(ids: string[]): Promise<Map<string, string>> {
        if (ids.length === 0) {
            return new Map();
        }
        const tasks = await this.repository.manager.find(Task, {
            where: { id: In(ids) },
            select: ['id', 'title'],
        });
        return new Map(tasks.map((task) => [task.id, task.title]));
    }

    /**
     * EW-602 — Cross-user, cross-Work aggregated spend for the
     * platform-admin view. Returns one row per (userId, workId) with
     * non-zero usage in the period. Sorted by spend descending so
     * the admin sees biggest spenders first.
     *
     * Security: pass `tenantId` to restrict results to a single tenant.
     * Omit it only from platform-admin (IsPlatformAdminGuard) callers
     * that intentionally need the full cross-tenant view.
     */
    async getCrossUserSpend(
        periodStart: Date,
        periodEnd: Date,
        // Security: optional tenant scope — when provided, limits rows to
        // that tenant so a tenant-scoped caller cannot read other tenants'
        // user/work IDs or spend amounts (defence-in-depth on top of the
        // IsPlatformAdminGuard that already gates the admin endpoint).
        tenantId?: string,
    ): Promise<CrossUserSpendRow[]> {
        const qb = this.repository
            .createQueryBuilder('e')
            .select('e.userId', 'userId')
            .addSelect('e.workId', 'workId')
            .addSelect('SUM(e.units)', 'units')
            .addSelect('SUM(e.costCents)', 'costCents')
            .where('e.occurredAt >= :start', { start: periodStart })
            .andWhere('e.occurredAt < :end', { end: periodEnd });
        excludeFailedCalls(qb);

        if (tenantId) {
            qb.andWhere('e.tenantId = :tenantId', { tenantId });
        }

        const rows = await qb
            .groupBy('e.userId')
            .addGroupBy('e.workId')
            .orderBy('"costCents"', 'DESC')
            .getRawMany<{
                userId: string;
                workId: string;
                units: string;
                costCents: string;
            }>();

        return rows.map((r) => ({
            userId: r.userId,
            workId: r.workId,
            units: Number(r.units ?? 0),
            costCents: Number(r.costCents ?? 0),
        }));
    }

    /**
     * B29 (account-wide usage CSV export) — ONE page of the user's
     * metered events inside the window, ordered deterministically so the
     * caller can keyset/offset its way through an arbitrarily long
     * period without ever materializing it all in memory.
     *
     * Scope contract:
     *   - `userId` is always applied (owner scope — a caller only ever
     *     reads their OWN events, never another account's).
     *   - `organizationId`, when a non-empty string, restricts the rows
     *     to that Organization. It comes from the request SCOPE CONTEXT
     *     at the API boundary, never from a caller-supplied param, so a
     *     user acting inside Org A cannot export Org B's spend. When the
     *     request has no active Organization the filter is omitted and
     *     the export is the user's full account-wide history — their own
     *     rows either way.
     *
     * Half-open `[start, end)` window, matching every other aggregation
     * on this repository (see `findForExport`'s note about the inclusive
     * `Between()` regression).
     */
    async findPageForUserExport(
        userId: string,
        periodStart: Date,
        periodEnd: Date,
        options: { organizationId?: string | null; limit: number; offset: number },
    ): Promise<PluginUsageEvent[]> {
        const qb = this.repository
            .createQueryBuilder('e')
            .where('e.userId = :userId', { userId })
            .andWhere('e.occurredAt >= :start', { start: periodStart })
            .andWhere('e.occurredAt < :end', { end: periodEnd });
        excludeFailedCalls(qb);

        if (options.organizationId) {
            qb.andWhere('e.organizationId = :organizationId', {
                organizationId: options.organizationId,
            });
        }

        // `id` is the tie-breaker: `occurredAt` alone is not unique, and
        // an unstable sort would duplicate/skip rows across pages.
        return qb
            .orderBy('e.occurredAt', 'ASC')
            .addOrderBy('e.id', 'ASC')
            .skip(options.offset)
            .take(options.limit)
            .getMany();
    }

    async findForExport(
        workId: string,
        periodStart: Date,
        periodEnd: Date,
    ): Promise<PluginUsageEvent[]> {
        // EW-602 review fix (Codex P2 + Greptile P1):
        //   The summary / trend aggregates use `occurredAt >= start AND
        //   occurredAt < end` (half-open). Earlier this used TypeORM's
        //   Between() which is inclusive on BOTH ends, so the first
        //   instant of the next month bled into the previous month's CSV
        //   export and totals didn't reconcile with the dashboard.
        return this.repository
            .createQueryBuilder('e')
            .where('e.workId = :workId', { workId })
            .andWhere('e.occurredAt >= :start', { start: periodStart })
            .andWhere('e.occurredAt < :end', { end: periodEnd })
            .andWhere(FAILED_CALLS_EXCLUDED, { failedOutcome: UsageOutcome.FAILED })
            .orderBy('e.occurredAt', 'ASC')
            .getMany();
    }

    async pruneOlderThan(cutoff: Date): Promise<number> {
        const result = await this.repository
            .createQueryBuilder()
            .delete()
            .from(PluginUsageEvent)
            .where({ occurredAt: LessThan(cutoff) })
            .execute();
        return result.affected ?? 0;
    }
}

/**
 * AW-17 — the predicate every reader that predates meters applies.
 *
 * Failed calls are now recorded (outcome `failed`, zero-rated) so a receipt
 * and the meter cards can show them. Before meters a failure wrote NO row, so
 * each earlier reader — budget and limit spend, per-plugin units, daily
 * buckets, per-model / Agent / Work groups, the run's settlement input and
 * receipt lines, the admin report, both CSV exports — excludes them and
 * returns exactly what it returned before. Rows recorded before meters
 * (`outcome IS NULL`) are kept. The meter and breakdown reads count failures
 * on purpose and do not apply this.
 */
const FAILED_CALLS_EXCLUDED = '(e.outcome IS NULL OR e.outcome <> :failedOutcome)';

function excludeFailedCalls<Entity extends ObjectLiteral>(
    qb: SelectQueryBuilder<Entity>,
): SelectQueryBuilder<Entity> {
    return qb.andWhere(FAILED_CALLS_EXCLUDED, { failedOutcome: UsageOutcome.FAILED });
}

function nullableString(value: unknown): string | null {
    return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
    if (value === null || value === undefined) {
        return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
