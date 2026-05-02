import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, IsNull, Brackets, Raw, LessThanOrEqual, In } from 'typeorm';
import { Work } from '../../entities/work.entity';
import { User } from '../../entities';
import { buildCaseInsensitiveLikeClause, prepareCaseInsensitiveContainsPattern } from '../utils';

/**
 * Cross-database case-insensitive LIKE using LOWER() function.
 * Works with SQLite, PostgreSQL, and MySQL.
 */
function caseInsensitiveLike(search: string) {
    return Raw((alias) => buildCaseInsensitiveLikeClause(alias), { search });
}

@Injectable()
export class WorkRepository {
    constructor(
        @InjectRepository(Work)
        private readonly repository: Repository<Work>,
    ) {}

    async create(dto: Partial<Work>, user: User): Promise<Work> {
        let exists = await this.findByOwnerAndSlug({
            userId: user.id,
            owner: dto.owner,
            slug: dto.slug,
        });

        if (exists) {
            throw new Error('Work already exists');
        }

        let work = this.repository.create(dto);
        work = await this.repository.save(work);

        return this.findById(work.id);
    }

    async createOrUpdate(dto: Partial<Work>, user: User): Promise<Work> {
        let exists = await this.findByOwnerAndSlug({
            userId: user.id,
            owner: dto.owner,
            slug: dto.slug,
        });

        let work: Work;
        if (exists && exists.userId === user.id) {
            work = await this.update(exists.id, dto);
        } else {
            work = this.repository.create(dto);
        }

        work = await this.repository.save(work);
        return this.findById(work.id);
    }

    async findByOwnerAndSlug({
        userId,
        owner,
        slug,
    }: {
        userId: string;
        owner: string;
        slug: string;
    }): Promise<Work | null> {
        return this.repository.findOne({
            where: owner ? { userId, owner, slug } : { userId, slug },
            relations: ['user'],
        });
    }

    async findById(id: string): Promise<Work | null> {
        return this.repository.findOne({
            where: { id },
            relations: ['user'],
        });
    }

    async findByIds(ids: string[]): Promise<Work[]> {
        const uniqueIds = [...new Set(ids.filter(Boolean))];

        if (uniqueIds.length === 0) {
            return [];
        }

        return this.repository.find({
            where: { id: In(uniqueIds) },
            relations: ['user'],
        });
    }

    private buildWhereConditions(options?: { userId?: string; search?: string }): any {
        const { userId, search } = options || {};

        let whereConditions: any = [];

        if (search) {
            const searchPattern = prepareCaseInsensitiveContainsPattern(search);

            if (searchPattern) {
                // Create OR conditions for search using cross-database case-insensitive LIKE
                const searchConditions = [
                    { name: caseInsensitiveLike(searchPattern) },
                    { description: caseInsensitiveLike(searchPattern) },
                    { slug: caseInsensitiveLike(searchPattern) },
                ];

                // If userId is specified, add it to each search condition
                if (userId) {
                    whereConditions = searchConditions.map((cond) => ({ ...cond, userId }));
                } else {
                    whereConditions = searchConditions;
                }
            } else if (userId) {
                whereConditions = { userId };
            }
        } else if (userId) {
            whereConditions = { userId };
        }

        let hasWhereCondition = false;

        if (whereConditions) {
            if (Array.isArray(whereConditions)) {
                hasWhereCondition = whereConditions.length > 0;
            } else {
                hasWhereCondition = Object.keys(whereConditions).length > 0;
            }
        }

        return { whereConditions, hasWhereCondition };
    }

    async findAll(options?: {
        userId?: string;
        limit?: number;
        offset?: number;
        search?: string;
    }): Promise<Work[]> {
        const { limit, offset } = options || {};

        const { whereConditions, hasWhereCondition } = this.buildWhereConditions(options);

        const findOptions: any = {
            order: { id: 'DESC' },
            relations: ['user'],
        };

        if (hasWhereCondition) {
            findOptions.where = whereConditions;
        }

        if (limit) {
            findOptions.take = limit;
        }

        if (offset) {
            findOptions.skip = offset;
        }

        return this.repository.find(findOptions);
    }

    async countAll(options?: { userId?: string; search?: string }): Promise<number> {
        const { whereConditions, hasWhereCondition } = this.buildWhereConditions(options);

        const countOptions: any = {};

        if (hasWhereCondition) {
            countOptions.where = whereConditions;
        }

        return await this.repository.count(countOptions);
    }

    async update(id: string, updateData: Partial<Work>): Promise<Work | null> {
        await this.repository.update(id, updateData);
        return await this.findById(id);
    }

    async increment(id: string, column: keyof Work, value: number): Promise<void> {
        await this.repository.increment({ id }, column as string, value);
    }

    async delete(id: string): Promise<boolean> {
        const result = await this.repository.delete(id);
        return result.affected > 0;
    }

