import { GitHubAppInstallationRepoRepository } from './github-app-installation-repository.repository';

describe('GitHubAppInstallationRepoRepository', () => {
    let repository: {
        manager: {
            transaction: jest.Mock;
        };
    };
    let transactionalRepository: {
        delete: jest.Mock;
        create: jest.Mock;
        save: jest.Mock;
    };
    let installationRepoRepository: GitHubAppInstallationRepoRepository;

    beforeEach(() => {
        transactionalRepository = {
            delete: jest.fn(),
            create: jest.fn((value) => value),
            save: jest.fn(),
        };
        repository = {
            manager: {
                transaction: jest.fn(async (callback) =>
                    callback({
                        getRepository: jest.fn().mockReturnValue(transactionalRepository),
                    }),
                ),
            },
        };

        installationRepoRepository = new GitHubAppInstallationRepoRepository(repository as any);
    });

    it('replaces installation repositories inside a transaction', async () => {
        transactionalRepository.save.mockResolvedValue([{ id: 'repo-row-1' }]);

        const result = await installationRepoRepository.replaceForInstallation('installation-1', [
            {
                githubRepoId: '123',
                owner: 'ever-works',
                repo: 'awesome-list',
                fullName: 'ever-works/awesome-list',
                isPrivate: false,
                defaultBranch: 'main',
            },
        ]);

        expect(repository.manager.transaction).toHaveBeenCalledTimes(1);
        expect(transactionalRepository.delete).toHaveBeenCalledWith({
            installationEntityId: 'installation-1',
        });
        expect(transactionalRepository.save).toHaveBeenCalledWith([
            expect.objectContaining({
                installationEntityId: 'installation-1',
                githubRepoId: '123',
            }),
        ]);
        expect(result).toEqual([{ id: 'repo-row-1' }]);
    });

    it('returns an empty array after deleting rows when no repositories remain', async () => {
        const result = await installationRepoRepository.replaceForInstallation(
            'installation-1',
            [],
        );

        expect(repository.manager.transaction).toHaveBeenCalledTimes(1);
        expect(transactionalRepository.delete).toHaveBeenCalledWith({
            installationEntityId: 'installation-1',
        });
        expect(transactionalRepository.save).not.toHaveBeenCalled();
        expect(result).toEqual([]);
    });
});
