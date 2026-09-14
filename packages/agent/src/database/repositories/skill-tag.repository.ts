import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { SKILL_TAG_FACET_LIMIT } from '@ever-works/contracts';
import { SkillTag } from '../../entities/skill-tag.entity';

export interface SkillTagFacet {
    tag: string;
    count: number;
}

export interface SkillTagScope {
    tenantId?: string | null;
    organizationId?: string | null;
}

/**
 * Skills shelf — data surface for `skill_tags`, the queryable copy of each
 * Skill's `frontmatter.tags`.
 *
 * Every read is scoped by `userId` in the WHERE clause, the same posture as
 * `SkillRepository`: a tag facet or lookup can never reveal another user's
 * Skills. Writes only ever come from `SkillsService` re-deriving a Skill's
 * tags from its definition — there is deliberately no "add one tag" method.
 */
@Injectable()
export class SkillTagRepository {
    constructor(
        @InjectRepository(SkillTag)
        private readonly repository: Repository<SkillTag>,
    ) {}

    /**
     * Replace a Skill's tag rows with exactly `tags` (already normalised).
     * Delete-then-insert inside one transaction, so a reader never sees a
     * half-written set.
     */
    async replaceForSkill(
        skillId: string,
        userId: string,
        tags: readonly string[],
        scope: SkillTagScope = {},
    ): Promise<void> {
        await this.repository.manager.transaction(async (manager) => {
            const repo = manager.getRepository(SkillTag);
            await repo.delete({ skillId, userId });
            if (tags.length === 0) return;
            await repo.insert(
                tags.map((tag) => ({
                    skillId,
                    userId,
                    tag,
                    tenantId: scope.tenantId ?? null,
                    organizationId: scope.organizationId ?? null,
                })),
            );
        });
    }

    /** Tags per Skill for one page of the shelf, in one query. Tags sort alphabetically. */
    async findBySkillIds(
        skillIds: readonly string[],
        userId: string,
    ): Promise<Map<string, string[]>> {
        const out = new Map<string, string[]>();
        if (skillIds.length === 0) return out;
        const rows = await this.repository.find({
            where: { userId, skillId: In([...skillIds]) },
            order: { tag: 'ASC' },
        });
        for (const row of rows) {
            const list = out.get(row.skillId) ?? [];
            list.push(row.tag);
            out.set(row.skillId, list);
        }
        return out;
    }

    /**
     * The tag chip row: distinct tags across the user's Skills with how many
     * Skills carry each, most-used first then alphabetical, capped at
     * `limit` (≤ 200). `total` is the number of distinct tags before the cap.
     */
    async facets(
        userId: string,
        limit: number = SKILL_TAG_FACET_LIMIT,
    ): Promise<{ tags: SkillTagFacet[]; total: number }> {
        const capped = Math.max(1, Math.min(limit, SKILL_TAG_FACET_LIMIT));
        const rows = await this.repository
            .createQueryBuilder('st')
            .select('st.tag', 'tag')
            .addSelect('COUNT(DISTINCT st.skillId)', 'count')
            .where('st.userId = :userId', { userId })
            .groupBy('st.tag')
            .orderBy('count', 'DESC')
            .addOrderBy('st.tag', 'ASC')
            .limit(capped)
            .getRawMany<{ tag: string; count: string | number }>();

        const totalRow = await this.repository
            .createQueryBuilder('st')
            .select('COUNT(DISTINCT st.tag)', 'total')
            .where('st.userId = :userId', { userId })
            .getRawOne<{ total: string | number }>();

        return {
            tags: rows.map((row) => ({ tag: row.tag, count: Number(row.count) })),
            total: Number(totalRow?.total ?? 0),
        };
    }
}
