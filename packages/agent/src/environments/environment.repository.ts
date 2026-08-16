import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Environment, type EnvironmentStatus } from '../entities/environment.entity';

/**
 * Repository for the `environments` table (Settings → Environments).
 * Feature-owned (wired by `EnvironmentsModule`, not `DatabaseModule`),
 * same posture as the agents/skills/tasks repositories.
 */
@Injectable()
export class EnvironmentRepository {
    constructor(
        @InjectRepository(Environment)
        private readonly repository: Repository<Environment>,
    ) {}

    async findById(id: string): Promise<Environment | null> {
        return this.repository.findOne({ where: { id } });
    }

    async findByIdAndUser(id: string, userId: string): Promise<Environment | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    async findByUserIdAndSlug(userId: string, slug: string): Promise<Environment | null> {
        return this.repository.findOne({ where: { userId, slug } });
    }

    async findByUser(userId: string, status?: EnvironmentStatus): Promise<Environment[]> {
        return this.repository.find({
            where: status ? { userId, status } : { userId },
            order: { updatedAt: 'DESC' },
        });
    }

    async create(data: Partial<Environment>): Promise<Environment> {
        const entity = this.repository.create(data);
        return this.repository.save(entity);
    }

    async save(entity: Environment): Promise<Environment> {
        return this.repository.save(entity);
    }

    async deleteById(id: string): Promise<void> {
        await this.repository.delete({ id });
    }
}
