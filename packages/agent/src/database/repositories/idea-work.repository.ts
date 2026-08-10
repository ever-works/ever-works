import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
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

    /**
     * Provenance summary for MANY Ideas in one query — what the Ideas
     * list needs to render "built / not built" per card without an
     * N+1. Ideas with no links are simply absent from the map; callers
     * treat a miss as `{ count: 0, latestWorkId: null }`.
     *
     * Folded in JS rather than via `DISTINCT ON` / a window function so
     * it stays dialect-agnostic. The row volume is bounded by the list
     * page size (≤101 Ideas) times a handful of links each.
     */
    async summarizeForIdeas(
        ideaIds: string[],
        userId: string,
    ): Promise<Map<string, { count: number; latestWorkId: string }>> {
        const summary = new Map<string, { count: number; latestWorkId: string }>();
        if (ideaIds.length === 0) return summary;

        const rows = await this.repository.find({
            where: { ideaId: In(ideaIds), userId },
            select: { ideaId: true, workId: true, createdAt: true },
            order: { createdAt: 'DESC' },
        });

        // Rows arrive newest-first, so the FIRST row seen per Idea is the
        // most recent link — later rows only bump the count.
        for (const row of rows) {
            const existing = summary.get(row.ideaId);
            if (existing) {
                existing.count += 1;
            } else {
                summary.set(row.ideaId, { count: 1, latestWorkId: row.workId });
            }
        }
        return summary;
    }
}