    async deleteBySlug(slug: string, userId: string): Promise<boolean> {
        const result = await this.repository.delete({ slug, userId });
        return result.affected > 0;
    }

    async exists(slug: string, userId: string): Promise<boolean> {
        const count = await this.repository.count({ where: { slug, userId } });
        return count > 0;
    }

    async existsByUserAndSlug(userId: string, slug: string): Promise<boolean> {
        const count = await this.repository.count({ where: { userId, slug } });
        return count > 0;
    }

    async findByUser(userId: string): Promise<Work[]> {
        return await this.repository.find({ where: { userId } });
    }

    async updateLastPullRequest(
        id: string,
        lastPullRequest: Work['lastPullRequest'],
    ): Promise<void> {
        const work = await this.findById(id);

        await this.repository.update(id, {
            lastPullRequest: {
                ...work.lastPullRequest,
                ...lastPullRequest,
            },
        });
    }

    async updateGenerateStatus(id: string, generateStatus: Work['generateStatus']): Promise<void> {
        if (generateStatus?.warnings?.length) {
            generateStatus = { ...generateStatus, warnings: [...new Set(generateStatus.warnings)] };
        }
        await this.repository.update(id, { generateStatus, generationProgressedAt: new Date() });
    }

    async recordGenerationStartTime(id: string, startedAt: Date): Promise<void> {
        await this.repository.update(id, {
            generationStartedAt: startedAt,
            generationProgressedAt: startedAt,
            generationFinishedAt: null,
        });
    }

    async recordGenerationFinishTime(id: string, finishedAt: Date): Promise<void> {
        await this.repository.update(id, {
            generationFinishedAt: finishedAt,
        });
    }

    async getUnfinishedGenerations(olderThan: Date): Promise<Work[]> {
        const stalledWorks = await this.repository.find({
            where: {
                generationProgressedAt: LessThan(olderThan),
                generationFinishedAt: IsNull(),
            },
        });

        return stalledWorks;
    }

    /**
     * Find all works accessible to a user (as creator OR as member).
     * This combines owned works with those the user has been invited to.
     */
    async findAllAccessible(options?: {
        userId: string;
        memberWorkIds?: string[];
        limit?: number;
        offset?: number;
        search?: string;
    }): Promise<Work[]> {
        const { userId, memberWorkIds = [], limit, offset, search } = options || {};

        if (!userId) {
            return [];
        }

        const queryBuilder = this.repository
            .createQueryBuilder('work')
            .leftJoinAndSelect('work.user', 'user');

        // User has access if they are the creator OR they have a membership
        if (memberWorkIds.length > 0) {
            queryBuilder.where(
                new Brackets((qb) => {
                    qb.where('work.userId = :userId', { userId }).orWhere(
                        'work.id IN (:...memberWorkIds)',
                        { memberWorkIds },
                    );
                }),
            );
        } else {
            queryBuilder.where('work.userId = :userId', { userId });
        }

        // Apply search filter using cross-database case-insensitive LIKE
        if (search) {
            const searchPattern = prepareCaseInsensitiveContainsPattern(search);
            if (searchPattern) {
                queryBuilder.andWhere(
                    new Brackets((qb) => {
                        qb.where(buildCaseInsensitiveLikeClause('work.name'), {
                            search: searchPattern,
                        })
                            .orWhere(buildCaseInsensitiveLikeClause('work.description'), {
                                search: searchPattern,
                            })
                            .orWhere(buildCaseInsensitiveLikeClause('work.slug'), {
                                search: searchPattern,
                            });
                    }),
                );
            }
        }

        queryBuilder.orderBy('work.updatedAt', 'DESC');

        if (limit) {
            queryBuilder.take(limit);
        }

        if (offset) {
            queryBuilder.skip(offset);
        }

        return queryBuilder.getMany();
    }

    /**
     * Count all works accessible to a user (as creator OR as member).
     */
    async countAllAccessible(options?: {
        userId: string;
        memberWorkIds?: string[];
        search?: string;
    }): Promise<number> {
        const { userId, memberWorkIds = [], search } = options || {};

        if (!userId) {
            return 0;
        }

        const queryBuilder = this.repository.createQueryBuilder('work');

        // User has access if they are the creator OR they have a membership
        if (memberWorkIds.length > 0) {
            queryBuilder.where(
                new Brackets((qb) => {
                    qb.where('work.userId = :userId', { userId }).orWhere(
                        'work.id IN (:...memberWorkIds)',
                        { memberWorkIds },
                    );
                }),
            );
        } else {
            queryBuilder.where('work.userId = :userId', { userId });
        }

        // Apply search filter using cross-database case-insensitive LIKE
        if (search) {
            const searchPattern = prepareCaseInsensitiveContainsPattern(search);
            if (searchPattern) {
                queryBuilder.andWhere(
                    new Brackets((qb) => {
                        qb.where(buildCaseInsensitiveLikeClause('work.name'), {
                            search: searchPattern,
                        })
                            .orWhere(buildCaseInsensitiveLikeClause('work.description'), {
                                search: searchPattern,
                            })
                            .orWhere(buildCaseInsensitiveLikeClause('work.slug'), {
                                search: searchPattern,
                            });
                    }),
                );
            }
        }

        return queryBuilder.getCount();
    }

