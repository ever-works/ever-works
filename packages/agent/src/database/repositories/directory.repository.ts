import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, IsNull, Brackets, Raw } from 'typeorm';
import { Directory } from '../../entities/directory.entity';
import { User } from '../../entities';
import { prepareLikeSearchTerm } from '../utils';

/**
 * Cross-database case-insensitive LIKE using LOWER() function.
 * Works with SQLite, PostgreSQL, and MySQL.
 */
function caseInsensitiveLike(search: string) {
    return Raw((alias) => `LOWER(${alias}) LIKE LOWER(:search)`, { search: `%${search}%` });
}

@Injectable()
export class DirectoryRepository {
    constructor(
        @InjectRepository(Directory)
        private readonly repository: Repository<Directory>,
    ) {}

    async create(dto: Partial<Directory>, user: User): Promise<Directory> {
        let exists = await this.findByOwnerAndSlug({
            userId: user.id,
            owner: dto.owner,
            slug: dto.slug,
        });

        if (exists) {
            throw new Error('Directory already exists');
        }

        let directory = this.repository.create(dto);
        directory = await this.repository.save(directory);

        return this.findById(directory.id);
    }

    async createOrUpdate(dto: Partial<Directory>, user: User): Promise<Directory> {
        let exists = await this.findByOwnerAndSlug({
            userId: user.id,
            owner: dto.owner,
            slug: dto.slug,
        });

        let directory: Directory;
        if (exists && exists.userId === user.id) {
            directory = await this.update(exists.id, dto);
        } else {
            directory = this.repository.create(dto);
        }

        directory = await this.repository.save(directory);
        return this.findById(directory.id);
    }

    async findByOwnerAndSlug({
        userId,
        owner,
        slug,
    }: {
        userId: string;
        owner: string;
        slug: string;
    }): Promise<Directory | null> {
        return this.repository.findOne({
            where: owner ? { userId, owner, slug } : { userId, slug },
            relations: ['user'],
        });
    }

    async findById(id: string): Promise<Directory | null> {
        return this.repository.findOne({
            where: { id },
            relations: ['user'],
        });
    }

