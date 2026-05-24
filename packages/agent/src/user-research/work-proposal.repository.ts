import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    WorkProposal,
    WorkProposalSource,
    WorkProposalStatus,
    type WorkProposalCategory,
    type WorkProposalField,
    type WorkProposalRecommendedPlugin,
} from '../entities/work-proposal.entity';

export interface CreateWorkProposalInput {
    userId: string;
    title: string;
    description: string;
    slugSuggestion: string;
    suggestedCategories: WorkProposalCategory[];
    suggestedFields: WorkProposalField[];
    recommendedPlugins: WorkProposalRecommendedPlugin[];
    generatedPrompt: string;
    reasoning: string;
    source: WorkProposalSource;
    generationRunId?: string;
    /**
     * Optional FK to the spawning Mission (Phase 0 PR 0.1).
     * Set by the Mission tick worker (Phase 3 PR J) when creating
     * Ideas with `source = MISSION`. NULL for all other sources.
     */
    missionId?: string | null;
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
            this.repository.create({ ...i, status: WorkProposalStatus.PENDING }),
        );
        return this.repository.save(entities);
    }

    async findByUser(
        userId: string,
        statuses: WorkProposalStatus[] = [WorkProposalStatus.PENDING],
        opts: { missionId?: string | null } = {},
    ): Promise<WorkProposal[]> {
        const qb = this.repository
            .createQueryBuilder('p')
            .where('p.userId = :userId', { userId })
            .andWhere('p.status IN (:...statuses)', { statuses });

        // `missionId` filter supports three modes:
        //   - undefined / not passed → no filter (return all Ideas across all
        //     Missions + standalone Ideas with NULL missionId).
        //   - a string UUID → return Ideas tied to that specific Mission.
        //   - `null` explicitly → return only standalone (non-Mission) Ideas
        //     (`missionId IS NULL`).
        if (opts.missionId === null) {
            qb.andWhere('p.missionId IS NULL');
        } else if (typeof opts.missionId === 'string') {
            qb.andWhere('p.missionId = :missionId', { missionId: opts.missionId });
        }

        return qb.orderBy('p.generatedAt', 'DESC').getMany();
    }

    async findRecentByUser(userId: string, take = 50): Promise<WorkProposal[]> {
        return this.repository.find({
            where: { userId },
            order: { generatedAt: 'DESC' },
            take,
        });
    }

    async findById(id: string): Promise<WorkProposal | null> {
        return this.repository.findOne({ where: { id } });
    }

    async findByIdForUser(id: string, userId: string): Promise<WorkProposal | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    async markDismissed(id: string, userId: string): Promise<boolean> {
        const res = await this.repository.update(
            { id, userId, status: WorkProposalStatus.PENDING },
            { status: WorkProposalStatus.DISMISSED },
        );
        return (res.affected ?? 0) > 0;
    }

    async markAccepted(id: string, userId: string, workId: string): Promise<boolean> {
        const res = await this.repository.update(
            { id, userId, status: WorkProposalStatus.PENDING },
            { status: WorkProposalStatus.ACCEPTED, acceptedWorkId: workId },
        );
        return (res.affected ?? 0) > 0;
    }

    async countPendingByUser(userId: string): Promise<number> {
        return this.repository.count({
            where: { userId, status: WorkProposalStatus.PENDING },
        });
    }
}
