import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OAuthToken } from '../../entities/oauth-token.entity';

@Injectable()
export class OAuthTokenRepository {
    constructor(
        @InjectRepository(OAuthToken)
        private readonly repository: Repository<OAuthToken>,
    ) {}

    async upsert(tokenData: Partial<OAuthToken>): Promise<OAuthToken> {
        const existingToken = await this.repository.findOne({
            where: {
                userId: tokenData.userId,
                provider: tokenData.provider,
            },
        });

        if (existingToken) {
            await this.repository.update(existingToken.id, {
                ...tokenData,
                updatedAt: new Date(),
            });
            return await this.repository.findOne({ where: { id: existingToken.id } });
        }

        const token = this.repository.create(tokenData);
        return this.repository.save(token);
    }

    async findByUserAndProvider(userId: string, provider: string): Promise<OAuthToken | null> {
        return this.repository.findOne({
            where: { userId, provider },
            relations: ['user'],
        });
    }

    async findByUserId(userId: string): Promise<OAuthToken[]> {
        return this.repository.find({
            where: { userId },
            order: { provider: 'ASC' },
        });
    }

    async deleteByUserAndProvider(userId: string, provider: string): Promise<void> {
        await this.repository.delete({ userId, provider });
    }

    async deleteAllUserTokens(userId: string): Promise<void> {
        await this.repository.delete({ userId });
    }

    isTokenExpired(token: OAuthToken): boolean {
        if (!token.expiresAt) {
            return false; // No expiration set
        }
        return new Date() > token.expiresAt;
    }
}
