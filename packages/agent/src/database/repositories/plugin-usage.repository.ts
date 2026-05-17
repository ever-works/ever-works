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
        const rows = await this.repository
            .createQueryBuilder('e')
            .select("to_char(e.occurredAt, 'YYYY-MM-DD')", 'day')
            .addSelect('SUM(e.costCents)', 'costCents')
            .where('e.workId = :workId', { workId })
            .andWhere('e.occurredAt >= :start', { start: periodStart })
            .andWhere('e.occurredAt < :end', { end: periodEnd })
            .groupBy('day')
            .orderBy('day', 'ASC')
            .getRawMany<{ day: string; costCents: string }>();

        return rows.map((r) => ({ day: r.day, costCents: Number(r.costCents ?? 0) }));
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
