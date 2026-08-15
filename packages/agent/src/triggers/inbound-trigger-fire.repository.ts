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
 *
 * One rule overrides BOTH: a claim that ended `'failed'` or
 * `'refused'` produced NO Task, so it never consumed the delivery and
 * is always re-claimable. Dedupe exists to stop a retry creating a
 * SECOND Task; when the first attempt created zero, answering the
 * retry with "duplicate, nothing to do" would drop the delivery on the
 * floor — and a 5xx is exactly what makes a sender retry.
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
     * fresh `running` fire); without it, any existing claim wins forever
     * — UNLESS that claim produced nothing (see
     * {@link producedNoTask}), which is always re-claimable.
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
            if (!this.producedNoTask(existing) && (windowMs === undefined || age <= windowMs)) {
                return { fire: existing, won: false };
            }
            // Explicit UPDATE rather than save(): `firedAt` is a
            // @CreateDateColumn, and entity-persistence treats those as
            // insert-only — a re-claim that failed to move the timestamp
            // would leave the window anchored on the ORIGINAL delivery
            // and let later duplicates through.
            const reclaimed: Partial<InboundTriggerFire> = {
                origin,
                status: 'running',
                reason: null,
                taskId: null,
                firedAt: new Date(),
            };
            await this.repository.update(existing.id, reclaimed);
            return { fire: Object.assign(existing, reclaimed), won: true };
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

    /**
     * True for a settled claim that created no Task: `'failed'` (the
     * fire blew up) or `'refused'` (the trigger's own contract said
     * no). `'running'` is NOT included — that is either a live fire or
     * a concurrent claimant, and stealing it is how a delivery gets
     * processed twice.
     */
    private producedNoTask(fire: InboundTriggerFire): boolean {
        return (fire.status === 'failed' || fire.status === 'refused') && !fire.taskId;
    }

    private isUniqueViolation(error: unknown): boolean {
        if (!error || typeof error !== 'object') return false;
        const driverCode = (error as { driverError?: { code?: string } }).driverError?.code;
        const topCode = (error as { code?: string }).code;
        const codes = ['23505', 'ER_DUP_ENTRY', 'SQLITE_CONSTRAINT'];
        return codes.includes(driverCode as string) || codes.includes(topCode as string);
    }
}
