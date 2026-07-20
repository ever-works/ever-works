import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IdeaWork, type IdeaWorkKind } from '../../entities/idea-work.entity';

/**
 * One Idea↔Work provenance link row hydrated with the linked Work's
 * display fields (for the Idea detail "Linked Works" panel — review
 * §23.1). `workName`/`workSlug` are null when the Work row is gone
 * mid-query (CASCADE races); callers render the bare id then.
 */
export interface IdeaWorkWithWork {
    id: string;
    ideaId: string;
    workId: string;
    kind: IdeaWorkKind;
    createdAt: Date;
    workName: string | null;
    workSlug: string | null;
}

/**
 * Repository for the `idea_works` provenance table — the authoritative
 * 0..N Idea→Work relation (domain-model review §23.1 / ADR-009).
 * Append-only: links are recorded, never updated; uniqueness on
 * (ideaId, workId) makes re-recording a no-op.
 */
@Injectable()
export class IdeaWorkRepository {
    constructor(
        @InjectRepository(IdeaWork)
        private readonly repository: Repository<IdeaWork>,
    ) {}

    /**
     * Record a link, ignoring duplicates (`ON CONFLICT DO NOTHING` /
     * `INSERT OR IGNORE` via TypeORM's `orIgnore`, so the same call is
     * safe from both the user-accept and goal-completion paths).
     * Kind is first-writer-wins by design — a re-accept of an already
     * `built` pair must not downgrade it to `linked`.
     */
    async recordLink(input: {
        ideaId: string;
        workId: string;
        userId: string;
        kind: IdeaWorkKind;
    }): Promise<void> {
        await this.repository
            .createQueryBuilder()
            .insert()
            .into(IdeaWork)
            .values({
                ideaId: input.ideaId,
                workId: input.workId,
                userId: input.userId,
                kind: input.kind,
            })
            .orIgnore()
            .execute();
    }

    /** Links for one Idea (owner-scoped), newest first, with Work display fields. */
    async listForIdeaWithWork(ideaId: string, userId: string): Promise<IdeaWorkWithWork[]> {
        const rows = await this.repository
            .createQueryBuilder('link')
            .leftJoin('link.work', 'work')
            .select([
                'link.id AS "id"',
                'link.ideaId AS "ideaId"',
                'link.workId AS "workId"',
                'link.kind AS "kind"',
                'link.createdAt AS "createdAt"',
                'work.name AS "workName"',
                'work.slug AS "workSlug"',
            ])
            .where('link.ideaId = :ideaId AND link.userId = :userId', { ideaId, userId })
            .orderBy('link.createdAt', 'DESC')
            .getRawMany<IdeaWorkWithWork>();
        return rows;
    }

    /** Reverse lookup — which Ideas produced/linked this Work (owner-scoped). */
    async listForWork(workId: string, userId: string): Promise<IdeaWork[]> {
        return this.repository.find({
            where: { workId, userId },
            order: { createdAt: 'DESC' },
        });
    }

    async countForIdea(ideaId: string, userId: string): Promise<number> {
        return this.repository.count({ where: { ideaId, userId } });
    }
}
