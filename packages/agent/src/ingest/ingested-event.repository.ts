import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { IngestedEvent } from '../entities/ingested-event.entity';

/**
 * Dedupe identity for an ingested event: sha256 over
 * `(userId, source, sourceEventId)`.
 *
 * The envelope identity is `(source, sourceEventId)` — it is scoped per
 * OWNER here so two users connected to the same external workspace each
 * keep their own row (a global key would silently drop the second
 * user's delivery and leak the first user's row back to them).
 * Segments are length-prefixed so `('ab','c')` and `('a','bc')` can
 * never collide.
 */
export function computeDedupeKey(userId: string, source: string, sourceEventId: string): string {
    const hash = createHash('sha256');
    for (const segment of [userId, source, sourceEventId]) {
        hash.update(`${segment.length}:${segment}|`);
    }
    return hash.digest('hex');
}

export interface CreateIngestedEventData {
    userId: string;
    organizationId?: string | null;
    workId?: string | null;
    source: string;
    sourceEventId: string;
    kind: string;
    occurredAt: Date;
    actorName?: string | null;
    subjectType?: string | null;
    subjectExternalId?: string | null;
    title?: string | null;
    sourceUrl?: string | null;
    payload: Record<string, unknown>;
}

/**
 * Feature-owned repository (provided by `EventIngestModule`, not
 * `DatabaseModule` — same split as `WorkProposalRepository`).
 */
@Injectable()
export class IngestedEventRepository {
    constructor(
        @InjectRepository(IngestedEvent)
        private readonly repository: Repository<IngestedEvent>,
    ) {}

    /**
     * Insert the event unless a row with the same dedupe identity
     * already exists. Check-then-insert is not atomic, so the UNIQUE
     * index race is treated as the idempotent outcome it should be
     * (same convention as `ActivityLogService.ingestFromWebsite`).
     */
    async createIfNew(
        data: CreateIngestedEventData,
    ): Promise<{ event: IngestedEvent; created: boolean }> {
        const dedupeKey = computeDedupeKey(data.userId, data.source, data.sourceEventId);

        const existing = await this.repository.findOne({ where: { dedupeKey } });
        if (existing) {
            return { event: existing, created: false };
        }

        try {
            const event = await this.repository.save(
                this.repository.create({ ...data, dedupeKey }),
            );
            return { event, created: true };
        } catch (error) {
            if (this.isUniqueViolation(error)) {
                const winner = await this.repository.findOne({ where: { dedupeKey } });
                if (winner) {
                    return { event: winner, created: false };
                }
            }
            throw error;
        }
    }

    /** Oldest-first batch of rows the processor has not drained yet. */
    async findUnprocessed(limit: number): Promise<IngestedEvent[]> {
        return this.repository.find({
            where: { processedAt: IsNull() },
            order: { occurredAt: 'ASC', createdAt: 'ASC' },
            take: limit,
        });
    }

    async markProcessed(id: string, processedAt: Date = new Date()): Promise<void> {
        await this.repository.update(id, { processedAt });
    }

    /** Owner-scoped recent events (chat tool + future feed surfaces). */
    async findRecentByUser(userId: string, limit = 20): Promise<IngestedEvent[]> {
        return this.repository.find({
            where: { userId },
            order: { occurredAt: 'DESC' },
            take: limit,
        });
    }

    async findById(id: string): Promise<IngestedEvent | null> {
        return this.repository.findOne({ where: { id } });
    }

    private isUniqueViolation(error: unknown): boolean {
        if (!error || typeof error !== 'object') return false;
        const driverCode = (error as { driverError?: { code?: string } }).driverError?.code;
        const topCode = (error as { code?: string }).code;
        // Postgres 23505 / MySQL ER_DUP_ENTRY / SQLite SQLITE_CONSTRAINT —
        // same convention as ActivityLogService.isUniqueViolation.
        const codes = ['23505', 'ER_DUP_ENTRY', 'SQLITE_CONSTRAINT'];
        return codes.includes(driverCode as string) || codes.includes(topCode as string);
    }
}
