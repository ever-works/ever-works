import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository, type SelectQueryBuilder } from 'typeorm';
import {
    SKILL_CARD_STATES,
    SKILL_CARD_STATES_NEEDING_ATTENTION,
    SKILL_REVIEW_STATE_PROPOSED,
    deriveSkillCardState,
    isSkillReadinessState,
    type SkillCardState,
    type SkillProvenance,
    type SkillReadinessDetail,
    type SkillReadinessFilter,
    type SkillReadinessState,
    type SkillShelfSort,
} from '@ever-works/contracts';
import { Skill, type SkillOwnerType } from '../../entities/skill.entity';
import { SkillTag } from '../../entities/skill-tag.entity';
import { buildCaseInsensitiveLikeClause, prepareCaseInsensitiveContainsPattern } from '../utils';

export interface ListSkillsFilter {
    ownerType?: SkillOwnerType;
    ownerId?: string;
    search?: string;
    limit?: number;
    offset?: number;
    // -- Skills shelf (all optional; omitted = exactly the pre-shelf query) --
    /** Skills carrying ALL of these normalised tags (AND). */
    tags?: string[];
    /**
     * A card state (`unknown` included), or `attention` for the states in
     * `SKILL_CARD_STATES_NEEDING_ATTENTION` — never `ready`, never `unknown`.
     */
    readiness?: SkillReadinessFilter;
    /** Where the Skill came from; resolved against `provenanceSources`. */
    provenance?: SkillProvenance;
    /** `true` = switched on, `false` = switched off. */
    enabled?: boolean;
    /** Default `updated` (newest first). */
    sort?: SkillShelfSort;
    /** Required to resolve a `provenance` filter; ignored otherwise. */
    provenanceSources?: SkillProvenanceSources;
}

/**
 * The catalogue provider ids provenance is derived from. Resolved by the
 * caller from the plugin registry (never hard-coded here): `firstParty` is
 * whichever skills-provider plugin declares itself the capability default,
 * `package` is the Agent Plugins package source.
 */
export interface SkillProvenanceSources {
    firstPartyProviderIds: readonly string[];
    packageProviderIds: readonly string[];
}

/** Per-card-state counts for the shelf summary line. */
export type SkillCardStateCounts = Record<SkillCardState, number>;

const NOT_IN_REVIEW = `(skill.reviewState IS NULL OR skill.reviewState <> '${SKILL_REVIEW_STATE_PROPOSED}')`;

/**
 * The SQL twin of `skillCardStateNeedsAttention`: switched on, and either in
 * review or carrying a stored verdict that is a real problem. A switched-off
 * Skill never matches — its card state is `disabled` whatever its verdict, and
 * the owner chose that. `ready` and `unknown` ("Not checked yet") are not in
 * the list, and neither is an unrecognised stored value — which
 * `deriveSkillCardState` also reads as `unknown`. Built from the shared
 * contracts list (constants, never input), so the filter, the sort and the
 * web summary cannot disagree about what needs a person.
 */
const PROBLEM_READINESS_SQL = SKILL_CARD_STATES_NEEDING_ATTENTION.filter((state) =>
    isSkillReadinessState(state),
)
    .map((state) => `'${state}'`)
    .join(', ');
const NEEDS_ATTENTION = `(skill.disabledAt IS NULL AND (skill.reviewState = '${SKILL_REVIEW_STATE_PROPOSED}' OR skill.readiness IN (${PROBLEM_READINESS_SQL})))`;

/**
 * Skills feature — Phase 8.4 (`features/skills/plan.md §2`).
 *
 * Custom repository for `skills`. Owns CRUD + slug uniqueness +
 * scope-aware lookups. Cross-user reads route through
 * `findByIdAndUser` so the service can 404 instead of leaking
 * existence.
 */
@Injectable()
export class SkillRepository {
    constructor(
        @InjectRepository(Skill)
        private readonly repository: Repository<Skill>,
    ) {}

    async findById(id: string): Promise<Skill | null> {
        return this.repository.findOne({ where: { id } });
    }

    async findByIdAndUser(id: string, userId: string): Promise<Skill | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    async findByOwnerSlug(
        ownerType: SkillOwnerType,
        ownerId: string,
        slug: string,
    ): Promise<Skill | null> {
        return this.repository.findOne({ where: { ownerType, ownerId, slug } });
    }

