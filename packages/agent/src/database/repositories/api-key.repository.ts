import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, IsNull, Not, LessThan, And } from 'typeorm';
import { ApiKey } from '../../entities/api-key.entity';

@Injectable()
export class ApiKeyRepository {
    constructor(
        @InjectRepository(ApiKey)
        private readonly repository: Repository<ApiKey>,
    ) {}

    async create(data: Partial<ApiKey>): Promise<ApiKey> {
        const apiKey = this.repository.create(data);
        return this.repository.save(apiKey);
    }

    async findByHashedKey(hashedKey: string): Promise<ApiKey | null> {
        return this.repository.findOne({
            where: { hashedKey, isActive: true },
        });
    }

    async findByUserId(userId: string): Promise<ApiKey[]> {
        return this.repository.find({
            where: { userId },
            select: ['id', 'name', 'prefix', 'expiresAt', 'lastUsedAt', 'isActive', 'createdAt'],
            order: { createdAt: 'DESC' },
        });
    }

    async findByIdAndUserId(id: string, userId: string): Promise<ApiKey | null> {
        return this.repository.findOne({
            where: { id, userId },
        });
    }

    async updateLastUsed(id: string): Promise<void> {
        await this.repository.update(id, { lastUsedAt: new Date() });
    }

    async deleteByIdAndUserId(id: string, userId: string): Promise<boolean> {
        const result = await this.repository.delete({ id, userId });
        return (result.affected ?? 0) > 0;
    }

    async countByUserId(userId: string): Promise<number> {
        return this.repository.count({
            where: [
                { userId, expiresAt: IsNull() },
                { userId, expiresAt: MoreThan(new Date()) },
            ],
        });
    }

    async deleteExpiredKeys(): Promise<number> {
        const result = await this.repository.delete({
            expiresAt: And(Not(IsNull()), LessThan(new Date())),
        });
        return result.affected ?? 0;
    }
}
