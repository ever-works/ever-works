import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, LessThan, Repository } from 'typeorm';
import {
    PluginUsageCapability,
    PluginUsageEvent,
} from '@src/entities/plugin-usage-event.entity';

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

    async findForExport(
        workId: string,
        periodStart: Date,
        periodEnd: Date,
    ): Promise<PluginUsageEvent[]> {
        return this.repository.find({
            where: {
                workId,
                occurredAt: Between(periodStart, periodEnd),
            },
            order: { occurredAt: 'ASC' },
        });
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
