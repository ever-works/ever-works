import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
    DataSource,
    type EntityTarget,
    type ObjectLiteral,
    type SelectQueryBuilder,
} from 'typeorm';
import { Agent } from '../entities/agent.entity';
import { AgentRun } from '../entities/agent-run.entity';
import { CreditLedgerEntry, CreditLedgerKind } from '../entities/credit-ledger-entry.entity';
import { FleetNode } from '../entities/fleet-node.entity';
import { Mission } from '../entities/mission.entity';
import { Organization } from '../entities/organization.entity';
import { Team } from '../entities/team.entity';
import { Tenant } from '../entities/tenant.entity';
import { User } from '../entities/user.entity';
import { Work } from '../entities/work.entity';
import { WorkDeployment } from '../entities/work-deployment.entity';
import { PluginEntity } from '../plugins/entities/plugin.entity';

/** A half-open UTC interval `[start, end)` — one calendar month. */
export interface InstanceStatsPeriod {
    start: Date;
    end: Date;
}

/**
 * The raw installation-wide numbers a Works report is built from. Keys of the
 * two maps are the STORED values (Work kinds, deployment provider ids); the
 * builder folds them onto the schema's closed lists.
 */
export interface InstanceStatsRaw {
    users: number;
    tenants: number;
    organizations: number;
    works: number;
    worksByKind: Record<string, number>;
    agents: number;
    missions: number;
    teams: number;
    fleetNodes: number;
    pluginsEnabled: number;
    deployments: number;
    deploymentsByProvider: Record<string, number>;
    runs: number;
    creditsConsumed: number;
}

/**
 * The aggregate queries behind an anonymous usage statistics report.
 *
 * Every number is ONE aggregate over a whole table (`COUNT(*)`, `SUM`,
 * `GROUP BY` a closed-ish column), instance-wide: nothing is read per tenant,
 * per organization or per person, no row is ever loaded, and no column holding
 * a name, an address, a URL or free text is selected. Period totals use the
 * report's UTC month.
 *
 * - `users` excludes anonymous (guest) accounts.
 * - `plugins_enabled` counts plugin rows whose persisted state is `loaded`
 *   (the `plugins` table has no instance-wide "enabled" column).
 * - `credits_consumed` = `SUM(ABS(amountCredits))` over `consumption` entries.
 */
@Injectable()
export class InstanceStatsRepository {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async collect(period: InstanceStatsPeriod): Promise<InstanceStatsRaw> {
        const [
            users,
            tenants,
            organizations,
            works,
            worksByKind,
            agents,
            missions,
            teams,
            fleetNodes,
            pluginsEnabled,
            deployments,
            deploymentsByProvider,
            runs,
            creditsConsumed,
        ] = await Promise.all([
            this.count(User, 'u', (qb) =>
                qb.where('u.isAnonymous = :anonymous', { anonymous: false }),
            ),
            this.count(Tenant, 't'),
            this.count(Organization, 'o'),
            this.count(Work, 'w'),
            this.grouped(Work, 'w', 'kind'),
            this.count(Agent, 'a'),
            this.count(Mission, 'm'),
            this.count(Team, 'tm'),
            this.count(FleetNode, 'f'),
            this.count(PluginEntity, 'p', (qb) =>
                qb.where('p.state = :state', { state: 'loaded' }),
            ),
            this.count(WorkDeployment, 'd', (qb) => this.inPeriod(qb, 'd.createdAt', period)),
            this.grouped(WorkDeployment, 'd', 'provider', (qb) =>
                this.inPeriod(qb, 'd.createdAt', period),
            ),
            this.count(AgentRun, 'r', (qb) => this.inPeriod(qb, 'r.startedAt', period)),
            this.creditsConsumed(period),
        ]);

        return {
            users,
            tenants,
            organizations,
            works,
            worksByKind,
            agents,
            missions,
            teams,
            fleetNodes,
            pluginsEnabled,
            deployments,
            deploymentsByProvider,
            runs,
            creditsConsumed,
        };
    }

    private async count<T extends ObjectLiteral>(
        entity: EntityTarget<T>,
        alias: string,
        where?: (qb: QueryBuilderOf<T>) => QueryBuilderOf<T>,
    ): Promise<number> {
        let qb = this.dataSource.getRepository(entity).createQueryBuilder(alias);
        if (where) qb = where(qb);
        return toCount(await qb.getCount());
    }

    private async grouped<T extends ObjectLiteral>(
        entity: EntityTarget<T>,
        alias: string,
        column: string,
        where?: (qb: QueryBuilderOf<T>) => QueryBuilderOf<T>,
    ): Promise<Record<string, number>> {
        let qb = this.dataSource
            .getRepository(entity)
            .createQueryBuilder(alias)
            .select(`${alias}.${column}`, 'value')
            .addSelect('COUNT(*)', 'total')
            .groupBy(`${alias}.${column}`);
        if (where) qb = where(qb);
        const rows: Array<{ value: unknown; total: unknown }> = await qb.getRawMany();
        // No prototype: a stored value such as `constructor` or `__proto__` is
        // a key like any other (and is folded under `other` by the module).
        const out: Record<string, number> = Object.create(null);
        for (const row of rows) {
            const key = typeof row.value === 'string' ? row.value : String(row.value ?? '');
            out[key] = (out[key] ?? 0) + toCount(row.total);
        }
        return out;
    }

    private inPeriod<T extends ObjectLiteral>(
        qb: QueryBuilderOf<T>,
        column: string,
        period: InstanceStatsPeriod,
    ): QueryBuilderOf<T> {
        return qb
            .andWhere(`${column} >= :periodStart`, { periodStart: period.start })
            .andWhere(`${column} < :periodEnd`, { periodEnd: period.end });
    }

    private async creditsConsumed(period: InstanceStatsPeriod): Promise<number> {
        const row: { total: unknown } | undefined = await this.dataSource
            .getRepository(CreditLedgerEntry)
            .createQueryBuilder('c')
            .select('COALESCE(SUM(ABS(c.amountCredits)), 0)', 'total')
            .where('c.kind = :kind', { kind: CreditLedgerKind.CONSUMPTION })
            .andWhere('c.createdAt >= :periodStart', { periodStart: period.start })
            .andWhere('c.createdAt < :periodEnd', { periodEnd: period.end })
            .getRawOne();
        return toCount(row?.total);
    }
}

type QueryBuilderOf<T extends ObjectLiteral> = SelectQueryBuilder<T>;

/** A database count as a non-negative safe integer (Postgres answers bigint sums as strings). */
function toCount(value: unknown): number {
    const n = typeof value === 'number' ? value : Number(value ?? 0);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(Math.trunc(n), Number.MAX_SAFE_INTEGER);
}
