import { GitHubAppInstallationRepository } from './github-app-installation.repository';

describe('GitHubAppInstallationRepository', () => {
    let repository: {
        findOne: jest.Mock;
        findOneOrFail: jest.Mock;
        find: jest.Mock;
        update: jest.Mock;
        create: jest.Mock;
        save: jest.Mock;
        createQueryBuilder: jest.Mock;
    };
    let installationRepository: GitHubAppInstallationRepository;

    beforeEach(() => {
        repository = {
            findOne: jest.fn(),
            findOneOrFail: jest.fn(),
            find: jest.fn(),
            update: jest.fn(),
            create: jest.fn((value) => value),
            save: jest.fn(),
            createQueryBuilder: jest.fn(),
        };

        installationRepository = new GitHubAppInstallationRepository(repository as any);
    });

    it('updates an existing installation without overwriting omitted ownership fields', async () => {
        repository.findOne.mockResolvedValue({
            id: 'installation-row-1',
            installationId: '12345',
            createdByUserId: 'user-123',
        });
        repository.findOneOrFail.mockResolvedValue({
            id: 'installation-row-1',
            installationId: '12345',
            accountLogin: 'acme',
        });

        const result = await installationRepository.upsertFromGithub({
            installationId: '12345',
            accountLogin: 'acme',
            accountType: 'Organization',
            targetType: 'Organization',
        });

        expect(repository.update).toHaveBeenCalledWith(
            'installation-row-1',
            expect.objectContaining({
                installationId: '12345',
                accountLogin: 'acme',
            }),
        );
        expect(repository.update).not.toHaveBeenCalledWith(
            'installation-row-1',
            expect.objectContaining({
                createdByUserId: undefined,
            }),
        );
        expect(repository.findOneOrFail).toHaveBeenCalledWith({
            where: { id: 'installation-row-1' },
        });
        expect(result).toEqual({
            id: 'installation-row-1',
            installationId: '12345',
            accountLogin: 'acme',
        });
    });

    it('recovers from a concurrent insert race by updating the existing installation', async () => {
        repository.findOne.mockResolvedValueOnce(null);
        repository.save.mockRejectedValue({ code: '23505' });
        repository.findOneOrFail.mockResolvedValue({
            id: 'installation-row-1',
            installationId: '12345',
            accountLogin: 'acme',
        });

        const result = await installationRepository.upsertFromGithub({
            installationId: '12345',
            accountLogin: 'acme',
            accountType: 'Organization',
            targetType: 'Organization',
        });

        expect(repository.save).toHaveBeenCalledWith(
            expect.objectContaining({
                installationId: '12345',
                accountLogin: 'acme',
            }),
        );
        expect(repository.update).toHaveBeenCalledWith(
            { installationId: '12345' },
            expect.objectContaining({
                installationId: '12345',
                accountLogin: 'acme',
            }),
        );
        expect(repository.findOneOrFail).toHaveBeenCalledWith({
            where: { installationId: '12345' },
        });
        expect(result).toEqual({
            id: 'installation-row-1',
            installationId: '12345',
            accountLogin: 'acme',
        });
    });

    it('claims installation ownership atomically when it is still unassigned', async () => {
        const execute = jest.fn().mockResolvedValue(undefined);
        const where = jest.fn().mockReturnValue({ execute });
        const set = jest.fn().mockReturnValue({ where });
        const updateBuilder = jest.fn().mockReturnValue({ set });

        repository.findOne
            .mockResolvedValueOnce({
                id: 'installation-row-1',
                installationId: '12345',
                createdByUserId: null,
            })
            .mockResolvedValueOnce({
                id: 'installation-row-1',
                installationId: '12345',
                createdByUserId: 'user-123',
                createdByGithubUserId: 'gh-user-123',
            });
        repository.createQueryBuilder.mockReturnValue({
            update: updateBuilder,
        });

        const result = await installationRepository.claimOwnershipIfUnassigned(
            '12345',
            'user-123',
            'gh-user-123',
        );

        expect(updateBuilder).toHaveBeenCalled();
        expect(set).toHaveBeenCalledWith({
            createdByUserId: 'user-123',
            createdByGithubUserId: 'gh-user-123',
        });
        expect(where).toHaveBeenCalledWith('id = :id AND "createdByUserId" IS NULL', {
            id: 'installation-row-1',
        });
        expect(execute).toHaveBeenCalled();
        expect(result).toEqual({
            id: 'installation-row-1',
            installationId: '12345',
            createdByUserId: 'user-123',
            createdByGithubUserId: 'gh-user-123',
        });
    });
});
