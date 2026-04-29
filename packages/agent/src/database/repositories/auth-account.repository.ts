import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Not, Repository } from 'typeorm';
import { AuthAccount } from '../../entities';

/**
 * Namespace prefix for provider accounts created via the plugin-capability OAuth
 * integration flow (distinct from social sign-in accounts).
 *
 * Sign-in and plugin integration request different OAuth scopes — sign-in is
 * minimal (identity only), integrations request full scopes like `repo`.
 * Storing them under separate keys prevents one flow from overwriting the other
 * and lets downstream consumers prefer the broader-scope integration token.
 */
export const PLUGIN_PROVIDER_PREFIX = 'plugin:';

export function buildPluginProviderId(providerId: string): string {
    return `${PLUGIN_PROVIDER_PREFIX}${providerId}`;
}

const PROVIDER_ACCOUNT_ALREADY_LINKED_CODE = 'PROVIDER_ACCOUNT_ALREADY_LINKED';
const PROVIDER_ACCOUNT_RECORD_CONFLICT_CODE = 'PROVIDER_ACCOUNT_RECORD_CONFLICT';
const PROVIDER_ACCOUNT_ALREADY_LINKED_MESSAGE =
    'This provider account is already linked to another user';
const PROVIDER_ACCOUNT_RECORD_CONFLICT_MESSAGE =
    'Unable to link provider account because another account record already exists for this provider';

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
            throw this.createProviderLinkedConflict();
        }

        if (
            existingAccount &&
            existingProviderAccount &&
            existingAccount.id !== existingProviderAccount.id
        ) {
            throw this.createProviderRecordConflict();
        }

        const targetAccount = existingAccount ?? existingProviderAccount;
        const preserveExistingCredentials =
            !!targetAccount && this.shouldPreserveExistingCredentials(targetAccount, accountData);

        const nextAccountData: Partial<AuthAccount> = {
            userId: accountData.userId,
            providerId: accountData.providerId,
            accountId: resolvedAccountId,
            accessToken: preserveExistingCredentials
                ? (targetAccount.accessToken ?? null)
                : (accountData.accessToken ?? targetAccount?.accessToken ?? null),
            refreshToken: preserveExistingCredentials
                ? (targetAccount.refreshToken ?? null)
                : (accountData.refreshToken ?? targetAccount?.refreshToken ?? null),
            username: accountData.username ?? targetAccount?.username ?? null,
            email: accountData.email ?? targetAccount?.email ?? null,
            tokenType: preserveExistingCredentials
                ? (targetAccount.tokenType ?? 'Bearer')
                : (accountData.tokenType ?? targetAccount?.tokenType ?? 'Bearer'),
            accessTokenExpiresAt: preserveExistingCredentials
                ? (targetAccount.accessTokenExpiresAt ?? null)
                : (accountData.accessTokenExpiresAt ?? targetAccount?.accessTokenExpiresAt ?? null),
            refreshTokenExpiresAt: preserveExistingCredentials
                ? (targetAccount.refreshTokenExpiresAt ?? null)
                : (accountData.refreshTokenExpiresAt ??
                  targetAccount?.refreshTokenExpiresAt ??
                  null),
            scope: preserveExistingCredentials
                ? (targetAccount.scope ?? null)
                : (accountData.scope ?? targetAccount?.scope ?? null),
            idToken: preserveExistingCredentials
                ? (targetAccount.idToken ?? null)
                : (accountData.idToken ?? targetAccount?.idToken ?? null),
            password: targetAccount?.password ?? null,
            metadata: accountData.metadata ?? targetAccount?.metadata ?? null,
        };

        if (targetAccount) {
            try {
                await this.authAccountRepository.update(targetAccount.id, nextAccountData);
                return this.authAccountRepository.findOneOrFail({
                    where: { id: targetAccount.id },
                });
            } catch (error) {
                throw await this.translateUniqueConstraint(error, accountData, resolvedAccountId);
            }
        } else {
            try {
                return await this.authAccountRepository.save(
                    this.authAccountRepository.create({
                        id: randomUUID(),
                        ...nextAccountData,
                    }),
                );
            } catch (error) {
                throw await this.translateUniqueConstraint(error, accountData, resolvedAccountId);
            }
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

    async findProviderAccountByAccountId(
        providerId: string,
        accountId: string,
    ): Promise<AuthAccount | null> {
        return this.authAccountRepository.findOne({
            where: {
                providerId,
                accountId,
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

    hasRequiredScopes(
        account: Pick<AuthAccount, 'scope'> | null | undefined,
        requiredScopes: readonly string[],
    ): boolean {
        if (!account || requiredScopes.length === 0) {
            return true;
        }

        const availableScopes = this.parseScopes(account.scope);
        if (availableScopes.size === 0) {
            return false;
        }

        return requiredScopes.every((scope) => availableScopes.has(scope));
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

    private shouldPreserveExistingCredentials(
        existingAccount: Pick<
            AuthAccount,
            | 'accessToken'
            | 'refreshToken'
            | 'tokenType'
            | 'accessTokenExpiresAt'
            | 'refreshTokenExpiresAt'
            | 'scope'
            | 'idToken'
        >,
        incomingAccountData: Pick<
            ProviderAccountUpsertData,
            | 'accessToken'
            | 'refreshToken'
            | 'tokenType'
            | 'accessTokenExpiresAt'
            | 'refreshTokenExpiresAt'
            | 'scope'
            | 'idToken'
        >,
    ): boolean {
        if (!existingAccount.accessToken || this.isAccessTokenExpired(existingAccount)) {
            return false;
        }

        if (!incomingAccountData.accessToken || !incomingAccountData.scope) {
            return false;
        }

        const existingScopes = this.parseScopes(existingAccount.scope);
        const incomingScopes = this.parseScopes(incomingAccountData.scope);

        if (existingScopes.size === 0 || incomingScopes.size === 0) {
            return false;
        }

        const existingIsSuperset = [...incomingScopes].every((scope) => existingScopes.has(scope));
        return existingIsSuperset && existingScopes.size > incomingScopes.size;
    }

    private parseScopes(scope: string | null | undefined): Set<string> {
        if (!scope) {
            return new Set();
        }

        return new Set(
            scope
                .split(/[,\s]+/)
                .map((value) => value.trim())
                .filter(Boolean),
        );
    }

    private async translateUniqueConstraint(
        error: unknown,
        accountData: Pick<ProviderAccountUpsertData, 'userId' | 'providerId'>,
        resolvedAccountId: string,
    ): Promise<never> {
        if (!this.isUniqueConstraintError(error)) {
            throw error;
        }

        const currentProviderAccount = await this.authAccountRepository.findOne({
            where: {
                providerId: accountData.providerId,
                accountId: resolvedAccountId,
            },
        });

        if (currentProviderAccount && currentProviderAccount.userId !== accountData.userId) {
            throw this.createProviderLinkedConflict();
        }

        throw this.createProviderRecordConflict();
    }

    private isUniqueConstraintError(error: unknown): boolean {
        if (error && typeof error === 'object' && 'code' in error) {
            const code = (error as { code: string }).code;
            return code === '23505' || code === 'ER_DUP_ENTRY' || code === 'SQLITE_CONSTRAINT';
        }
        return false;
    }

    private createProviderLinkedConflict(): ConflictException {
        return new ConflictException({
            code: PROVIDER_ACCOUNT_ALREADY_LINKED_CODE,
            message: PROVIDER_ACCOUNT_ALREADY_LINKED_MESSAGE,
        });
    }

    private createProviderRecordConflict(): ConflictException {
        return new ConflictException({
            code: PROVIDER_ACCOUNT_RECORD_CONFLICT_CODE,
            message: PROVIDER_ACCOUNT_RECORD_CONFLICT_MESSAGE,
        });
    }
}
