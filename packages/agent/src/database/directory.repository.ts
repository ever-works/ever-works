import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

        return await this.repository.save(directory);
    }

    async findBySlug(slug: string): Promise<Directory | null> {
        return await this.repository.findOne({ where: { slug } });
    }

    async findByUserAndSlug(userId: string, slug: string): Promise<Directory | null> {
        return await this.repository.findOne({ where: { userId, slug } });
    }

    async findByOwnerAndSlug(owner: string, slug: string): Promise<Directory | null> {
        return await this.repository.findOne({ where: { owner, slug } });
    }

    async findById(id: string): Promise<Directory | null> {
        return await this.repository.findOne({ where: { id } });
    }

    async findAll(options?: {
        userId?: string;
        limit?: number;
        offset?: number;
        search?: string;
    }): Promise<Directory[]> {
        const { userId, limit, offset, search } = options || {};

        const queryBuilder = this.repository.createQueryBuilder('directory');

        if (userId) {
            queryBuilder.where('userId = :userId', { userId });
        }

        if (search) {
            const sanitizedSearch = prepareLikeSearchTerm(search);

            if (sanitizedSearch) {
                // Use LOWER() for case-insensitive search - works across all databases
                queryBuilder.andWhere(
                    '(LOWER(directory.name) LIKE LOWER(:search) OR LOWER(directory.description) LIKE LOWER(:search) OR LOWER(directory.slug) LIKE LOWER(:search))',
                    { search: `%${sanitizedSearch}%` },
                );
            }
        }

        if (limit) {
            queryBuilder.limit(limit);
        }

        if (offset) {
            queryBuilder.offset(offset);
        }

        queryBuilder.orderBy('directory.id', 'DESC');

        const directories = await queryBuilder.getMany();

        return directories.map((dir) => {
            return {
                ...dir,
                owner: dir.getRepoOwner(),
            } as Directory;
        });
    }

    async countAll(options?: { userId?: string; search?: string }): Promise<number> {
        const { userId, search } = options || {};

        const queryBuilder = this.repository.createQueryBuilder('directory');

        if (userId) {
            queryBuilder.where('userId = :userId', { userId });
        }

        if (search) {
            const sanitizedSearch = prepareLikeSearchTerm(search);

            if (sanitizedSearch) {
                // Use LOWER() for case-insensitive search - works across all databases
                queryBuilder.andWhere(
                    '(LOWER(directory.name) LIKE LOWER(:search) OR LOWER(directory.description) LIKE LOWER(:search) OR LOWER(directory.slug) LIKE LOWER(:search))',
                    { search: `%${sanitizedSearch}%` },
                );
            }
        }

        return await queryBuilder.getCount();
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
