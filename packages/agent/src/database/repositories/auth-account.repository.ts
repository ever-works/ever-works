import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Not, Repository } from 'typeorm';
import { AuthAccount } from '../../entities';

export type ProviderAccountUpsertData = {
    userId: string;
    providerId: string;
    accountId?: string | null;
    accessToken?: string | null;
    refreshToken?: string | null;
    username?: string | null;
    email?: string | null;
    tokenType?: string | null;
    accessTokenExpiresAt?: Date | null;
    refreshTokenExpiresAt?: Date | null;
    scope?: string | null;
    idToken?: string | null;
    metadata?: Record<string, unknown> | null;
};

@Injectable()
export class AuthAccountRepository {
    constructor(
        @InjectRepository(AuthAccount)
        private readonly authAccountRepository: Repository<AuthAccount>,
    ) {}

    async upsertProviderAccount(accountData: ProviderAccountUpsertData): Promise<AuthAccount> {
        const existingAccount = await this.authAccountRepository.findOne({
            where: {
                userId: accountData.userId,
                providerId: accountData.providerId,
            },
        });
        const resolvedAccountId =
            this.resolveAccountId(accountData) ||
            existingAccount?.accountId ||
            `${accountData.userId}:${accountData.providerId}`;
        const existingProviderAccount = await this.authAccountRepository.findOne({
            where: {
                providerId: accountData.providerId,
                accountId: resolvedAccountId,
            },
        });

        if (existingProviderAccount && existingProviderAccount.userId !== accountData.userId) {
            throw new ConflictException('This provider account is already linked to another user');
        }

        if (
            existingAccount &&
            existingProviderAccount &&
            existingAccount.id !== existingProviderAccount.id
        ) {
            throw new ConflictException(
                'Unable to link provider account because another account record already exists for this provider',
            );
        }

        const targetAccount = existingAccount ?? existingProviderAccount;

        const nextAccountData: Partial<AuthAccount> = {
            userId: accountData.userId,
            providerId: accountData.providerId,
            accountId: resolvedAccountId,
            accessToken: accountData.accessToken ?? targetAccount?.accessToken ?? null,
            refreshToken: accountData.refreshToken ?? targetAccount?.refreshToken ?? null,
            username: accountData.username ?? targetAccount?.username ?? null,
            email: accountData.email ?? targetAccount?.email ?? null,
            tokenType: accountData.tokenType ?? targetAccount?.tokenType ?? 'Bearer',
            accessTokenExpiresAt:
                accountData.accessTokenExpiresAt ?? targetAccount?.accessTokenExpiresAt ?? null,
            refreshTokenExpiresAt:
                accountData.refreshTokenExpiresAt ?? targetAccount?.refreshTokenExpiresAt ?? null,
            scope: accountData.scope ?? targetAccount?.scope ?? null,
            idToken: accountData.idToken ?? targetAccount?.idToken ?? null,
            password: targetAccount?.password ?? null,
            metadata: accountData.metadata ?? targetAccount?.metadata ?? null,
        };

        if (targetAccount) {
            await this.authAccountRepository.update(targetAccount.id, nextAccountData);
            return this.authAccountRepository.findOneOrFail({
                where: { id: targetAccount.id },
            });
        } else {
            return this.authAccountRepository.save(
                this.authAccountRepository.create({
                    id: randomUUID(),
                    ...nextAccountData,
                }),
            );
        }
    }

    async findProviderAccount(userId: string, providerId: string): Promise<AuthAccount | null> {
        return this.authAccountRepository.findOne({
            where: {
                userId,
                providerId,
            },
        });
    }

    async findProviderAccountsByUserId(userId: string): Promise<AuthAccount[]> {
        return this.authAccountRepository.find({
            where: {
                userId,
                providerId: Not('credential'),
            },
            order: { providerId: 'ASC' },
        });
    }

    async deleteProviderAccount(userId: string, providerId: string): Promise<void> {
        await this.authAccountRepository.delete({ userId, providerId });
    }

    async deleteAllProviderAccounts(userId: string): Promise<void> {
        await this.authAccountRepository.delete({
            userId,
            providerId: Not('credential'),
        });
    }

    isAccessTokenExpired(account: Pick<AuthAccount, 'accessTokenExpiresAt'>): boolean {
        if (!account.accessTokenExpiresAt) {
            return false; // No expiration set
        }
        return new Date() > account.accessTokenExpiresAt;
    }

    private resolveAccountId(
        accountData: Pick<
            ProviderAccountUpsertData,
            'accountId' | 'email' | 'username' | 'metadata'
        >,
    ): string | null {
        if (typeof accountData.accountId === 'string' && accountData.accountId) {
            return accountData.accountId;
        }

        const metadata = accountData.metadata;
        if (!metadata || typeof metadata !== 'object') {
            return accountData.email || accountData.username || null;
        }

        const candidateKeys = [
            'oauthUserId',
            'providerUserId',
            'sub',
            'id',
            'nodeId',
            'login',
            'email',
        ];

        for (const key of candidateKeys) {
            const value = (metadata as Record<string, unknown>)[key];
            if (typeof value === 'string' && value) {
                return value;
            }
        }

        return accountData.email || accountData.username || null;
    }
}
