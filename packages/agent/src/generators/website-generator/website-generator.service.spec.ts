jest.mock('node:fs/promises', () => ({
    rm: jest.fn().mockResolvedValue(undefined),
}));

import { WebsiteGeneratorService } from './website-generator.service';
import { WebsiteUpdateService } from './website-update.service';
import { WebsiteRepositoryCreationMethod } from '../../items-generator/dto/create-items-generator.dto';
import type { GitFacadeService } from '../../facades/git.facade';
import type { BranchSyncService } from './branch-sync.service';
import type { Work } from '../../entities/work.entity';
import type { User } from '../../entities/user.entity';

describe('WebsiteGeneratorService', () => {
    const createWork = (): Work =>
        ({
            id: 'dir-1',
            name: 'Test Work',
            gitProvider: 'github',
            organization: null,
            user: { id: 'user-1' },
            getRepoOwner: jest.fn().mockReturnValue('acme'),
            getWebsiteRepo: jest.fn().mockReturnValue('test-work-web'),
            resolveCommitter: jest.fn().mockReturnValue({
                name: 'Test User',
                email: 'test@example.com',
            }),
        }) as unknown as Work;

    const createUser = (): User => ({ id: 'user-1' }) as User;

    const createGitFacadeMock = (): jest.Mocked<GitFacadeService> =>
        ({
            cloneOrPull: jest.fn().mockResolvedValue('/tmp/template'),
            createRepository: jest.fn().mockResolvedValue({
                owner: 'acme',
                name: 'test-work-web',
                fullName: 'acme/test-work-web',
            } as any),
            createRepositoryFromTemplate: jest.fn().mockResolvedValue({
                owner: 'acme',
                name: 'test-work-web',
                fullName: 'acme/test-work-web',
            } as any),
            getCloneUrl: jest
                .fn()
                .mockReturnValue('https://github.com/acme/test-work-web.git'),
            getLocalDir: jest.fn().mockReturnValue('/tmp/test-work-web'),
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
        const work = createWork();
        const user = createUser();

        await service.initialize(
            work,
            user,
            WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE,
        );

        expect(gitFacade.createRepositoryFromTemplate).toHaveBeenCalledTimes(1);
        expect(branchSyncService.syncFromTemplate).toHaveBeenCalledWith(work, user, true);
        expect(gitFacade.listBranches).toHaveBeenCalledWith('acme', 'test-work-web', {
            workId: 'dir-1',
            userId: 'user-1',
            providerId: 'github',
        });
        expect(gitFacade.updateRepository).toHaveBeenCalledWith(
            'acme',
            'test-work-web',
            { defaultBranch: 'main' },
            { userId: 'user-1', providerId: 'github', workId: 'dir-1' },
        );
        expect(branchSyncService.syncFromTemplate.mock.invocationCallOrder[0]).toBeLessThan(
            gitFacade.updateRepository.mock.invocationCallOrder[0],
        );
    });
});

describe('WebsiteUpdateService', () => {
    const createWork = (): Work =>
        ({
            id: 'dir-1',
            name: 'Test Work',
            gitProvider: 'github',
            organization: null,
            user: { id: 'user-1' },
            websiteTemplateUseBeta: false,
            websiteTemplateLastCommit: null,
            getRepoOwner: jest.fn().mockReturnValue('acme'),
            getWebsiteRepo: jest.fn().mockReturnValue('test-work-web'),
            resolveCommitter: jest.fn().mockReturnValue({
                name: 'Test User',
                email: 'test@example.com',
            }),
        }) as unknown as Work;

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
        const work = createWork();
        const user = createUser();

        jest.spyOn(service as any, 'updateDuplicate').mockResolvedValue(undefined);
        jest.spyOn(service as any, 'updateTemplate').mockResolvedValue(undefined);

        await service.updateRepository(work, user);

        expect(branchSyncService.syncFromTemplate).toHaveBeenCalledWith(work, user);
        expect(gitFacade.updateRepository).toHaveBeenCalledWith(
            'acme',
            'test-work-web',
            { defaultBranch: 'main' },
            { userId: 'user-1', providerId: 'github', workId: 'dir-1' },
        );
        expect(branchSyncService.syncFromTemplate.mock.invocationCallOrder[0]).toBeLessThan(
            gitFacade.updateRepository.mock.invocationCallOrder[0],
        );
    });
});
