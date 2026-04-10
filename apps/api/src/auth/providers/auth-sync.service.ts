import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AuthAccount } from '@ever-works/agent/entities';
import type { SocialAuthUser } from '../types/social-auth.types';

@Injectable()
export class AuthSyncService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async findCredentialAccount(userId: string) {
        return this.getRepository().findOne({
            where: {
                userId,
                providerId: 'credential',
            },
        });
    }

    async ensureCredentialAccount(userId: string, passwordHash: string) {
        const existingAccount = await this.findCredentialAccount(userId);
        if (existingAccount) {
            return existingAccount;
        }

        return this.getRepository().save(
            this.getRepository().create({
                id: randomUUID(),
                userId,
                providerId: 'credential',
                accountId: userId,
                password: passwordHash,
            }),
        );
    }

    async syncCredentialPassword(userId: string, passwordHash: string) {
        const existingAccount = await this.findCredentialAccount(userId);
        if (!existingAccount) {
            await this.ensureCredentialAccount(userId, passwordHash);
            return;
        }

        await this.getRepository().update(existingAccount.id, {
            password: passwordHash,
        });
    }

    async getCredentialPasswordHash(userId: string): Promise<string | null> {
        const account = await this.findCredentialAccount(userId);
        return account?.password || null;
    }

    async syncSocialAccount(userId: string, socialUser: SocialAuthUser) {
        const repository = this.getRepository();
        const existingAccount =
            (await repository.findOne({
                where: {
                    providerId: socialUser.provider,
                    accountId: socialUser.providerUserId,
                },
            })) ||
            (await repository.findOne({
                where: {
                    userId,
                    providerId: socialUser.provider,
                },
            }));

        const accountData = {
            userId,
            providerId: socialUser.provider,
            accountId: socialUser.providerUserId,
            accessToken: socialUser.accessToken,
            refreshToken: socialUser.refreshToken || null,
            accessTokenExpiresAt: socialUser.expiresAt || null,
            refreshTokenExpiresAt: null,
            scope: socialUser.scope || null,
            idToken: null,
            password: null,
        };

        if (existingAccount) {
            await repository.update(existingAccount.id, accountData);
            return repository.findOneOrFail({
                where: { id: existingAccount.id },
            });
        }

        return repository.save(
            repository.create({
                id: randomUUID(),
                ...accountData,
            }),
        );
    }

    private getRepository() {
        return this.dataSource.getRepository(AuthAccount);
    }
}