    private buildWhereConditions(options?: { userId?: string; search?: string }): any {
        const { userId, search } = options || {};

        let whereConditions: any = [];

        if (search) {
            const sanitizedSearch = prepareLikeSearchTerm(search);

            if (sanitizedSearch) {
                // Create OR conditions for search using cross-database case-insensitive LIKE
                const searchConditions = [
                    { name: caseInsensitiveLike(sanitizedSearch) },
                    { description: caseInsensitiveLike(sanitizedSearch) },
                    { slug: caseInsensitiveLike(sanitizedSearch) },
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
    }): Promise<Directory[]> {
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

    async update(id: string, updateData: Partial<Directory>): Promise<Directory | null> {
        await this.repository.update(id, updateData);
        return await this.findById(id);
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

    async findByUser(userId: string): Promise<Directory[]> {
        return await this.repository.find({ where: { userId } });
    }

    async updateLastPullRequest(
        id: string,
        lastPullRequest: Directory['lastPullRequest'],
    ): Promise<void> {
        const directory = await this.findById(id);

        await this.repository.update(id, {
            lastPullRequest: {
                ...directory.lastPullRequest,
                ...lastPullRequest,
            },
        });
    }

    async updateGenerateStatus(
        id: string,
        generateStatus: Directory['generateStatus'],
    ): Promise<void> {
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

    async getUnfinishedGenerations(olderThan: Date): Promise<Directory[]> {
        const stalledDirectories = await this.repository.find({
            where: {
                generationProgressedAt: LessThan(olderThan),
                generationFinishedAt: IsNull(),
            },
        });

        return stalledDirectories;
    }

    /**
     * Find all directories accessible to a user (as creator OR as member).
     * This combines owned directories with those the user has been invited to.
     */
    async findAllAccessible(options?: {
        userId: string;
        memberDirectoryIds?: string[];
        limit?: number;
        offset?: number;
        search?: string;
    }): Promise<Directory[]> {
        const { userId, memberDirectoryIds = [], limit, offset, search } = options || {};

        if (!userId) {
            return [];
        }

        const queryBuilder = this.repository
            .createQueryBuilder('directory')
            .leftJoinAndSelect('directory.user', 'user');

        // User has access if they are the creator OR they have a membership
        if (memberDirectoryIds.length > 0) {
            queryBuilder.where(
                new Brackets((qb) => {
                    qb.where('directory.userId = :userId', { userId }).orWhere(
                        'directory.id IN (:...memberDirectoryIds)',
                        { memberDirectoryIds },
                    );
                }),
            );
        } else {
            queryBuilder.where('directory.userId = :userId', { userId });
        }

        // Apply search filter using cross-database case-insensitive LIKE
        if (search) {
            const sanitizedSearch = prepareLikeSearchTerm(search);
            if (sanitizedSearch) {
                const searchPattern = `%${sanitizedSearch.toLowerCase()}%`;
                queryBuilder.andWhere(
                    new Brackets((qb) => {
                        qb.where('LOWER(directory.name) LIKE :search', { search: searchPattern })
                            .orWhere('LOWER(directory.description) LIKE :search', {
                                search: searchPattern,
                            })
                            .orWhere('LOWER(directory.slug) LIKE :search', {
                                search: searchPattern,
                            });
                    }),
                );
            }
        }

        queryBuilder.orderBy('directory.updatedAt', 'DESC');

        if (limit) {
            queryBuilder.take(limit);
        }

        if (offset) {
            queryBuilder.skip(offset);
        }

        return queryBuilder.getMany();
    }

    /**
     * Count all directories accessible to a user (as creator OR as member).
     */
    async countAllAccessible(options?: {
        userId: string;
        memberDirectoryIds?: string[];
        search?: string;
    }): Promise<number> {
        const { userId, memberDirectoryIds = [], search } = options || {};

        if (!userId) {
            return 0;
        }

        const queryBuilder = this.repository.createQueryBuilder('directory');

        // User has access if they are the creator OR they have a membership
        if (memberDirectoryIds.length > 0) {
            queryBuilder.where(
                new Brackets((qb) => {
                    qb.where('directory.userId = :userId', { userId }).orWhere(
                        'directory.id IN (:...memberDirectoryIds)',
                        { memberDirectoryIds },
                    );
                }),
            );
        } else {
            queryBuilder.where('directory.userId = :userId', { userId });
        }

        // Apply search filter using cross-database case-insensitive LIKE
        if (search) {
            const sanitizedSearch = prepareLikeSearchTerm(search);
            if (sanitizedSearch) {
                const searchPattern = `%${sanitizedSearch.toLowerCase()}%`;
                queryBuilder.andWhere(
                    new Brackets((qb) => {
                        qb.where('LOWER(directory.name) LIKE :search', { search: searchPattern })
                            .orWhere('LOWER(directory.description) LIKE :search', {
                                search: searchPattern,
                            })
                            .orWhere('LOWER(directory.slug) LIKE :search', {
                                search: searchPattern,
                            });
                    }),
                );
            }
        }

        return queryBuilder.getCount();
    }

    /**
     * Find a directory by ID with members relation loaded.
     */
    async findByIdWithMembers(id: string): Promise<Directory | null> {
        return this.repository.findOne({
            where: { id },
            relations: ['user', 'members', 'members.user'],
        });
    }

    /**
     * Find all directories with website template auto-update enabled.
     */
    async findWithWebsiteAutoUpdateEnabled(): Promise<Directory[]> {
        return this.repository.find({
            where: { websiteTemplateAutoUpdate: true },
            relations: ['user'],
        });
    }

    /**
     * Find all directories with community PR processing enabled.
     */
    async findWithCommunityPrProcessingEnabled(): Promise<Directory[]> {
        return this.repository.find({
            where: { communityPrProcessingEnabled: true },
            relations: ['user'],
        });
    }
}
