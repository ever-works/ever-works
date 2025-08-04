import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Directory } from '../entities/directory.entity';

@Injectable()
export class DirectoryRepository {
    constructor(
        @InjectRepository(Directory)
        private readonly repository: Repository<Directory>,
    ) {}

    async create(directoryData: Partial<Directory>): Promise<Directory> {
        if (!directoryData.userId) {
            throw new Error('Owner is required');
        }

        const exists = await this.findByOwnerAndSlug(directoryData.userId, directoryData.slug);

        let directory: Directory;
        if (exists) {
            directory = await this.update(exists.id, directoryData);
        } else {
            directory = this.repository.create(directoryData);
        }

        return await this.repository.save(directory);
    }

    async findBySlug(slug: string): Promise<Directory | null> {
        return await this.repository.findOne({ where: { slug } });
    }

    async findByOwnerAndSlug(userId: string, slug: string): Promise<Directory | null> {
        return await this.repository.findOne({ where: { userId, slug } });
    }

    async findById(id: string): Promise<Directory | null> {
        return await this.repository.findOne({ where: { id } });
    }

    async findAll(options?: {
        owner?: string;
        limit?: number;
        offset?: number;
    }): Promise<Directory[]> {
        const { owner, limit, offset } = options || {};

        const queryBuilder = this.repository.createQueryBuilder('directory');

        if (owner) {
            queryBuilder.where('directory.getRepoOwner() = :owner', { owner });
        }

        if (limit) {
            queryBuilder.limit(limit);
        }

        if (offset) {
            queryBuilder.offset(offset);
        }

        queryBuilder.orderBy('directory.id', 'DESC');

        return await queryBuilder.getMany();
    }

    async update(id: string, updateData: Partial<Directory>): Promise<Directory | null> {
        await this.repository.update(id, updateData);
        return await this.findById(id);
    }

    async delete(id: string): Promise<boolean> {
        const result = await this.repository.delete(id);
        return result.affected > 0;
    }

    async deleteBySlug(slug: string): Promise<boolean> {
        const result = await this.repository.delete({ slug });
        return result.affected > 0;
    }

    async exists(slug: string): Promise<boolean> {
        const count = await this.repository.count({ where: { slug } });
        return count > 0;
    }

    async existsByOwnerAndSlug(userId: string, slug: string): Promise<boolean> {
        const count = await this.repository.count({ where: { userId, slug } });
        return count > 0;
    }

    async findByOwner(userId: string): Promise<Directory[]> {
        return await this.repository.find({ where: { userId } });
    }
}
