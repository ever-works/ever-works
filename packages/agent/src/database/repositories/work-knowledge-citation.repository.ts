import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkKnowledgeCitation } from '../../entities/work-knowledge-citation.entity';
import { KbCitationConsumerType } from '../../entities/kb-types';

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
}
