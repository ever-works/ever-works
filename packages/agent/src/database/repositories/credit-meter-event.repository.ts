import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { BillingProfile } from '@src/entities/billing-profile.entity';
import { CreditMeterEvent, CreditMeterEventStatus } from '@src/entities/credit-meter-event.entity';

export interface CreditMeterEventWrite {
    userId: string;
    organizationId?: string | null;
    tenantId?: string | null;
    runId: string;
    identifier: string;
    credits: number;
    writtenOffCredits: number;
    costCentsRef?: number | null;
    periodStart: Date;
    periodEnd: Date;
}

export type CreditMeterEventInsert =
    | { status: 'created'; event: CreditMeterEvent }
    | { status: 'idempotent'; event: CreditMeterEvent };

export interface CreditMeterEventCapReservation {
    write: Omit<CreditMeterEventWrite, 'credits' | 'writtenOffCredits'>;
    requestedCredits: number;
    capCredits: number;
}

export type CreditMeterEventCapReservationResult =
    | {
          status: 'created' | 'idempotent';
          event: CreditMeterEvent;
          usedCreditsAfter: number;
      }
    | {
          status: 'cap-exhausted';
          event: null;
          billedCredits: 0;
          writtenOffCredits: number;
          usedCreditsAfter: number;
      };

/**
 * Pay-as-you-go meter events (billing spec §3.5) — the platform-side
 * mirror of what is reported to the provider's usage meter. Idempotent
 * on `identifier` (`run:{runId}`), so a retried settlement writes one
 * row; the flush cron resends `pending` rows. `failed` is terminal and
 * retained for manual reconciliation.
 */
@Injectable()
export class CreditMeterEventRepository {
    constructor(
        @InjectRepository(CreditMeterEvent)
        private readonly repository: Repository<CreditMeterEvent>,
    ) {}

    /** Insert-if-absent on `identifier`; a concurrent duplicate resolves to the survivor. */
    async insertIdempotent(write: CreditMeterEventWrite): Promise<CreditMeterEventInsert> {
        const existing = await this.repository.findOne({ where: { identifier: write.identifier } });
        if (existing) {
            return { status: 'idempotent', event: existing };
        }
        try {
            const event = await this.repository.save(
                this.repository.create({
                    ...write,
                    organizationId: write.organizationId ?? null,
                    tenantId: write.tenantId ?? null,
                    costCentsRef: write.costCentsRef ?? null,
                    status: CreditMeterEventStatus.PENDING,
                    attempts: 0,
                    lastError: null,
                    sentAt: null,
                }),
            );
            return { status: 'created', event };
        } catch (error) {
            const survivor = await this.repository.findOne({
                where: { identifier: write.identifier },
            });
            if (survivor && this.isUniqueViolation(error)) {
                return { status: 'idempotent', event: survivor };
            }
            throw error;
        }
    }

    /**
     * Atomically reserve aggregate cycle headroom and insert one run event.
     *
     * A no-op update locks the owner's billing-profile row for the duration
     * of the transaction on every supported database. That serializes the
     * sum + insert across all API replicas: two runs that finish together
     * cannot both observe the same headroom and exceed the promised cap.
     * The identifier is checked again after the lock, so concurrent retries
     * of one run collapse to the same event as well.
     */
    async reserveIdempotentWithinCap(
        reservation: CreditMeterEventCapReservation,
    ): Promise<CreditMeterEventCapReservationResult> {
        const requested = Math.max(0, Math.trunc(reservation.requestedCredits));
        const cap = Math.max(0, Math.trunc(reservation.capCredits));
        return this.repository.manager.transaction(async (manager) => {
            const events = manager.getRepository(CreditMeterEvent);
            const profiles = manager.getRepository(BillingProfile);

            let existing = await events.findOne({
                where: { identifier: reservation.write.identifier },
            });
            if (existing) {
                return {
                    status: 'idempotent' as const,
                    event: existing,
                    usedCreditsAfter: await this.sumWithRepository(
                        events,
                        reservation.write.userId,
                        reservation.write.periodStart,
                        reservation.write.periodEnd,
                    ),
                };
            }

            await profiles
                .createQueryBuilder()
                .update(BillingProfile)
                .set({ paygCapNotifiedPercent: () => '"paygCapNotifiedPercent"' })
                .where('userId = :userId', { userId: reservation.write.userId })
                .execute();

            existing = await events.findOne({
                where: { identifier: reservation.write.identifier },
            });
            const used = await this.sumWithRepository(
                events,
                reservation.write.userId,
                reservation.write.periodStart,
                reservation.write.periodEnd,
            );
            if (existing) {
                return { status: 'idempotent' as const, event: existing, usedCreditsAfter: used };
            }

            const billedCredits = Math.min(requested, Math.max(0, cap - used));
            const writtenOffCredits = requested - billedCredits;
            if (billedCredits <= 0) {
                return {
                    status: 'cap-exhausted' as const,
                    event: null,
                    billedCredits: 0 as const,
                    writtenOffCredits,
                    usedCreditsAfter: used,
                };
            }

            const event = await events.save(
                events.create({
                    ...reservation.write,
                    organizationId: reservation.write.organizationId ?? null,
                    tenantId: reservation.write.tenantId ?? null,
                    costCentsRef: reservation.write.costCentsRef ?? null,
                    credits: billedCredits,
                    writtenOffCredits,
                    status: CreditMeterEventStatus.PENDING,
                    attempts: 0,
                    lastError: null,
                    sentAt: null,
                }),
            );
            return {
                status: 'created' as const,
                event,
                usedCreditsAfter: used + billedCredits,
            };
        });
    }

