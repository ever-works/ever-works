import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, LessThan, Repository } from 'typeorm';
import { PluginUsageCapability, PluginUsageEvent } from '@src/entities/plugin-usage-event.entity';
import { Agent } from '@src/entities/agent.entity';
import { AgentRun } from '@src/entities/agent-run.entity';
import { Task, TaskStatus } from '@src/entities/task.entity';
import { Work } from '@src/entities/work.entity';

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