    async findByUserIdFiltered(
        userId: string,
        filter: ListSkillsFilter = {},
    ): Promise<{ rows: Skill[]; total: number }> {
        const qb = this.repository
            .createQueryBuilder('skill')
            .where('skill.userId = :userId', { userId });

        if (filter.ownerType)
            qb.andWhere('skill.ownerType = :ownerType', { ownerType: filter.ownerType });
        if (filter.ownerId) qb.andWhere('skill.ownerId = :ownerId', { ownerId: filter.ownerId });
        if (filter.search) {
            // Escape LIKE metacharacters (%, _, \) in the user-supplied search
            // term so they're matched literally rather than acting as wildcards.
            // Mirrors work.repository.ts / activity-log.repository.ts: prevents
            // filter-bypass (e.g. `search=%`) and the index-defeating full scans
            // that an unescaped `%...%` pattern would otherwise allow.
            const searchPattern = prepareCaseInsensitiveContainsPattern(filter.search);
            if (searchPattern) {
                qb.andWhere(
                    new Brackets((searchQb) => {
                        searchQb
                            .where(buildCaseInsensitiveLikeClause('skill.title'), {
                                search: searchPattern,
                            })
                            .orWhere(buildCaseInsensitiveLikeClause('skill.slug'), {
                                search: searchPattern,
                            })
                            .orWhere(buildCaseInsensitiveLikeClause('skill.description'), {
                                search: searchPattern,
                            })
                            // Skills shelf: search also matches a tag. A
                            // correlated EXISTS, so a Skill with several
                            // matching tags still counts once.
                            .orWhere(
                                `EXISTS (SELECT 1 FROM skill_tags search_tag WHERE search_tag."skillId" = skill.id AND search_tag."userId" = skill.userId AND ${buildCaseInsensitiveLikeClause('search_tag.tag')})`,
                                { search: searchPattern },
                            );
                    }),
                );
            }
        }

        this.applyShelfFilters(qb, userId, filter);

        const total = await qb.getCount();
        this.applyShelfSort(qb, filter.sort);
        qb.take(filter.limit ?? 50).skip(filter.offset ?? 0);
        const rows = await qb.getMany();
        return { rows, total };
    }

    /**
     * Skills shelf: how many of the user's Skills sit in each card state, for
     * the "{n} of {total} Skills need you" line. `unknown` ("Not checked yet")
     * is its own bucket; the "need you" number is `countSkillsNeedingAttention`
     * over these counts, which leaves it (and `ready`) out — the same set the
     * `attention` filter selects. Honours the owner filters but
     * deliberately NOT search / tags / readiness / enabled: the summary
     * describes the whole shelf, so it does not jump while a person narrows
     * the grid.
     */
    async countsByCardState(
        userId: string,
        filter: Pick<ListSkillsFilter, 'ownerType' | 'ownerId'> = {},
    ): Promise<SkillCardStateCounts> {
        const disabledExpr = 'CASE WHEN skill.disabledAt IS NULL THEN 0 ELSE 1 END';
        const qb = this.repository
            .createQueryBuilder('skill')
            .select('skill.readiness', 'readiness')
            .addSelect(disabledExpr, 'disabled')
            .addSelect('skill.reviewState', 'reviewState')
            .addSelect('COUNT(*)', 'n')
            .where('skill.userId = :userId', { userId });
        if (filter.ownerType)
            qb.andWhere('skill.ownerType = :ownerType', { ownerType: filter.ownerType });
        if (filter.ownerId) qb.andWhere('skill.ownerId = :ownerId', { ownerId: filter.ownerId });
        qb.groupBy('skill.readiness').addGroupBy(disabledExpr).addGroupBy('skill.reviewState');

        const counts = Object.fromEntries(
            SKILL_CARD_STATES.map((state) => [state, 0]),
        ) as SkillCardStateCounts;
        const rows = await qb.getRawMany<{
            readiness: string;
            disabled: string | number;
            reviewState: string | null;
            n: string | number;
        }>();
        for (const row of rows) {
            const state = deriveSkillCardState({
                readiness: row.readiness,
                disabledAt: Number(row.disabled) === 1 ? 'disabled' : null,
                reviewState: row.reviewState,
            });
            counts[state] += Number(row.n);
        }
        return counts;
    }

