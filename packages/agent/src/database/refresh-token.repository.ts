import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { RefreshToken } from '../entities/refresh-token.entity';

@Injectable()
export class RefreshTokenRepository {
    constructor(
        @InjectRepository(RefreshToken)
        private readonly repository: Repository<RefreshToken>,
    ) {}

    async create(tokenData: Partial<RefreshToken>): Promise<RefreshToken> {
        const token = this.repository.create(tokenData);
        return await this.repository.save(token);
    }

    async findByToken(token: string): Promise<RefreshToken | null> {
        return await this.repository.findOne({
            where: { token, revoked: false },
            relations: ['user'],
        });
    }

    async findByUserId(userId: string): Promise<RefreshToken[]> {
        return await this.repository.find({
            where: { userId, revoked: false },
        });
    }

    async findByFamily(family: string): Promise<RefreshToken[]> {
        return await this.repository.find({
            where: { family },
            order: { createdAt: 'DESC' },
        });
    }

    async revokeToken(token: string, reason: string): Promise<void> {
        await this.repository.update(
            { token },
            {
                revoked: true,
                revokedAt: new Date(),
                revokedReason: reason,
            },
        );
    }

    async revokeAllUserTokens(userId: string, reason: string): Promise<void> {
        await this.repository.update(
            { userId, revoked: false },
            {
                revoked: true,
                revokedAt: new Date(),
                revokedReason: reason,
            },
        );
    }

    async revokeTokenFamily(family: string, reason: string): Promise<void> {
        await this.repository.update(
            { family, revoked: false },
            {
                revoked: true,
                revokedAt: new Date(),
                revokedReason: reason,
            },
        );
    }

    async deleteExpiredTokens(): Promise<number> {
        const result = await this.repository.delete({
            expiresAt: LessThan(new Date()),
        });
        return result.affected || 0;
    }

    async deleteRevokedTokensOlderThan(date: Date): Promise<number> {
        const result = await this.repository.delete({
            revoked: true,
            revokedAt: LessThan(date),
        });
        return result.affected || 0;
    }
}