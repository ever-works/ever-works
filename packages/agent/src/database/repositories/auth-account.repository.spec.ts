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
});
