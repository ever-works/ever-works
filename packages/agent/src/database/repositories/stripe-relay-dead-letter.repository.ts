import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import {
    StripeRelayDeadLetter,
    StripeRelayDeadLetterResolution,
    StripeRelayDeadLetterStatus,
} from '@src/entities/stripe-relay-dead-letter.entity';

export interface StripeRelayDeadLetterFailure {
    eventId: string;
    eventType: string;
    workId: string | null;
    livemode: boolean;
    disposition: 'retry' | 'unroutable';
    reason: string;
    siteStatus: number | null;
    /** The verbatim body Stripe signed. */
    payload: string;
    at: Date;
}

/** A dead letter as the admin listing shows it: everything except the payload. */
export type StripeRelayDeadLetterSummary = Omit<StripeRelayDeadLetter, 'payload'>;

const SUMMARY_COLUMNS: (keyof StripeRelayDeadLetter)[] = [
    'id',
    'eventId',
    'eventType',
    'workId',
    'livemode',
    'disposition',
    'reason',
    'siteStatus',
    'attempts',
    'status',
    'resolution',
    'firstFailedAt',
    'lastFailedAt',
    'resolvedAt',
    'createdAt',
    'updatedAt',
];

/**
 * Persistence for events the shared Stripe webhook relay could not deliver
 * (audit CC05-06). One row per Stripe event id; repeated failures of the same
 * event bump `attempts` on that row instead of adding rows.
 *
 * A resolved row is never re-opened by a later failure of the same event: it
 * was delivered (or an operator dealt with it), and a stray duplicate delivery
 * failing afterwards changes nothing for the customer.
 */
@Injectable()
export class StripeRelayDeadLetterRepository {
    constructor(
        @InjectRepository(StripeRelayDeadLetter)
        private readonly repository: Repository<StripeRelayDeadLetter>,
    ) {}

    findByEventId(eventId: string): Promise<StripeRelayDeadLetter | null> {
        return this.repository.findOne({ where: { eventId } });
    }

    /**
     * Record one failed delivery attempt. Creates the row on the first failure
     * and bumps `attempts` on every later one while it is still open.
     */
    async recordFailure(failure: StripeRelayDeadLetterFailure): Promise<StripeRelayDeadLetter> {
        const existing = await this.findByEventId(failure.eventId);
        if (existing) {
            return this.bumpOpen(existing, failure);
        }

        try {
            return await this.repository.save(
                this.repository.create({
                    eventId: failure.eventId,
                    eventType: failure.eventType,
                    workId: failure.workId,
                    livemode: failure.livemode,
                    disposition: failure.disposition,
                    reason: failure.reason,
                    siteStatus: failure.siteStatus,
                    attempts: 1,
                    status: StripeRelayDeadLetterStatus.OPEN,
                    resolution: null,
                    payload: failure.payload,
                    firstFailedAt: failure.at,
                    lastFailedAt: failure.at,
                    resolvedAt: null,
                }),
            );
        } catch (error) {
            // Stripe can deliver one event to two API pods at once. Only the
            // UNIQUE(eventId) race is expected: re-read the winner and count
            // this attempt on it instead of surfacing a false failure.
            const raced = await this.findByEventId(failure.eventId);
            if (raced) return this.bumpOpen(raced, failure);
            throw error;
        }
    }

    /**
     * Close an open dead letter. Returns false when there was nothing open to
     * close (no row, or already resolved), so callers can tell a real
     * resolution from a no-op.
     */
    async markResolved(
        eventId: string,
        resolution: StripeRelayDeadLetterResolution,
        at: Date = new Date(),
    ): Promise<boolean> {
        const result = await this.repository.update(
            { eventId, status: StripeRelayDeadLetterStatus.OPEN },
            { status: StripeRelayDeadLetterStatus.RESOLVED, resolution, resolvedAt: at },
        );
        return (result.affected ?? 0) > 0;
    }

    /** Newest failures first; never includes the payload. */
    list(options: {
        status?: StripeRelayDeadLetterStatus;
        limit: number;
        offset?: number;
    }): Promise<[StripeRelayDeadLetterSummary[], number]> {
        return this.repository.findAndCount({
            select: SUMMARY_COLUMNS,
            where: options.status ? { status: options.status } : {},
            order: { lastFailedAt: 'DESC' },
            take: options.limit,
            skip: options.offset ?? 0,
        });
    }

    /**
     * Open dead letters whose FIRST failure is at or before `failedBefore`.
     * The health probe uses a grace period so an event Stripe is still
     * retrying through a short site restart does not page anyone.
     */
    countOpen(failedBefore?: Date): Promise<number> {
        return this.repository.count({
            where: failedBefore
                ? {
                      status: StripeRelayDeadLetterStatus.OPEN,
                      firstFailedAt: LessThanOrEqual(failedBefore),
                  }
                : { status: StripeRelayDeadLetterStatus.OPEN },
        });
    }

    private async bumpOpen(
        row: StripeRelayDeadLetter,
        failure: StripeRelayDeadLetterFailure,
    ): Promise<StripeRelayDeadLetter> {
        if (row.status !== StripeRelayDeadLetterStatus.OPEN) {
            return row;
        }
        await this.repository.increment(
            { id: row.id, status: StripeRelayDeadLetterStatus.OPEN },
            'attempts',
            1,
        );
        await this.repository.update(
            { id: row.id, status: StripeRelayDeadLetterStatus.OPEN },
            {
                disposition: failure.disposition,
                reason: failure.reason,
                siteStatus: failure.siteStatus,
                lastFailedAt: failure.at,
            },
        );
        return (await this.findByEventId(failure.eventId)) ?? row;
    }
}
