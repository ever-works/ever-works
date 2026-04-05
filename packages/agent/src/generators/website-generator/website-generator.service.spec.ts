jest.mock('node:fs/promises', () => ({
    rm: jest.fn().mockResolvedValue(undefined),
}));

import { WebsiteGeneratorService } from './website-generator.service';
import { WebsiteUpdateService } from './website-update.service';
import { WebsiteRepositoryCreationMethod } from '../../items-generator/dto/create-items-generator.dto';
import type { GitFacadeService } from '../../facades/git.facade';
import type { BranchSyncService } from './branch-sync.service';
import type { Directory } from '../../entities/directory.entity';
import type { User } from '../../entities/user.entity';

describe('WebsiteGeneratorService', () => {
    const createDirectory = (): Directory =>
        ({
            id: 'dir-1',
            name: 'Test Directory',
            gitProvider: 'github',
            organization: null,
            user: { id: 'user-1' },
            getRepoOwner: jest.fn().mockReturnValue('acme'),
            getWebsiteRepo: jest.fn().mockReturnValue('test-directory-web'),
            resolveCommitter: jest.fn().mockReturnValue({
                name: 'Test User',
                email: 'test@example.com',
            }),
        }) as unknown as Directory;

    const createUser = (): User => ({ id: 'user-1' }) as User;

    const createGitFacadeMock = (): jest.Mocked<GitFacadeService> =>
        ({
            cloneOrPull: jest.fn().mockResolvedValue('/tmp/template'),
            createRepository: jest.fn().mockResolvedValue({
                owner: 'acme',
                name: 'test-directory-web',
                fullName: 'acme/test-directory-web',
            } as any),
            createRepositoryFromTemplate: jest.fn().mockResolvedValue({
                owner: 'acme',
                name: 'test-directory-web',
                fullName: 'acme/test-directory-web',
            } as any),
            getCloneUrl: jest
                .fn()
                .mockReturnValue('https://github.com/acme/test-directory-web.git'),
            getLocalDir: jest.fn().mockReturnValue('/tmp/test-directory-web'),
            replaceRemote: jest.fn().mockResolvedValue(undefined),
            push: jest.fn().mockResolvedValue(undefined),
            updateRepository: jest.fn().mockResolvedValue({} as any),
            listBranches: jest.fn().mockResolvedValue([
                { name: 'develop', commit: 'def', isDefault: true },
                { name: 'main', commit: 'abc', isDefault: false },
            ] as any),
        }) as unknown as jest.Mocked<GitFacadeService>;

    const createBranchSyncMock = (): jest.Mocked<BranchSyncService> =>
        ({
            syncFromTemplate: jest.fn().mockResolvedValue({
                totalBranches: 3,
                synced: 3,
                skipped: 0,
                errors: 0,
                results: [],
            }),
        }) as unknown as jest.Mocked<BranchSyncService>;

    it('reasserts the template default branch after create-using-template sync', async () => {
        const gitFacade = createGitFacadeMock();
        const branchSyncService = createBranchSyncMock();
        const service = new WebsiteGeneratorService(gitFacade, branchSyncService);
        const directory = createDirectory();
        const user = createUser();

        await service.initialize(
            directory,
            user,
            WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE,
        );

        expect(gitFacade.createRepositoryFromTemplate).toHaveBeenCalledTimes(1);
        expect(branchSyncService.syncFromTemplate).toHaveBeenCalledWith(directory, user, true);
        expect(gitFacade.listBranches).toHaveBeenCalledWith('acme', 'test-directory-web', {
            userId: 'user-1',
            providerId: 'github',
        });
        expect(gitFacade.updateRepository).toHaveBeenCalledWith(
            'acme',
            'test-directory-web',
            { defaultBranch: 'main' },
            { userId: 'user-1', providerId: 'github' },
        );
        expect(branchSyncService.syncFromTemplate.mock.invocationCallOrder[0]).toBeLessThan(
            gitFacade.updateRepository.mock.invocationCallOrder[0],
        );
    });
});

describe('WebsiteUpdateService', () => {
    const createDirectory = (): Directory =>
        ({
            id: 'dir-1',
            name: 'Test Directory',
            gitProvider: 'github',
            organization: null,
            user: { id: 'user-1' },
            websiteTemplateUseBeta: false,
            websiteTemplateLastCommit: null,
            getRepoOwner: jest.fn().mockReturnValue('acme'),
            getWebsiteRepo: jest.fn().mockReturnValue('test-directory-web'),
            resolveCommitter: jest.fn().mockReturnValue({
                name: 'Test User',
                email: 'test@example.com',
            }),
        }) as unknown as Directory;

    const createUser = (): User => ({ id: 'user-1' }) as User;

    const createGitFacadeMock = (): jest.Mocked<GitFacadeService> =>
        ({
            repositoryExists: jest.fn().mockResolvedValue(true),
            getLatestCommit: jest.fn().mockResolvedValue({ sha: 'abc123' } as any),
            listBranches: jest.fn().mockResolvedValue([
                { name: 'develop', commit: 'def', isDefault: true },
                { name: 'main', commit: 'abc', isDefault: false },
            ] as any),
            updateRepository: jest.fn().mockResolvedValue({} as any),
        }) as unknown as jest.Mocked<GitFacadeService>;

    const createBranchSyncMock = (): jest.Mocked<BranchSyncService> =>
        ({
            syncFromTemplate: jest.fn().mockResolvedValue({
                totalBranches: 3,
                synced: 3,
                skipped: 0,
                errors: 0,
                results: [],
            }),
        }) as unknown as jest.Mocked<BranchSyncService>;

    it('reasserts the template default branch after repository update sync', async () => {
        const gitFacade = createGitFacadeMock();
        const branchSyncService = createBranchSyncMock();
        const service = new WebsiteUpdateService(gitFacade, branchSyncService);
        const directory = createDirectory();
        const user = createUser();

        jest.spyOn(service as any, 'updateDuplicate').mockResolvedValue(undefined);
        jest.spyOn(service as any, 'updateTemplate').mockResolvedValue(undefined);

        await service.updateRepository(directory, user);

        expect(branchSyncService.syncFromTemplate).toHaveBeenCalledWith(directory, user);
        expect(gitFacade.updateRepository).toHaveBeenCalledWith(
            'acme',
            'test-directory-web',
            { defaultBranch: 'main' },
            { userId: 'user-1', providerId: 'github' },
        );
        expect(branchSyncService.syncFromTemplate.mock.invocationCallOrder[0]).toBeLessThan(
            gitFacade.updateRepository.mock.invocationCallOrder[0],
        );
    });
});
