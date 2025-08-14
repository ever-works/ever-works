import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities';
import { prepareLikeSearchTerm } from './utils';

@Injectable()
export class DirectoryRepository {
    constructor(
        @InjectRepository(Directory)
        private readonly repository: Repository<Directory>,
    ) {}

    async create(directoryData: Partial<Directory>, user: User): Promise<Directory> {
        let exists: Directory | null = null;
        if (directoryData.owner) {
            exists = await this.findByOwnerAndSlug(directoryData.owner, directoryData.slug);
            exists ??= await this.findByUserAndSlug(user.id, directoryData.slug);
        } else {
            exists = await this.findByUserAndSlug(user.id, directoryData.slug);
        }

        let directory: Directory;
        if (exists && exists.userId === user.id) {
            directory = await this.update(exists.id, directoryData);
        } else {
            directory = this.repository.create(directoryData);
        }

        directory = await this.repository.save(directory);
        return this.findById(directory.id);
    }

    private async findByUserAndSlug(userId: string, slug: string): Promise<Directory | null> {
        return await this.repository.findOne({
            where: { userId, slug },
            relations: ['user', 'user.oauthTokens'],
        });
    }

    async findByOwnerAndSlug(owner: string, slug: string): Promise<Directory | null> {
        return await this.repository.findOne({
            where: { owner, slug },
            relations: ['user', 'user.oauthTokens'],
        });
    }

    async findById(id: string): Promise<Directory | null> {
        return await this.repository.findOne({
            where: { id },
            relations: ['user', 'user.oauthTokens'],
        });
    }

    private buildWhereConditions(options?: { userId?: string; search?: string }): any {
        const { userId, search } = options || {};

        let whereConditions: any = [];

        if (search) {
            const sanitizedSearch = prepareLikeSearchTerm(search);

            if (sanitizedSearch) {
                // Create OR conditions for search
                const searchConditions = [
                    { name: ILike(`%${sanitizedSearch}%`) },
                    { description: ILike(`%${sanitizedSearch}%`) },
                    { slug: ILike(`%${sanitizedSearch}%`) },
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
            relations: ['user', 'user.oauthTokens'],
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

        const directories = await this.repository.find(findOptions);

        return directories.map((dir) => {
            return {
                ...dir,
                owner: dir.getRepoOwner(),
            } as Directory;
        });
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
}
