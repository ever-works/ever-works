import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { LessThan, type Repository } from 'typeorm';
import {
    EVER_STATS_LEASE_ROW_ID,
    EVER_STATS_REPORTS_KEPT,
    EverStatsLease,
    EverStatsReport,
} from '@ever-works/agent/entities';

/** How long a replica may hold the send lease before another may take it. */
export const INSTANCE_STATS_LEASE_TTL_MS = 15 * 60 * 1000;

/** What one attempt stores (the exact payload included). */
export type InstanceStatsAttemptRow = Pick<
    EverStatsReport,
    | 'reportId'
    | 'period'
    | 'final'
    | 'payload'
    | 'bytes'
    | 'status'
    | 'httpStatus'
    | 'errorCode'
    | 'errors'
    | 'attempt'
    | 'moduleVersion'
    | 'attemptedAt'
>;

/**
 * Persistence of the statistics schedule, its compare-and-set lease and the
 * stored attempts.
 *
 * The lease is ONE row taken with a conditional update (`holder` free or
 * expired) — the database decides which replica wins, so two replicas firing
 * in the same second send one report. The holder id is this process's pid
 * plus random bytes: it names a process, never a host.
 */
@Injectable()
export class InstanceStatsLeaseService {
    readonly holderId = `${process.pid}:${randomBytes(6).toString('hex')}`;

    constructor(
        @InjectRepository(EverStatsLease) private readonly leases: Repository<EverStatsLease>,
        @InjectRepository(EverStatsReport) private readonly reports: Repository<EverStatsReport>,
    ) {}

    async schedule(): Promise<EverStatsLease | null> {
        return this.leases.findOne({ where: { id: EVER_STATS_LEASE_ROW_ID } });
    }

    /** The schedule row, created with `nextSendAt` on first use (one row whichever replica wins). */
    async ensureSchedule(nextSendAt: Date): Promise<EverStatsLease> {
        const existing = await this.schedule();
        if (existing) return existing;
        await this.leases
            .createQueryBuilder()
            .insert()
            .into(EverStatsLease)
            .values({ id: EVER_STATS_LEASE_ROW_ID, nextSendAt, failures: 0 })
            .orIgnore()
            .execute();
        const row = await this.schedule();
        if (!row) throw new Error('ever_stats_lease row could not be created');
        return row;
    }

    /** Take the lease if it is free or expired. `true` = this replica may send now. */
    async tryAcquire(now: Date): Promise<boolean> {
        const result = await this.leases
            .createQueryBuilder()
            .update(EverStatsLease)
            .set({
                holder: this.holderId,
                expiresAt: new Date(now.getTime() + INSTANCE_STATS_LEASE_TTL_MS),
            })
            .where(`${this.column('id')} = :id`, { id: EVER_STATS_LEASE_ROW_ID })
            .andWhere(
                `(${this.column('holder')} IS NULL OR ${this.column('expiresAt')} IS NULL OR ${this.column(
                    'expiresAt',
                )} < :now)`,
                { now },
            )
            .execute();
        return (result.affected ?? 0) === 1;
    }

    /** Release the lease if this replica still holds it. */
    async release(): Promise<void> {
        await this.leases
            .createQueryBuilder()
            .update(EverStatsLease)
            .set({ holder: null, expiresAt: null })
            .where(`${this.column('id')} = :id`, { id: EVER_STATS_LEASE_ROW_ID })
            .andWhere(`${this.column('holder')} = :holder`, { holder: this.holderId })
            .execute();
    }

    /** A column name quoted for the running driver (camelCase columns need quotes on Postgres). */
    private column(name: string): string {
        return this.leases.manager.connection.driver.escape(name);
    }

    async updateSchedule(
        patch: Partial<
            Pick<
                EverStatsLease,
                'nextSendAt' | 'failures' | 'rejectedModuleVersion' | 'lastManualSendAt'
            >
        >,
    ): Promise<void> {
        await this.leases.update({ id: EVER_STATS_LEASE_ROW_ID }, patch);
    }

    /** Store one attempt and keep only the newest {@link EVER_STATS_REPORTS_KEPT}. */
    async recordAttempt(row: InstanceStatsAttemptRow): Promise<void> {
        await this.reports.save(this.reports.create(row));
        const keep = await this.reports.find({
            order: { attemptedAt: 'DESC' },
            take: EVER_STATS_REPORTS_KEPT,
            select: { reportId: true, attemptedAt: true },
        });
        if (keep.length < EVER_STATS_REPORTS_KEPT) return;
        const oldestKept = keep[keep.length - 1].attemptedAt;
        await this.reports.delete({ attemptedAt: LessThan(oldestKept) });
    }

    async lastReport(): Promise<EverStatsReport | null> {
        const [row] = await this.reports.find({ order: { attemptedAt: 'DESC' }, take: 1 });
        return row ?? null;
    }

    /** Whether the closed month `period` was already delivered (`final: true`, `sent`). */
    async finalSent(period: string): Promise<boolean> {
        const count = await this.reports.count({ where: { period, final: true, status: 'sent' } });
        return count > 0;
    }
}
