import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    InboundTriggerFire,
    type InboundTriggerFireOrigin,
    type InboundTriggerFireStatus,
} from '../entities/inbound-trigger-fire.entity';

/** What a claim attempt produced. */
export interface FireClaim {
    /** The ledger row — the winner's fresh row, or the duplicate's existing one. */
    fire: InboundTriggerFire;
    /** False when an earlier fire already owns this delivery identity. */
    won: boolean;
}

/**
 * Feature-owned repository over the fire ledger / fire log (provided by
 * `InboundTriggersModule`, not `DatabaseModule` — same split as
 * `IngestedEventRepository`).
 *
 * `claim()` is the idempotency primitive of both delivery paths:
 * insert-if-new on the UNIQUE `(triggerId, dedupeKey)` index. The ingest
 * drain retries batches after partial failures and webhook senders retry
 * on timeout, so the same delivery is offered more than once — only the
 * caller that won the insert actually fires. Check-then-insert is not
 * atomic; the UNIQUE-violation race is treated as the idempotent outcome
 * it should be (same convention as `IngestedEventRepository.createIfNew`).
 *
 * `windowMs` is what separates the two paths: the event path passes
 * none (an ingested event fires a trigger once, forever), the webhook
 * path passes the trigger's `replayWindowSec` so a retry inside the
 * window dedupes while a genuine later re-delivery of the same id is a
 * new fire — the older row is re-claimed in place, which keeps the
 * UNIQUE index intact.
 */
@Injectable()
export class InboundTriggerFireRepository {
    constructor(
        @InjectRepository(InboundTriggerFire)
        private readonly repository: Repository<InboundTriggerFire>,
    ) {}

    /**
     * Claim `dedupeKey` for `triggerId`. With `windowMs` set, an existing
     * claim older than the window is RE-claimed (same row, reset to a
     * fresh `running` fire); without it, any existing claim wins forever.
     */
    async claim(
        triggerId: string,
        dedupeKey: string,
        origin: InboundTriggerFireOrigin,
        windowMs?: number,
    ): Promise<FireClaim> {
        const existing = await this.repository.findOne({ where: { triggerId, dedupeKey } });
        if (existing) {
            const age = Date.now() - new Date(existing.firedAt).getTime();
            if (windowMs === undefined || age <= windowMs) {
                return { fire: existing, won: false };
            }
            existing.origin = origin;
            existing.status = 'running';
            existing.reason = null;
            existing.taskId = null;
            existing.firedAt = new Date();
            return { fire: await this.repository.save(existing), won: true };
        }
        try {
            const fire = await this.repository.save(
                this.repository.create({
                    triggerId,
                    dedupeKey,
                    origin,
                    status: 'running',
                    reason: null,
                    taskId: null,
                }),
            );
            return { fire, won: true };
        } catch (error) {
            if (!this.isUniqueViolation(error)) throw error;
            // Lost the insert race — the winner's row is the truth.
            const winner = await this.repository.findOne({ where: { triggerId, dedupeKey } });
            if (winner) return { fire: winner, won: false };
            throw error;
        }
    }

    /** Stamp the terminal state of a fire (best-effort provenance, never throws for callers). */
    async complete(
        fireId: string,
        status: InboundTriggerFireStatus,
        patch: { taskId?: string | null; reason?: string | null } = {},
    ): Promise<void> {
        await this.repository.update(fireId, {
            status,
            taskId: patch.taskId ?? null,
            reason: patch.reason ?? null,
        });
    }

    /** Most recent fires first, capped — backs the trigger detail page's log. */
    async listRecent(triggerId: string, limit: number): Promise<InboundTriggerFire[]> {
        return this.repository.find({
            where: { triggerId },
            order: { firedAt: 'DESC' },
            take: limit,
        });
    }

    private isUniqueViolation(error: unknown): boolean {
        if (!error || typeof error !== 'object') return false;
        const driverCode = (error as { driverError?: { code?: string } }).driverError?.code;
        const topCode = (error as { code?: string }).code;
        const codes = ['23505', 'ER_DUP_ENTRY', 'SQLITE_CONSTRAINT'];
        return codes.includes(driverCode as string) || codes.includes(topCode as string);
    }
}
