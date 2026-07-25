import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IngestCursor } from '../entities/ingest-cursor.entity';

export interface SaveIngestCursorData {
    userId: string;
    pluginId: string;
    cursor?: string | null;
    watermark?: Date | null;
    sweepStartedAt?: Date | null;
}

/**
 * Event-ingest spine (Wave 8) — per-(user, plugin) pull-state rows for
 * the event-source pull path. Feature-owned repository (provided by
 * `EventIngestModule`, not `DatabaseModule` — same split as
 * `IngestedEventRepository`).
 */
@Injectable()
export class IngestCursorRepository {
    constructor(
        @InjectRepository(IngestCursor)
        private readonly repository: Repository<IngestCursor>,
    ) {}

    async findByUserAndPlugin(userId: string, pluginId: string): Promise<IngestCursor | null> {
        return this.repository.findOne({ where: { userId, pluginId } });
    }

    /**
     * Upsert the pull state for one (user, plugin). Check-then-insert
     * is not atomic; the UNIQUE-index race is resolved by retrying as
     * an update (same convention as `IngestedEventRepository`).
     */
    async save(data: SaveIngestCursorData): Promise<IngestCursor> {
        const existing = await this.findByUserAndPlugin(data.userId, data.pluginId);
        if (existing) {
            existing.cursor = data.cursor ?? null;
            existing.watermark = data.watermark ?? null;
            existing.sweepStartedAt = data.sweepStartedAt ?? null;
            return this.repository.save(existing);
        }
        try {
            return await this.repository.save(this.repository.create({ ...data }));
        } catch (error) {
            if (this.isUniqueViolation(error)) {
                const winner = await this.findByUserAndPlugin(data.userId, data.pluginId);
                if (winner) {
                    winner.cursor = data.cursor ?? null;
                    winner.watermark = data.watermark ?? null;
                    winner.sweepStartedAt = data.sweepStartedAt ?? null;
                    return this.repository.save(winner);
                }
            }
            throw error;
        }
    }

    private isUniqueViolation(error: unknown): boolean {
        if (!error || typeof error !== 'object') return false;
        const driverCode = (error as { driverError?: { code?: string } }).driverError?.code;
        const topCode = (error as { code?: string }).code;
        const codes = ['23505', 'ER_DUP_ENTRY', 'SQLITE_CONSTRAINT'];
        return codes.includes(driverCode as string) || codes.includes(topCode as string);
    }
}
