import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, LessThan, MoreThanOrEqual, Repository } from 'typeorm';
import type { FleetNodeHealthResolution, FleetNodeHealthSnapshot } from '@ever-works/contracts';
import { FleetNodeHealthSample } from '../entities/fleet-node-health-sample.entity';

/** One hour's roll-up for one node, as the repository inserts it. */
export interface FleetNodeHealthHourlyRow {
    nodeId: string;
    /** The hour's start (UTC, minutes/seconds zero). */
    at: Date;
    cpuPercent: number | null;
    memPercent: number | null;
    memTotalMiB: number | null;
    diskPercent: number | null;
    diskFreeMiB: number | null;
    loadAvg1: number | null;
    uptimeSec: number | null;
    pendingReboot: boolean | null;
    failedServices: number | null;
    cpuMax: number | null;
    memMax: number | null;
    diskMax: number | null;
}

/** `bigint` comes back as a STRING on Postgres and a number on sqlite. */
export function toOptionalSampleNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? number : null;
}

const HOUR_MS = 60 * 60_000;

/** The start of the UTC hour containing `instant`. */
export function hourStart(instant: Date | number): Date {
    const ms = typeof instant === 'number' ? instant : instant.getTime();
    return new Date(Math.floor(ms / HOUR_MS) * HOUR_MS);
}

function mean(values: Array<number | null>): number | null {
    const present = values.filter((value): value is number => value !== null);
    if (present.length === 0) return null;
    return present.reduce((sum, value) => sum + value, 0) / present.length;
}

function peak(values: Array<number | null>): number | null {
    const present = values.filter((value): value is number => value !== null);
    return present.length === 0 ? null : Math.max(...present);
}

/**
 * Fold one node's raw rows of one hour into its hourly row: the MEAN of each
 * percentage and figure (CONTRACTS §4.5), the hour's PEAK in `cpuMax` /
 * `memMax` / `diskMax`, the highest failed-service count, and "pending
 * reboot" when any sample said so. A column no sample reported stays null —
 * the roll-up never invents a value the raw rows did not hold.
 */
export function rollUpHour(
    nodeId: string,
    hour: Date,
    raws: readonly FleetNodeHealthSample[],
): FleetNodeHealthHourlyRow {
    const column = (pick: (row: FleetNodeHealthSample) => unknown) =>
        raws.map((row) => toOptionalSampleNumber(pick(row)));
    const cpu = column((row) => row.cpuPercent);
    const mem = column((row) => row.memPercent);
    const disk = column((row) => row.diskPercent);
    const reboots = raws
        .map((row) => row.pendingReboot)
        .filter((value): value is boolean => typeof value === 'boolean');
    const round1 = (value: number | null) => (value === null ? null : Math.round(value * 10) / 10);
    const whole = (value: number | null) => (value === null ? null : Math.round(value));
    return {
        nodeId,
        at: hour,
        cpuPercent: round1(mean(cpu)),
        memPercent: round1(mean(mem)),
        memTotalMiB: whole(peak(column((row) => row.memTotalMiB))),
        diskPercent: round1(mean(disk)),
        diskFreeMiB: whole(mean(column((row) => row.diskFreeMiB))),
        loadAvg1: (() => {
            const value = mean(column((row) => row.loadAvg1));
            return value === null ? null : Math.round(value * 100) / 100;
        })(),
        uptimeSec: whole(peak(column((row) => row.uptimeSec))),
        pendingReboot: reboots.length === 0 ? null : reboots.some(Boolean),
        failedServices: whole(peak(column((row) => row.failedServices))),
        cpuMax: round1(peak(cpu)),
        memMax: round1(peak(mem)),
        diskMax: round1(peak(disk)),
    };
}

/**
 * Computer health (FL-03) — reads and writes `fleet_node_health_samples`.
 *
 * Every statement is portable TypeORM (no `date_trunc`, no dialect SQL):
 * CI and the e2e stack run better-sqlite3, production runs Postgres. The
 * hourly bucket is therefore computed in code from rows read by an indexed
 * range, and roll-up rows are inserted with insert-or-ignore on the unique
 * `(nodeId, resolution, at)` key, which is what makes a re-run a no-op.
 */
/** Hourly rows per INSERT statement (see `insertHourly`): 500 × ~18 parameters stays under both engines' caps. */
export const FLEET_HEALTH_HOURLY_INSERT_CHUNK = 500;