    /**
     * Skills shelf: persist a readiness verdict. Ownership-scoped, and touches
     * ONLY the three readiness columns (never `updatedAt`, so a background
     * re-check does not reorder the "recently updated" shelf). Returns false
     * when no row was written, i.e. the Skill is gone.
     */
    async recordReadiness(
        id: string,
        userId: string,
        verdict: {
            readiness: SkillReadinessState;
            readinessDetail: SkillReadinessDetail | null;
            readinessCheckedAt: Date;
        },
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(Skill)
            .set({
                readiness: verdict.readiness,
                readinessDetail: verdict.readinessDetail,
                readinessCheckedAt: verdict.readinessCheckedAt,
                // Keep the column as-is: TypeORM would otherwise stamp the
                // update-date column on every query-builder update.
                updatedAt: () => '"updatedAt"',
            })
            .where('id = :id', { id })
            .andWhere('userId = :userId', { userId })
            .updateEntity(false)
            .execute();
        return result.affected === undefined ? true : result.affected > 0;
    }

    /**
     * Skills shelf: the sweep's work list. Skills whose verdict was never
     * computed or is older than `staleBefore`, oldest first, at most `limit`
     * rows and at most `perUser` rows per user so one large workspace cannot
     * starve the rest of a tick.
     */
    async findStaleForReadiness(
        staleBefore: Date,
        limit: number,
        perUser: number,
    ): Promise<Skill[]> {
        // Two ordered passes (never-checked first, then oldest checked) so the
        // ordering is portable without NULLS FIRST; the per-user cap is applied
        // in code, portable across Postgres and SQLite without a window
        // function. Over-fetch so a capped user does not shrink the batch.
        const fetch = limit * 4;
        const neverChecked = await this.repository
            .createQueryBuilder('skill')
            .where('skill.readinessCheckedAt IS NULL')
            .orderBy('skill.createdAt', 'ASC')
            .take(fetch)
            .getMany();
        const stale =
            neverChecked.length >= fetch
                ? []
                : await this.repository
                      .createQueryBuilder('skill')
                      .where('skill.readinessCheckedAt < :staleBefore', { staleBefore })
                      .orderBy('skill.readinessCheckedAt', 'ASC')
                      .take(fetch - neverChecked.length)
                      .getMany();
        const perUserCount = new Map<string, number>();
        const out: Skill[] = [];
        for (const skill of [...neverChecked, ...stale]) {
            const seen = perUserCount.get(skill.userId) ?? 0;
            if (seen >= perUser) continue;
            perUserCount.set(skill.userId, seen + 1);
            out.push(skill);
            if (out.length >= limit) break;
        }
        return out;
    }

    private applyShelfFilters(
        qb: SelectQueryBuilder<Skill>,
        userId: string,
        filter: ListSkillsFilter,
    ): void {
        const tags = Array.from(new Set((filter.tags ?? []).filter((tag) => tag.length > 0)));
        if (tags.length > 0) {
            // AND semantics: the Skill must carry every selected tag.
            qb.andWhere(
                `skill.id IN (SELECT filter_tag."skillId" FROM skill_tags filter_tag WHERE filter_tag."userId" = :tagUserId AND filter_tag.tag IN (:...filterTags) GROUP BY filter_tag."skillId" HAVING COUNT(DISTINCT filter_tag.tag) = :filterTagCount)`,
                { tagUserId: userId, filterTags: tags, filterTagCount: tags.length },
            );
        }

        if (filter.enabled === true) qb.andWhere('skill.disabledAt IS NULL');
        if (filter.enabled === false) qb.andWhere('skill.disabledAt IS NOT NULL');

        if (filter.readiness) {
            if (filter.readiness === 'disabled') {
                qb.andWhere('skill.disabledAt IS NOT NULL');
            } else if (filter.readiness === 'needs_review') {
                qb.andWhere('skill.disabledAt IS NULL').andWhere(
                    `skill.reviewState = '${SKILL_REVIEW_STATE_PROPOSED}'`,
                );
            } else if (filter.readiness === 'attention') {
                qb.andWhere(NEEDS_ATTENTION);
            } else {
                qb.andWhere('skill.disabledAt IS NULL')
                    .andWhere(NOT_IN_REVIEW)
                    .andWhere('skill.readiness = :readinessFilter', {
                        readinessFilter: filter.readiness,
                    });
            }
        }

        if (filter.provenance) {
            const firstParty = [...(filter.provenanceSources?.firstPartyProviderIds ?? [])];
            const packages = [...(filter.provenanceSources?.packageProviderIds ?? [])];
            if (filter.provenance === 'authored') {
                qb.andWhere('skill.sourceCatalogSlug IS NULL');
            } else if (filter.provenance === 'firstParty') {
                qb.andWhere('skill.sourceCatalogSlug IS NOT NULL');
                if (firstParty.length === 0) qb.andWhere('1 = 0');
                else
                    qb.andWhere('skill.sourcePath IN (:...firstPartyIds)', {
                        firstPartyIds: firstParty,
                    });
            } else if (filter.provenance === 'package') {
                qb.andWhere('skill.sourceCatalogSlug IS NOT NULL');
                if (packages.length === 0) qb.andWhere('1 = 0');
                else qb.andWhere('skill.sourcePath IN (:...packageIds)', { packageIds: packages });
            } else {
                qb.andWhere('skill.sourceCatalogSlug IS NOT NULL');
                const known = [...firstParty, ...packages];
                if (known.length > 0) {
                    qb.andWhere(
                        new Brackets((inner) => {
                            inner
                                .where('skill.sourcePath IS NULL')
                                .orWhere('skill.sourcePath NOT IN (:...knownProviderIds)', {
                                    knownProviderIds: known,
                                });
                        }),
                    );
                }
            }
        }
    }

