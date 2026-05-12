import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    WorkProposal,
    type WorkProposalCategory,
    type WorkProposalField,
    type WorkProposalRecommendedPlugin,
    type WorkProposalSource,
    type WorkProposalStatus,
} from '../entities/work-proposal.entity';

export interface CreateWorkProposalInput {
    userId: string;
    title: string;
    description: string;
    slugSuggestion: string;
    suggestedCategories: WorkProposalCategory[];
    suggestedFields: WorkProposalField[];
    recommendedPlugins: WorkProposalRecommendedPlugin[];
    reasoning: string;
    source: WorkProposalSource;
    generationRunId?: string;
}

@Injectable()
export class WorkProposalRepository {
    constructor(
        @InjectRepository(WorkProposal)
        private readonly repository: Repository<WorkProposal>,
    ) {}

    async bulkInsert(items: CreateWorkProposalInput[]): Promise<WorkProposal[]> {
        if (items.length === 0) return [];
        const entities = items.map((i) =>
            this.repository.create({ ...i, status: 'pending' as WorkProposalStatus }),
        );
        return this.repository.save(entities);
    }

    async findByUser(
        userId: string,
        statuses: WorkProposalStatus[] = ['pending'],
    ): Promise<WorkProposal[]> {
        return this.repository
            .createQueryBuilder('p')
            .where('p.userId = :userId', { userId })
            .andWhere('p.status IN (:...statuses)', { statuses })
            .orderBy('p.generatedAt', 'DESC')
            .getMany();
    }

    async findById(id: string): Promise<WorkProposal | null> {
        return this.repository.findOne({ where: { id } });
    }

    async findByIdForUser(id: string, userId: string): Promise<WorkProposal | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    async markDismissed(id: string, userId: string): Promise<boolean> {
        const res = await this.repository.update(
            { id, userId, status: 'pending' },
            { status: 'dismissed' },
        );
        return (res.affected ?? 0) > 0;
    }

    async markAccepted(id: string, userId: string, workId: string): Promise<boolean> {
        const res = await this.repository.update(
            { id, userId, status: 'pending' },
            { status: 'accepted', acceptedWorkId: workId },
        );
        return (res.affected ?? 0) > 0;
    }

    async countPendingByUser(userId: string): Promise<number> {
        return this.repository.count({ where: { userId, status: 'pending' } });
    }
}
