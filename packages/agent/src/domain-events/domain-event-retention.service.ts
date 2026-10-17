import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, IsNull, LessThan, Not } from 'typeorm';
import { DomainEvent } from '../entities/domain-event.entity';
import {
    DOMAIN_EVENT_RELAY_STATE_ID,
    DomainEventRelayState,
} from '../entities/domain-event-relay-state.entity';
import { seqToBigInt } from './domain-event-envelope';

/** Rows deleted per statement (portable: select ids, then delete by id). */
const PURGE_BATCH = 1000;
/** Upper bound per run, so one run never holds the relay for long. */
const PURGE_MAX_PER_RUN = 50_000;

export interface DomainEventPurgeResult {
    readonly deleted: number;
    /** The retention floor after the run: feed cursors below it answer 410. */
    readonly floor: string;
}

/**
 * Deletes dispatched domain events older than the retention window
 * (`DOMAIN_EVENTS_RETENTION_DAYS`, default 30) and records the retention floor
 * — the highest feed position deleted — so the feed can answer
 * `410 cursor_expired` to a cursor below it.
 *
 * Undispatched rows are never deleted, whatever their age. Run by the relay
 * leader at most hourly; bounded per run and per statement; never throws for
 * a partial run (what was deleted stays deleted and the floor covers it).
 */
@Injectable()
export class DomainEventRetentionService {
    private readonly logger = new Logger(DomainEventRetentionService.name);

    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async purge(now: Date, retentionDays: number): Promise<DomainEventPurgeResult> {
        const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
        const events = this.dataSource.getRepository(DomainEvent);
        let deleted = 0;
        let maxSeq = 0n;

        while (deleted < PURGE_MAX_PER_RUN) {
            const batch = await events.find({
                where: { dispatchedAt: LessThan(cutoff), seq: Not(IsNull()) },
                order: { seq: 'ASC' },
                take: PURGE_BATCH,
                select: { outboxSeq: true, seq: true },
            });
            if (batch.length === 0) break;
            for (const row of batch) {
                const seq = seqToBigInt(row.seq);
                if (seq > maxSeq) maxSeq = seq;
            }
            // Raise the floor BEFORE deleting, so a reader never sees a hole the
            // floor does not yet cover.
            await this.raiseFloor(maxSeq);
            const result = await events.delete({
                outboxSeq: In(batch.map((row) => row.outboxSeq)),
                dispatchedAt: LessThan(cutoff),
            });
            deleted += result.affected ?? batch.length;
            if (batch.length < PURGE_BATCH) break;
        }

        const state = await this.dataSource
            .getRepository(DomainEventRelayState)
            .findOne({ where: { id: DOMAIN_EVENT_RELAY_STATE_ID } });
        if (deleted > 0) {
            this.logger.log(`Purged ${deleted} domain events older than ${retentionDays} days`);
        }
        return { deleted, floor: seqToBigInt(state?.retentionFloorSeq).toString() };
    }

    private async raiseFloor(seq: bigint): Promise<void> {
        if (seq <= 0n) return;
        const escape = (name: string) => this.dataSource.driver.escape(name);
        await this.dataSource
            .createQueryBuilder()
            .update(DomainEventRelayState)
            .set({ retentionFloorSeq: seq.toString() })
            .where(`${escape('id')} = :id`, { id: DOMAIN_EVENT_RELAY_STATE_ID })
            .andWhere(`${escape('retentionFloorSeq')} < :seq`, { seq: seq.toString() })
            .execute();
    }
}