    private applyShelfSort(qb: SelectQueryBuilder<Skill>, sort: SkillShelfSort | undefined): void {
        if (sort === 'name') {
            qb.orderBy('LOWER(skill.title)', 'ASC').addOrderBy('skill.updatedAt', 'DESC');
            return;
        }
        if (sort === 'attention') {
            qb.orderBy(`CASE WHEN ${NEEDS_ATTENTION} THEN 0 ELSE 1 END`, 'ASC').addOrderBy(
                'skill.updatedAt',
                'DESC',
            );
            return;
        }
        qb.orderBy('skill.updatedAt', 'DESC');
    }

    /** The user's skill carrying this invocation slug, else null. */
    async findByUserAndInvocationSlug(
        userId: string,
        invocationSlug: string,
    ): Promise<Skill | null> {
        return this.repository.findOne({ where: { userId, invocationSlug } });
    }

    /** All of the user's skills that carry an invocation slug (composer autocomplete). */
    async findInvocableByUser(userId: string): Promise<Skill[]> {
        return this.repository
            .createQueryBuilder('skill')
            .where('skill.userId = :userId', { userId })
            .andWhere('skill.invocationSlug IS NOT NULL')
            .orderBy('skill.invocationSlug', 'ASC')
            .getMany();
    }

    async findManyByIds(userId: string, ids: string[]): Promise<Skill[]> {
        if (ids.length === 0) return [];
        return this.repository
            .createQueryBuilder('skill')
            .where('skill.userId = :userId', { userId })
            .andWhere('skill.id IN (:...ids)', { ids })
            .getMany();
    }

    async create(data: Partial<Skill>): Promise<Skill> {
        const entity = this.repository.create(data);
        return this.repository.save(entity);
    }

    async updateById(id: string, data: Partial<Skill>): Promise<void> {
        await this.repository.update(id, data);
    }

    // Security: ownership-scoped update. Prefer this over `updateById` so the
    // `userId` is enforced in the WHERE clause regardless of caller — a
    // miscounted/omitted service-layer guard then cannot overwrite another
    // user's skill body (cross-user IDOR), e.g. injecting malicious
    // `instructionsMd` that later reaches LLM prompts via `resolveActive`.
    // Additive + defense-in-depth: `updateById` is retained, and this mirrors
    // `skill-binding.repository.ts`'s `deleteByIdAndUser`.
    async updateByIdAndUser(id: string, userId: string, data: Partial<Skill>): Promise<void> {
        await this.repository.update({ id, userId }, data);
    }

    async deleteById(id: string): Promise<void> {
        await this.repository.delete(id);
    }

    // Security: ownership-scoped delete. Prefer this over `deleteById` so the
    // `userId` is enforced in the WHERE clause regardless of caller — a
    // miscounted/omitted service-layer guard then cannot delete another user's
    // skill (cross-user IDOR). Additive: `deleteById` is retained.
    async deleteByIdAndUser(id: string, userId: string): Promise<void> {
        await this.repository.delete({ id, userId });
    }
}
