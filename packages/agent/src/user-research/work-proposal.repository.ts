import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
    IdeaFailureKind,
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

    /**
     * Mark a proposal accepted (transition to ACCEPTED + record the
     * `acceptedWorkId`), optionally limiting which source statuses
     * the transition is valid from.
     *
     * Phase 1 PR B extends the original PENDING-only contract: the
     * Goal-completion handler (Phase 1 PR FF) calls this with
     * `fromStatuses = [BUILDING]` because by the time a Goal
     * completes successfully the originating Idea is in BUILDING,
     * not PENDING. The existing user-facing
     * `POST /me/work-proposals/:id/accept` controller keeps calling
     * with the default `[PENDING]` — back-compat preserved.
     */
    async markAccepted(
        id: string,
        userId: string,
        workId: string,
        fromStatuses: WorkProposalStatus[] = [WorkProposalStatus.PENDING],
    ): Promise<boolean> {
        const res = await this.repository.update(
            { id, userId, status: In(fromStatuses) },
            { status: WorkProposalStatus.ACCEPTED, acceptedWorkId: workId },
        );
        return (res.affected ?? 0) > 0;
    }

    /**
     * Transition a proposal to `QUEUED` (Phase 1 PR B build-from-Idea
     * flow). Valid only from `PENDING` or `FAILED` (a stuck BUILDING
     * Idea needs the goal-completion or retry path, not re-queueing
     * via this method). Clears `failureMessage` + `failureKind` so a
     * post-retry build doesn't carry stale failure data.
     */
    async markQueuedForBuild(id: string, userId: string): Promise<boolean> {
        const res = await this.repository.update(
            {
                id,
                userId,
                status: In([WorkProposalStatus.PENDING, WorkProposalStatus.FAILED]),
            },
            {
                status: WorkProposalStatus.QUEUED,
                failureMessage: null,
                failureKind: null,
            },
        );
        return (res.affected ?? 0) > 0;
    }

    /**
     * Create a single user-typed Idea (`source = USER_MANUAL`,
     * Phase 1 PR B `POST /me/work-proposals`). Auto-fills empty
     * arrays for the structured-suggestion fields the AI-generated
     * proposals normally carry — the user-manual Idea relies on the
     * description alone, and the build pipeline (PR FF / Phase 7)
     * can enrich during generation.
     */
    async createUserManual(input: {
        userId: string;
        title: string;
        description: string;
        slugSuggestion: string;
    }): Promise<WorkProposal> {
        return this.repository.save(
            this.repository.create({
                userId: input.userId,
                title: input.title,
                description: input.description,
                slugSuggestion: input.slugSuggestion,
                suggestedCategories: [],
                suggestedFields: [],
                recommendedPlugins: [],
                generatedPrompt: input.description,
                reasoning: 'Manually entered by user via +Add (spec §3.4).',
                source: WorkProposalSource.USER_MANUAL,
                status: WorkProposalStatus.PENDING,
            }),
        );
    }

    async countPendingByUser(userId: string): Promise<number> {
        return this.repository.count({
            where: { userId, status: WorkProposalStatus.PENDING },
        });
    }

    /**
     * Transition Idea to BUILDING. Caller: the goal-execution path
     * (when a queued Goal actually starts running). Valid from
     * QUEUED or BUILDING (the latter for the auto-retry loop —
     * Decision A24, Idea stays BUILDING across retries instead of
     * flickering to FAILED and back). Returns true iff the row was
     * affected.
     */
    async markBuilding(id: string, userId: string): Promise<boolean> {
        const res = await this.repository.update(
            {
                id,
                userId,
                status: In([WorkProposalStatus.QUEUED, WorkProposalStatus.BUILDING]),
            },
            { status: WorkProposalStatus.BUILDING },
        );
        return (res.affected ?? 0) > 0;
    }

    /**
     * Transition Idea to FAILED. Caller: the goal-completion handler
     * on terminal failure (Phase 1 PR FF). Persists the
     * human-readable `message` and the platform-classified `kind` so
     * the Idea Card UI can render the inline error block (spec §3.9)
     * and the user can hit Retry to clear them.
     *
     * Allowed source statuses: BUILDING (normal terminal failure)
     * and QUEUED (failure during the queue → build transition).
     */
    async markFailed(
        id: string,
        userId: string,
        message: string,
        kind: IdeaFailureKind,
    ): Promise<boolean> {
        const res = await this.repository.update(
            {
                id,
                userId,
                status: In([WorkProposalStatus.BUILDING, WorkProposalStatus.QUEUED]),
            },
            {
                status: WorkProposalStatus.FAILED,
                failureMessage: message.slice(0, 5000),
                failureKind: kind,
            },
        );
        return (res.affected ?? 0) > 0;
    }

    /**
     * Transition Idea ACCEPTED → BUILDING for the Re-build path
     * (Phase 1 PR FF `POST /me/work-proposals/:id/rebuild`,
     * Decision A27). The Idea will return to ACCEPTED when the
     * new Goal completes, with `acceptedWorkId` re-pointed at the
     * new Work. Returns the freshly-loaded Idea on success, `null`
     * if the Idea isn't in ACCEPTED for this user.
     */
    async markRebuildingFromAccepted(id: string, userId: string): Promise<boolean> {
        const res = await this.repository.update(
            { id, userId, status: WorkProposalStatus.ACCEPTED },
            {
                status: WorkProposalStatus.BUILDING,
                failureMessage: null,
                failureKind: null,
            },
        );
        return (res.affected ?? 0) > 0;
    }
}
