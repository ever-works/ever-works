import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import type { Repository } from 'typeorm';
import { EVER_CONNECT_LEASE_ROW_ID, EverConnectLease } from '@ever-works/agent/entities';

/** How long a held lease lasts without renewal. */
export const EVER_CONNECT_LEASE_TTL_MS = 2 * 60 * 1000;

/**
 * The lease that makes one replica run the Ever Connect worker (the feed and
 * the outbox): a compare-and-set on one row, renewed on every round.
 */
@Injectable()
export class EverConnectLeaseService {
    readonly holderId = `${process.pid}:${randomBytes(6).toString('hex')}`;

    constructor(
        @InjectRepository(EverConnectLease) private readonly leases: Repository<EverConnectLease>,
    ) {}

    /** Take the lease, or renew it when this replica holds it. */
    async hold(now = new Date()): Promise<boolean> {
        await this.leases
            .createQueryBuilder()
            .insert()
            .into(EverConnectLease)
            .values({ id: EVER_CONNECT_LEASE_ROW_ID, holder: null, expiresAt: null })
            .orIgnore()
            .execute();
        const result = await this.leases
            .createQueryBuilder()
            .update(EverConnectLease)
            .set({
                holder: this.holderId,
                expiresAt: new Date(now.getTime() + EVER_CONNECT_LEASE_TTL_MS),
            })
            .where(`${this.column('id')} = :id`, { id: EVER_CONNECT_LEASE_ROW_ID })
            .andWhere(
                `(${this.column('holder')} IS NULL OR ${this.column('holder')} = :holder OR ${this.column(
                    'expiresAt',
                )} IS NULL OR ${this.column('expiresAt')} < :now)`,
                { holder: this.holderId, now },
            )
            .execute();
        return (result.affected ?? 0) === 1;
    }

    /** Release the lease if this replica holds it. */
    async release(): Promise<void> {
        await this.leases
            .createQueryBuilder()
            .update(EverConnectLease)
            .set({ holder: null, expiresAt: null })
            .where(`${this.column('id')} = :id`, { id: EVER_CONNECT_LEASE_ROW_ID })
            .andWhere(`${this.column('holder')} = :holder`, { holder: this.holderId })
            .execute();
    }

    /** A column name quoted for the running driver (camelCase columns need quotes on Postgres). */
    private column(name: string): string {
        return this.leases.manager.connection.driver.escape(name);
    }
}
