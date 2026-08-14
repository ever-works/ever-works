import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InboundTriggerFire } from '../entities/inbound-trigger-fire.entity';

/**
 * Feature-owned repository over the `(trigger, event)` fire ledger
 * (provided by `InboundTriggersModule`, not `DatabaseModule` — same
 * split as `IngestedEventRepository`).
 *
 * `claim()` is the idempotency primitive of the event-firing path:
 * insert-if-new on the UNIQUE `(triggerId, eventId)` index. The ingest
 * drain retries batches after partial failures, so the same event is
 * offered to the same trigger more than once — only the caller that
 * won the insert actually fires. Check-then-insert is not atomic; the
 * UNIQUE-violation race is treated as the idempotent outcome it should
 * be (same convention as `IngestedEventRepository.createIfNew`).
 */
@Injectable()
export class InboundTriggerFireRepository {
    constructor(
        @InjectRepository(InboundTriggerFire)
        private readonly repository: Repository<InboundTriggerFire>,
    ) {}

    /** True when this call won the `(triggerId, eventId)` claim. */
    async claim(triggerId: string, eventId: string): Promise<boolean> {
        const existing = await this.repository.findOne({ where: { triggerId, eventId } });
        if (existing) return false;
        try {
            await this.repository.save(
                this.repository.create({ triggerId, eventId, taskId: null }),
            );
            return true;
        } catch (error) {
            if (this.isUniqueViolation(error)) return false;
            throw error;
        }
    }

    /** Stamp the Task a won claim spawned — provenance, best-effort. */
    async attachTask(triggerId: string, eventId: string, taskId: string): Promise<void> {
        await this.repository.update({ triggerId, eventId }, { taskId });
    }

    private isUniqueViolation(error: unknown): boolean {
        if (!error || typeof error !== 'object') return false;
        const driverCode = (error as { driverError?: { code?: string } }).driverError?.code;
        const topCode = (error as { code?: string }).code;
        const codes = ['23505', 'ER_DUP_ENTRY', 'SQLITE_CONSTRAINT'];
        return codes.includes(driverCode as string) || codes.includes(topCode as string);
    }
}
