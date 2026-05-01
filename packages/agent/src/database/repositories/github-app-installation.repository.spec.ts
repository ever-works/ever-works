import { GitHubAppInstallationRepository } from './github-app-installation.repository';

describe('GitHubAppInstallationRepository', () => {
    let repository: {
        findOne: jest.Mock;
        findOneOrFail: jest.Mock;
        find: jest.Mock;
        update: jest.Mock;
        upsert: jest.Mock;
        create: jest.Mock;
    };
    let installationRepository: GitHubAppInstallationRepository;

    beforeEach(() => {
        repository = {
            findOne: jest.fn(),
            findOneOrFail: jest.fn(),
            find: jest.fn(),
            update: jest.fn(),
            upsert: jest.fn(),
            create: jest.fn((value) => value),
        };

        installationRepository = new GitHubAppInstallationRepository(repository as any);
    });

    it('upserts by installationId and reloads the persisted installation', async () => {
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

        expect(repository.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                installationId: '12345',
                accountLogin: 'acme',
            }),
            ['installationId'],
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
});
