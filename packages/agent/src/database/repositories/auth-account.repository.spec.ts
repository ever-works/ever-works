import { ConflictException } from '@nestjs/common';
import { AuthAccountRepository } from './auth-account.repository';

describe('AuthAccountRepository', () => {
    let repository: {
        findOne: jest.Mock;
        findOneOrFail: jest.Mock;
        update: jest.Mock;
        save: jest.Mock;
        create: jest.Mock;
    };
    let authAccountRepository: AuthAccountRepository;

    beforeEach(() => {
        repository = {
            findOne: jest.fn(),
            findOneOrFail: jest.fn(),
            update: jest.fn(),
            save: jest.fn(),
            create: jest.fn(),
        };

        authAccountRepository = new AuthAccountRepository(repository as any);
    });

    it('updates an existing provider account matched by providerId and accountId', async () => {
        const existingProviderAccount = {
            id: 'account-1',
            userId: 'user-1',
            providerId: 'github',
            accountId: '35149259',
            accessToken: 'old-token',
        };

        repository.findOne
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(existingProviderAccount);
        repository.findOneOrFail.mockResolvedValue({
            ...existingProviderAccount,
            accessToken: 'new-token',
        });

        const result = await authAccountRepository.upsertProviderAccount({
            userId: 'user-1',
            providerId: 'github',
            accountId: '35149259',
            accessToken: 'new-token',
            username: 'paradoxe35',
        });

        expect(repository.update).toHaveBeenCalledWith(
            'account-1',
            expect.objectContaining({
                userId: 'user-1',
                providerId: 'github',
                accountId: '35149259',
                accessToken: 'new-token',
                username: 'paradoxe35',
            }),
        );
        expect(repository.save).not.toHaveBeenCalled();
        expect(result).toEqual({
            ...existingProviderAccount,
            accessToken: 'new-token',
        });
    });

    it('throws a conflict when the provider account is linked to another user', async () => {
        repository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
            id: 'account-2',
            userId: 'user-2',
            providerId: 'github',
            accountId: '35149259',
        });

        await expect(
            authAccountRepository.upsertProviderAccount({
                userId: 'user-1',
                providerId: 'github',
                accountId: '35149259',
                accessToken: 'new-token',
            }),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(repository.update).not.toHaveBeenCalled();
        expect(repository.save).not.toHaveBeenCalled();
    });

    it('translates unique constraint races into a provider conflict', async () => {
        repository.findOne
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: 'account-2',
                userId: 'user-2',
                providerId: 'github',
                accountId: '35149259',
            });
        repository.create.mockReturnValue({
            id: 'new-account',
            userId: 'user-1',
            providerId: 'github',
            accountId: '35149259',
        });
        repository.save.mockRejectedValue({ code: '23505' });

        const promise = authAccountRepository.upsertProviderAccount({
            userId: 'user-1',
            providerId: 'github',
            accountId: '35149259',
            accessToken: 'new-token',
        });

        await expect(promise).rejects.toBeInstanceOf(ConflictException);
        await expect(promise).rejects.toMatchObject({
            response: expect.objectContaining({
                code: 'PROVIDER_ACCOUNT_ALREADY_LINKED',
            }),
        });
    });

    it('preserves a stronger existing token when a narrower token is upserted later', async () => {
        const existingProviderAccount = {
            id: 'account-1',
            userId: 'user-1',
            providerId: 'github',
            accountId: '35149259',
            accessToken: 'repo-token',
            refreshToken: 'repo-refresh',
            tokenType: 'Bearer',
            accessTokenExpiresAt: new Date(Date.now() + 60_000),
            refreshTokenExpiresAt: null,
            scope: 'user:email read:user repo workflow read:org',
            idToken: null,
            metadata: { login: 'repo-user' },
            username: 'repo-user',
            email: 'repo@example.com',
        };

        repository.findOne
            .mockResolvedValueOnce(existingProviderAccount)
            .mockResolvedValueOnce(null);
        repository.findOneOrFail.mockResolvedValue(existingProviderAccount);

        await authAccountRepository.upsertProviderAccount({
            userId: 'user-1',
            providerId: 'github',
            accountId: '35149259',
            accessToken: 'login-token',
            refreshToken: 'login-refresh',
            tokenType: 'Bearer',
            accessTokenExpiresAt: new Date(Date.now() + 120_000),
            scope: 'user:email read:user',
            username: 'login-user',
        });

        expect(repository.update).toHaveBeenCalledWith(
            'account-1',
            expect.objectContaining({
                accessToken: 'repo-token',
                refreshToken: 'repo-refresh',
                scope: 'user:email read:user repo workflow read:org',
                username: 'login-user',
            }),
        );
    });

    it('replaces an expired stronger token with a newer narrower token', async () => {
        const existingProviderAccount = {
            id: 'account-1',
            userId: 'user-1',
            providerId: 'github',
            accountId: '35149259',
            accessToken: 'expired-repo-token',
            refreshToken: 'expired-repo-refresh',
            tokenType: 'Bearer',
            accessTokenExpiresAt: new Date(Date.now() - 60_000),
            refreshTokenExpiresAt: null,
            scope: 'user:email read:user repo workflow read:org',
            idToken: null,
            metadata: { login: 'repo-user' },
        };

        repository.findOne
            .mockResolvedValueOnce(existingProviderAccount)
            .mockResolvedValueOnce(null);
        repository.findOneOrFail.mockResolvedValue({
            ...existingProviderAccount,
            accessToken: 'login-token',
            scope: 'user:email read:user',
        });

        await authAccountRepository.upsertProviderAccount({
            userId: 'user-1',
            providerId: 'github',
            accountId: '35149259',
            accessToken: 'login-token',
            refreshToken: 'login-refresh',
            tokenType: 'Bearer',
            accessTokenExpiresAt: new Date(Date.now() + 120_000),
            scope: 'user:email read:user',
        });

        expect(repository.update).toHaveBeenCalledWith(
            'account-1',
            expect.objectContaining({
                accessToken: 'login-token',
                refreshToken: 'login-refresh',
                scope: 'user:email read:user',
            }),
        );
    });

    it('matches required scopes across comma and space separated values', () => {
        expect(
            authAccountRepository.hasRequiredScopes(
                { scope: 'user:email, read:user repo' } as any,
                ['repo', 'read:user'],
            ),
        ).toBe(true);

        expect(
            authAccountRepository.hasRequiredScopes({ scope: 'user:email read:user' } as any, [
                'repo',
            ]),
        ).toBe(false);
    });
});
