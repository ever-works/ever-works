import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, LessThan, Repository } from 'typeorm';
import { PluginUsageCapability, PluginUsageEvent } from '@src/entities/plugin-usage-event.entity';

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
     * EW-602 — Cross-user, cross-Work aggregated spend for the
     * platform-admin view. Returns one row per (userId, workId) with
     * non-zero usage in the period. Sorted by spend descending so
     * the admin sees biggest spenders first.
     */
    async getCrossUserSpend(periodStart: Date, periodEnd: Date): Promise<CrossUserSpendRow[]> {
        const rows = await this.repository
            .createQueryBuilder('e')
            .select('e.userId', 'userId')
            .addSelect('e.workId', 'workId')
            .addSelect('SUM(e.units)', 'units')
            .addSelect('SUM(e.costCents)', 'costCents')
            .where('e.occurredAt >= :start', { start: periodStart })
            .andWhere('e.occurredAt < :end', { end: periodEnd })
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
