import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Meeting, MeetingParticipant, MeetingSource } from '../entities/meeting.entity';

/**
 * Dedupe identity for a provider-synced meeting: sha256 over
 * `(userId, source, externalId)`.
 *
 * The provider identity is `(source, externalId)` — it is scoped per
 * OWNER here so two users syncing the same provider account each keep
 * their own row (a global key would silently drop the second user's
 * sync and leak the first user's row back to them — same rationale as
 * `computeDedupeKey` in the ingest spine). Segments are
 * length-prefixed so `('ab','c')` and `('a','bc')` can never collide.
 */
export function computeMeetingDedupeKey(
    userId: string,
    source: string,
    externalId: string,
): string {
    const hash = createHash('sha256');
    for (const segment of [userId, source, externalId]) {
        hash.update(`${segment.length}:${segment}|`);
    }
    return hash.digest('hex');
}

export interface CreateMeetingData {
    userId: string;
    organizationId?: string | null;
    workId?: string | null;
    title: string;
    startedAt: Date;
    endedAt?: Date | null;
    source: MeetingSource;
    externalId?: string | null;
    participants?: MeetingParticipant[];
    transcriptText?: string | null;
    summary?: string | null;
    sourceUrl?: string | null;
}

export interface FindMeetingsFilters {
    workId?: string;
    source?: MeetingSource;
    /** Only meetings that started at/after this instant. */
    since?: Date;
    limit?: number;
    offset?: number;
}

/**
 * Feature-owned repository (provided by `MeetingsModule`, not
 * `DatabaseModule` — same split as `IngestedEventRepository`).
 */
@Injectable()
export class MeetingRepository {
    constructor(
        @InjectRepository(Meeting)
        private readonly repository: Repository<Meeting>,
    ) {}

    /**
     * Insert the meeting unless a row with the same dedupe identity
     * already exists (provider-synced meetings only — manual rows have
     * no `externalId` and always insert). Check-then-insert is not
     * atomic, so the UNIQUE index race is treated as the idempotent
     * outcome it should be (same convention as
     * `IngestedEventRepository.createIfNew`).
     */
    async createIfNew(data: CreateMeetingData): Promise<{ meeting: Meeting; created: boolean }> {
        const dedupeKey = data.externalId
            ? computeMeetingDedupeKey(data.userId, data.source, data.externalId)
            : null;

        if (dedupeKey) {
            const existing = await this.repository.findOne({ where: { dedupeKey } });
            if (existing) {
                return { meeting: existing, created: false };
            }
        }

        try {
            const meeting = await this.repository.save(
                this.repository.create({
                    ...data,
                    participants: data.participants ?? [],
                    dedupeKey,
                }),
            );
            return { meeting, created: true };
        } catch (error) {
            if (dedupeKey && this.isUniqueViolation(error)) {
                const winner = await this.repository.findOne({ where: { dedupeKey } });
                if (winner) {
                    return { meeting: winner, created: false };
                }
            }
            throw error;
        }
    }

    /** Owner-scoped listing, newest meetings first. */
    async findByUser(userId: string, filters: FindMeetingsFilters = {}): Promise<Meeting[]> {
        const qb = this.repository
            .createQueryBuilder('meeting')
            .where('meeting.userId = :userId', { userId });

        if (filters.workId) {
            qb.andWhere('meeting.workId = :workId', { workId: filters.workId });
        }
        if (filters.source) {
            qb.andWhere('meeting.source = :source', { source: filters.source });
        }
        if (filters.since) {
            qb.andWhere('meeting.startedAt >= :since', { since: filters.since });
        }

        return qb
            .orderBy('meeting.startedAt', 'DESC')
            .take(Math.min(Math.max(filters.limit ?? 20, 1), 100))
            .skip(Math.max(filters.offset ?? 0, 0))
            .getMany();
    }

    async findById(id: string): Promise<Meeting | null> {
        return this.repository.findOne({ where: { id } });
    }

    /** Attach (or replace) the captured transcript text. */
    async attachTranscript(id: string, transcriptText: string): Promise<void> {
        await this.repository.update(id, { transcriptText });
    }

    /** Attach the generated summary (best-effort producer). */
    async attachSummary(id: string, summary: string): Promise<void> {
        await this.repository.update(id, { summary });
    }

    async update(id: string, patch: Partial<CreateMeetingData>): Promise<void> {
        await this.repository.update(id, patch);
    }

    async delete(id: string): Promise<void> {
        await this.repository.delete(id);
    }

    private isUniqueViolation(error: unknown): boolean {
        if (!error || typeof error !== 'object') return false;
        const driverCode = (error as { driverError?: { code?: string } }).driverError?.code;
        const topCode = (error as { code?: string }).code;
        // Postgres 23505 / MySQL ER_DUP_ENTRY / SQLite SQLITE_CONSTRAINT —
        // same convention as IngestedEventRepository.isUniqueViolation.
        const codes = ['23505', 'ER_DUP_ENTRY', 'SQLITE_CONSTRAINT'];
        return codes.includes(driverCode as string) || codes.includes(topCode as string);
    }
}