@Injectable()
export class FleetNodeHealthSampleRepository {
    constructor(
        @InjectRepository(FleetNodeHealthSample)
        private readonly repository: Repository<FleetNodeHealthSample>,
    ) {}

    /** Write one raw sample (the caller has already applied the flag and the 55 s floor). */
    async insertRaw(nodeId: string, at: Date, snapshot: FleetNodeHealthSnapshot): Promise<void> {
        await this.repository
            .createQueryBuilder()
            .insert()
            .into(FleetNodeHealthSample)
            .values({
                nodeId,
                at,
                resolution: 'raw',
                cpuPercent: snapshot.cpuPercent ?? null,
                memPercent: snapshot.memPercent ?? null,
                memTotalMiB: snapshot.memTotalMiB ?? null,
                diskPercent: snapshot.diskPercent ?? null,
                diskFreeMiB: snapshot.diskFreeMiB ?? null,
                loadAvg1: snapshot.loadAvg1 ?? null,
                uptimeSec: snapshot.uptimeSec ?? null,
                gpu: snapshot.gpu ?? null,
                pendingReboot: snapshot.pendingReboot ?? null,
                failedServices: snapshot.failedServices ?? null,
                cpuMax: null,
                memMax: null,
                diskMax: null,
            })
            // Two beats of one node can never share an instant; a duplicate is
            // a retried write, and ignoring it is the idempotent answer.
            .orIgnore()
            .execute();
    }

    /**
     * Has this hour been rolled up already? One indexed point lookup on
     * `(resolution, at)`. An hour is rolled up once, after it ENDED and for
     * every node at once, so one hourly row proves the whole hour is done.
     * (Read through `find`, never a raw select: sqlite hands a raw datetime
     * back as a zone-less string that `new Date()` would read as local time.)
     */
    async hasHourly(hour: Date): Promise<boolean> {
        const row = await this.repository.findOne({
            where: { resolution: 'hourly', at: hour },
            select: { id: true },
        });
        return row !== null;
    }

    /** Every raw row in one hour, oldest first. */
    async rawInHour(hour: Date): Promise<FleetNodeHealthSample[]> {
        return this.repository.find({
            where: { resolution: 'raw', at: Between(hour, new Date(hour.getTime() + HOUR_MS - 1)) },
            order: { at: 'ASC' },
        });
    }

    /** Insert hourly rows; a row whose `(nodeId, hourly, at)` already exists is left alone. */
    async insertHourly(rows: readonly FleetNodeHealthHourlyRow[]): Promise<void> {
        if (rows.length === 0) return;
        // In chunks: one multi-row insert binds ~18 parameters a row, and both
        // engines cap a statement's parameters (Postgres 65 535, sqlite 32 766),
        // which one hour of a large fleet would otherwise exceed. All chunks in
        // ONE transaction: `hasHourly` treats an hour with any hourly row as
        // done, so a half-written hour would never be completed by a later pass.
        await this.repository.manager.transaction(async (manager) => {
            for (let index = 0; index < rows.length; index += FLEET_HEALTH_HOURLY_INSERT_CHUNK) {
                const chunk = rows.slice(index, index + FLEET_HEALTH_HOURLY_INSERT_CHUNK);
                await manager
                    .createQueryBuilder()
                    .insert()
                    .into(FleetNodeHealthSample)
                    .values(
                        chunk.map((row) => ({ ...row, resolution: 'hourly' as const, gpu: null })),
                    )
                    .orIgnore()
                    .execute();
            }
        });
    }

    /** Delete rows of one resolution older than `cutoff`. Idempotent. Answers how many went. */
    async deleteBefore(resolution: FleetNodeHealthResolution, cutoff: Date): Promise<number> {
        const result = await this.repository.delete({ resolution, at: LessThan(cutoff) });
        return result.affected ?? 0;
    }

    /** One node's rows of one resolution since `since`, oldest first (history reads, FL-03 P2). */
    async series(
        nodeId: string,
        resolution: FleetNodeHealthResolution,
        since: Date,
    ): Promise<FleetNodeHealthSample[]> {
        return this.repository.find({
            where: { nodeId, resolution, at: MoreThanOrEqual(since) },
            order: { at: 'ASC' },
        });
    }

    /** Test and tooling seam: every row for these nodes. */
    async findForNodes(nodeIds: readonly string[]): Promise<FleetNodeHealthSample[]> {
        if (nodeIds.length === 0) return [];
        return this.repository.find({ where: { nodeId: In([...nodeIds]) }, order: { at: 'ASC' } });
    }
}