    /**
     * Get aggregated stats for all works accessible to a user.
     */
    async getAccessibleStats(options: { userId: string; memberWorkIds?: string[] }): Promise<{
        totalWorks: number;
        totalItems: number;
        activeWebsites: number;
        generatingCount: number;
    }> {
        const { userId, memberWorkIds = [] } = options;

        if (!userId) {
            return { totalWorks: 0, totalItems: 0, activeWebsites: 0, generatingCount: 0 };
        }

        const queryBuilder = this.repository.createQueryBuilder('work');

        if (memberWorkIds.length > 0) {
            queryBuilder.where(
                new Brackets((qb) => {
                    qb.where('work.userId = :userId', { userId }).orWhere(
                        'work.id IN (:...memberWorkIds)',
                        { memberWorkIds },
                    );
                }),
            );
        } else {
            queryBuilder.where('work.userId = :userId', { userId });
        }

        const result = await queryBuilder
            .select('COUNT(*)', 'totalWorks')
            .addSelect('COALESCE(SUM(work.itemsCount), 0)', 'totalItems')
            .addSelect(
                "COALESCE(SUM(CASE WHEN work.website IS NOT NULL AND work.website != '' THEN 1 ELSE 0 END), 0)",
                'activeWebsites',
            )
            .addSelect(
                // `generateStatus` is stored as TypeORM `simple-json`, so it is persisted as plain text
                // across the supported databases in this repo. Keep this query portable by matching the
                // serialized status field instead of using engine-specific JSON operators.
                `COALESCE(SUM(CASE WHEN work.generateStatus LIKE '%"status":"generating"%' THEN 1 ELSE 0 END), 0)`,
                'generatingCount',
            )
            .getRawOne();

        return {
            totalWorks: parseInt(result.totalWorks, 10) || 0,
            totalItems: parseInt(result.totalItems, 10) || 0,
            activeWebsites: parseInt(result.activeWebsites, 10) || 0,
            generatingCount: parseInt(result.generatingCount, 10) || 0,
        };
    }

    /**
     * Find a work by ID with members relation loaded.
     */
    async findByIdWithMembers(id: string): Promise<Work | null> {
        return this.repository.findOne({
            where: { id },
            relations: ['user', 'members', 'members.user'],
        });
    }

    /**
     * Find all works with website template auto-update enabled.
     */
    async findWithWebsiteAutoUpdateEnabled(): Promise<Work[]> {
        return this.repository.find({
            where: { websiteTemplateAutoUpdate: true },
            relations: ['user'],
        });
    }

    /**
     * Find all works with community PR processing enabled.
     */
    async findWithCommunityPrEnabled(): Promise<Work[]> {
        return this.repository.find({
            where: { communityPrEnabled: true },
            relations: ['user'],
        });
    }

    /**
     * Find all works with comparison generation enabled.
     */
    async findWithComparisonsEnabled(): Promise<Work[]> {
        return this.repository.find({
            where: { comparisonsEnabled: true },
            relations: ['user'],
        });
    }

    /**
     * Find all works with scheduled updates enabled for standalone source validation.
     */
    async findWithScheduledSourceValidationEnabled(): Promise<Work[]> {
        return this.repository.find({
            where: { scheduledUpdatesEnabled: true },
            relations: ['user'],
        });
    }

    async countForDetailCacheWarmup(): Promise<number> {
        return this.repository
            .createQueryBuilder('work')
            .where('COALESCE(work.itemsCount, 0) > 0')
            .getCount();
    }

    /**
     * Return a bounded page of works whose detail pages are likely to benefit
     * from prewarmed config/count cache entries.
     */
    async findForDetailCacheWarmup(limit: number, offset = 0): Promise<Work[]> {
        return this.repository
            .createQueryBuilder('work')
            .leftJoinAndSelect('work.user', 'user')
            .where('COALESCE(work.itemsCount, 0) > 0')
            .orderBy('work.updatedAt', 'DESC')
            .addOrderBy('work.id', 'ASC')
            .skip(offset)
            .take(limit)
            .getMany();
    }

    async findDueSourceValidation(limit: number): Promise<Work[]> {
        return this.repository.find({
            where: {
                sourceValidationEnabled: true,
                sourceValidationNextRunAt: LessThanOrEqual(new Date()),
            },
            order: { sourceValidationNextRunAt: 'ASC' },
            take: limit,
            relations: ['user'],
        });
    }

    async updateSourceValidationRun(id: string, nextRunAt: Date): Promise<void> {
        await this.repository.update(id, {
            sourceValidationLastRunAt: new Date(),
            sourceValidationNextRunAt: nextRunAt,
        });
    }
}
