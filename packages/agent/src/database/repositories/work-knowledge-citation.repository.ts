import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository } from 'typeorm';
import { WorkKnowledgeCitation } from '../../entities/work-knowledge-citation.entity';
import { KbCitationConsumerType } from '../../entities/kb-types';

/** Hard cap on rows returned by the health aggregate read (OOM guard). */
export const KB_CITATION_SCAN_LIMIT = 5000;

@Injectable()
export class WorkKnowledgeCitationRepository {
    constructor(
        @InjectRepository(WorkKnowledgeCitation)
        private readonly repository: Repository<WorkKnowledgeCitation>,
    ) {}

    /**
     * Append-only. Returns the inserted row.
     */
    async record(data: {
        workId: string;
        documentId: string;
        consumerType: KbCitationConsumerType;
        consumerId: string;
        chunkRange?: { start: number; end: number } | null;
        relevanceScore?: number | null;
    }): Promise<WorkKnowledgeCitation> {
        const entity = this.repository.create({
            workId: data.workId,
            documentId: data.documentId,
            consumerType: data.consumerType,
            consumerId: data.consumerId,
            chunkRange: data.chunkRange ?? null,
            relevanceScore: data.relevanceScore ?? null,
        });
        return this.repository.save(entity);
    }

    async listForDocument(documentId: string, limit = 100): Promise<WorkKnowledgeCitation[]> {
        return this.repository.find({
            where: { documentId },
            order: { createdAt: 'DESC' },
            take: limit,
        });
    }

    async listForConsumer(
        consumerType: KbCitationConsumerType,
        consumerId: string,
    ): Promise<WorkKnowledgeCitation[]> {
        return this.repository.find({
            where: { consumerType, consumerId },
            order: { createdAt: 'ASC' },
        });
    }

    /**
     * Memory upgrades M10 — every citation recorded against the given
     * Works since `since`. This is the observed-USAGE half of the
     * recall-hit rate (the retrieval log is the supply half).
     *
     * Scope-bounded by construction: an empty `workIds` returns `[]`
     * rather than degrading into an unscoped cross-tenant scan.
     */
    async listForWorksSince(
        workIds: string[],
        since: Date,
        limit = KB_CITATION_SCAN_LIMIT,
    ): Promise<WorkKnowledgeCitation[]> {
        if (workIds.length === 0) return [];
        return this.repository.find({
            where: { workId: In(workIds), createdAt: MoreThanOrEqual(since) },
            order: { createdAt: 'DESC' },
            take: Math.min(limit, KB_CITATION_SCAN_LIMIT),
        });
    }

    /** Count of citation rows recorded against one document. */
    async countForDocument(documentId: string): Promise<number> {
        return this.repository.count({ where: { documentId } });
    }
}