    findById(id: string): Promise<CreditMeterEvent | null> {
        return this.repository.findOne({ where: { id } });
    }

    findByIdentifier(identifier: string): Promise<CreditMeterEvent | null> {
        return this.repository.findOne({ where: { identifier } });
    }

    /**
     * Credits reported (or queued to be reported) in a cycle. `pending`
     * and `sent` both count — a queued event WILL be billed, so the cap
     * must treat it as spent; `failed` rows were given up on and do not.
     */
    async sumCreditsForPeriod(userId: string, periodStart: Date, periodEnd: Date): Promise<number> {
        return this.sumWithRepository(this.repository, userId, periodStart, periodEnd);
    }

    private async sumWithRepository(
        repository: Repository<CreditMeterEvent>,
        userId: string,
        periodStart: Date,
        periodEnd: Date,
    ): Promise<number> {
        const row = await repository
            .createQueryBuilder('e')
            .select('COALESCE(SUM(e.credits), 0)', 'credits')
            .where('e.userId = :userId', { userId })
            .andWhere('e.periodStart >= :from', { from: periodStart })
            .andWhere('e.periodStart < :to', { to: periodEnd })
            .andWhere('e.status IN (:...statuses)', {
                statuses: [CreditMeterEventStatus.PENDING, CreditMeterEventStatus.SENT],
            })
            .getRawOne<{ credits: string | number }>();
        return Number(row?.credits ?? 0);
    }

    /** Owner-scoped, newest-first, for the Billing page's "this cycle" drill-down. */
    async findForUserInPeriod(
        userId: string,
        periodStart: Date,
        periodEnd: Date,
        take = 50,
    ): Promise<CreditMeterEvent[]> {
        return this.repository
            .createQueryBuilder('e')
            .where('e.userId = :userId', { userId })
            .andWhere('e.periodStart >= :from', { from: periodStart })
            .andWhere('e.periodStart < :to', { to: periodEnd })
            .orderBy('e.createdAt', 'DESC')
            .take(take)
            .getMany();
    }

    /**
     * Rows the flush cron should (re)send: not yet accepted, created
     * before `olderThan` (so the settlement path's own immediate send has
     * had its chance), oldest first, bounded.
     */
    async findUnsent(olderThan: Date, limit: number): Promise<CreditMeterEvent[]> {
        return this.repository.find({
            where: {
                status: In([CreditMeterEventStatus.PENDING]),
                createdAt: LessThan(olderThan),
            },
            order: { createdAt: 'ASC' },
            take: limit,
        });
    }

    async markSent(id: string, sentAt: Date): Promise<void> {
        await this.repository.update(id, {
            status: CreditMeterEventStatus.SENT,
            sentAt,
            lastError: null,
        });
    }

    /** Record a failed attempt; the row stays `pending` unless `terminal`. */
    async recordAttempt(id: string, error: string, terminal: boolean): Promise<void> {
        await this.repository
            .createQueryBuilder()
            .update(CreditMeterEvent)
            .set({
                attempts: () => '"attempts" + 1',
                lastError: error.slice(0, 256),
                ...(terminal ? { status: CreditMeterEventStatus.FAILED } : {}),
            })
            .where('id = :id', { id })
            .execute();
    }

    private isUniqueViolation(error: unknown): boolean {
        const err = error as { code?: string; message?: string; driverError?: { code?: string } };
        if (err?.code === '23505' || err?.driverError?.code === '23505') return true;
        const message = String(err?.message ?? '');
        return (
            message.includes('UNIQUE constraint failed') ||
            message.includes('duplicate key') ||
            message.includes('Duplicate entry')
        );
    }
}
