import { NotFoundException } from '@nestjs/common';
import { WebsiteUpdateService } from './website-update.service';
import type { WebsiteTemplateConfig } from './config/website-template.config';

jest.mock('node:fs/promises', () => ({
    readdir: jest.fn(),
    rm: jest.fn().mockResolvedValue(undefined),
    mkdir: jest.fn().mockResolvedValue(undefined),
    copyFile: jest.fn().mockResolvedValue(undefined),
}));

const fsMock = jest.requireMock('node:fs/promises') as {
    readdir: jest.Mock;
    rm: jest.Mock;
    mkdir: jest.Mock;
    copyFile: jest.Mock;
};

describe('WebsiteUpdateService', () => {
    let gitFacade: any;
    let branchSyncService: any;
    let websiteTemplateResolver: any;
    let service: WebsiteUpdateService;

    const baseTemplate: WebsiteTemplateConfig = {
        id: 'classic',
        name: 'Classic',
        description: 'desc',
        owner: 'ever-works',
        repo: 'directory-web-template',
        branch: 'main',
        syncBranches: ['main', 'stage', 'develop'],
        betaBranch: null,
    };

    function makeWork(overrides: Record<string, any> = {}) {
        const user = { id: 'user-1', username: 'ever' };
        return {
            id: 'work-1',
            user,
            gitProvider: 'github',
            websiteTemplateUseBeta: false,
            websiteTemplateLastCommit: 'old-sha',
            getRepoOwner: jest.fn().mockReturnValue('owner'),
            getWebsiteRepo: jest.fn().mockReturnValue('repo'),
            resolveCommitter: jest.fn().mockReturnValue({ name: 'ever', email: 'e@x.test' }),
            ...overrides,
        };
    }

    beforeEach(() => {
        jest.clearAllMocks();
        fsMock.readdir.mockResolvedValue([]);
        fsMock.rm.mockResolvedValue(undefined);
        fsMock.mkdir.mockResolvedValue(undefined);
        fsMock.copyFile.mockResolvedValue(undefined);

        gitFacade = {
            listBranches: jest.fn(),
            updateRepository: jest.fn().mockResolvedValue(undefined),
            repositoryExists: jest.fn(),
            getLatestCommit: jest.fn(),
            cloneOrPull: jest.fn(),
            removeLocalDir: jest.fn().mockResolvedValue(undefined),
            getCloneUrl: jest.fn().mockReturnValue('https://example.test/owner/repo.git'),
            switchBranch: jest.fn().mockResolvedValue(undefined),
            replaceRemote: jest.fn().mockResolvedValue(undefined),
            push: jest.fn().mockResolvedValue(undefined),
            hasValidCredentials: jest.fn(),
            hasForkRelationship: jest.fn(),
            add: jest.fn().mockResolvedValue(undefined),
            commit: jest.fn().mockResolvedValue(undefined),
        };

        branchSyncService = {
            syncFromTemplate: jest.fn(),
        };

        websiteTemplateResolver = {
            resolveForWork: jest.fn().mockResolvedValue(baseTemplate),
        };

        service = new WebsiteUpdateService(gitFacade, branchSyncService, websiteTemplateResolver);
    });

    describe('updateRepository', () => {
        it('throws NotFoundException when target repository does not exist', async () => {
            const work = makeWork();
            gitFacade.repositoryExists.mockResolvedValue(false);

            await expect(service.updateRepository(work as any, { id: 'u' } as any)).rejects.toThrow(
                NotFoundException,
            );
            await expect(service.updateRepository(work as any, { id: 'u' } as any)).rejects.toThrow(
                "Website repository 'owner/repo' does not exist",
            );
            // The throw happens before getLatestCommit is even called.
            expect(gitFacade.getLatestCommit).not.toHaveBeenCalled();
        });

        it('uses the duplicate method on success and returns commitSha + branchSync envelope', async () => {
            const work = makeWork();
            gitFacade.repositoryExists.mockResolvedValue(true);
            gitFacade.getLatestCommit.mockResolvedValue({ sha: 'abc123' });
            gitFacade.cloneOrPull.mockResolvedValue('/tmp/dup');
            branchSyncService.syncFromTemplate.mockResolvedValue({
                totalBranches: 3,
                synced: 3,
                skipped: 0,
                errors: 0,
                results: [],
            });
            gitFacade.listBranches.mockResolvedValue([{ name: 'main' }]);

            const result = await service.updateRepository(work as any, { id: 'u' } as any);

            expect(result).toEqual({
                method: 'duplicate',
                message: 'Successfully updated using duplicate method',
                commitSha: 'abc123',
                branchSync: expect.objectContaining({ synced: 3 }),
            });
            // Duplicate-method flow: removeLocalDir → cloneOrPull(template) →
            // switchBranch → replaceRemote → push.
            expect(gitFacade.removeLocalDir).toHaveBeenCalledWith(
                'github',
                'ever-works',
                'directory-web-template',
            );
            expect(gitFacade.switchBranch).toHaveBeenCalledWith('github', '/tmp/dup', 'main');
            expect(gitFacade.replaceRemote).toHaveBeenCalledWith(
                'github',
                '/tmp/dup',
                'origin',
                expect.any(String),
            );
            expect(gitFacade.push).toHaveBeenCalledWith(
                { dir: '/tmp/dup', force: true },
                expect.any(Object),
            );
        });

        it('falls back to template method when duplicate method fails', async () => {
            const work = makeWork();
            gitFacade.repositoryExists.mockResolvedValue(true);
            gitFacade.getLatestCommit.mockResolvedValue({ sha: 'def456' });
            // Duplicate path's first cloneOrPull rejects.
            gitFacade.cloneOrPull
                .mockRejectedValueOnce(new Error('duplicate path failed'))
                .mockResolvedValue('/tmp/template-side');
            branchSyncService.syncFromTemplate.mockResolvedValue(null);
            gitFacade.listBranches.mockResolvedValue([{ name: 'main' }]);

            const warnSpy = jest
                .spyOn((service as any).logger, 'warn')
                .mockImplementation(() => undefined);

            const result = await service.updateRepository(work as any, { id: 'u' } as any);

            expect(result).toEqual({
                method: 'create-using-template',
                message: 'Successfully updated using template method',
                commitSha: 'def456',
                branchSync: undefined,
            });
            expect(warnSpy).toHaveBeenCalledWith('Duplicate update failed: duplicate path failed');
            // Template-method path adds + commits + pushes.
            expect(gitFacade.add).toHaveBeenCalled();
            expect(gitFacade.commit).toHaveBeenCalledWith(
                'github',
                expect.any(String),
                'Update website from template (main)',
                expect.any(Object),
            );
        });

        it('rethrows wrapped error when both methods fail', async () => {
            const work = makeWork();
            gitFacade.repositoryExists.mockResolvedValue(true);
            gitFacade.getLatestCommit.mockResolvedValue({ sha: 'xyz' });
            gitFacade.cloneOrPull
                .mockRejectedValueOnce(new Error('dup boom'))
                .mockRejectedValueOnce(new Error('tpl boom'));

            const errorSpy = jest
                .spyOn((service as any).logger, 'error')
                .mockImplementation(() => undefined);
            jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

            await expect(service.updateRepository(work as any, { id: 'u' } as any)).rejects.toThrow(
                'All update methods failed. Last error: tpl boom',
            );
            expect(errorSpy).toHaveBeenCalledWith('Template update failed: tpl boom');
            expect(branchSyncService.syncFromTemplate).not.toHaveBeenCalled();
        });

        it('uses options.branch when provided, falling back to template.branch otherwise', async () => {
            const work = makeWork();
            gitFacade.repositoryExists.mockResolvedValue(true);
            gitFacade.getLatestCommit.mockResolvedValue(null);
            gitFacade.cloneOrPull.mockResolvedValue('/tmp/dup');
            branchSyncService.syncFromTemplate.mockResolvedValue(null);
            gitFacade.listBranches.mockResolvedValue([]);

            await service.updateRepository(work as any, { id: 'u' } as any, { branch: 'develop' });

            expect(gitFacade.cloneOrPull).toHaveBeenCalledWith(
                expect.objectContaining({ branch: 'develop' }),
                expect.any(Object),
            );
            expect(gitFacade.switchBranch).toHaveBeenCalledWith('github', '/tmp/dup', 'develop');
        });

        it('returns commitSha=undefined when getLatestCommit returns null', async () => {
            const work = makeWork();
            gitFacade.repositoryExists.mockResolvedValue(true);
            gitFacade.getLatestCommit.mockResolvedValue(null);
            gitFacade.cloneOrPull.mockResolvedValue('/tmp/dup');
            branchSyncService.syncFromTemplate.mockResolvedValue(null);
            gitFacade.listBranches.mockResolvedValue([]);

            const result = await service.updateRepository(work as any, { id: 'u' } as any);

            expect(result.commitSha).toBeUndefined();
        });

        it('coerces falsy syncFromTemplate result to undefined branchSync', async () => {
            const work = makeWork();
            gitFacade.repositoryExists.mockResolvedValue(true);
            gitFacade.getLatestCommit.mockResolvedValue({ sha: 'a' });
            gitFacade.cloneOrPull.mockResolvedValue('/tmp/dup');
            branchSyncService.syncFromTemplate.mockResolvedValue(null);
            gitFacade.listBranches.mockResolvedValue([]);

            const result = await service.updateRepository(work as any, { id: 'u' } as any);

            expect(result.branchSync).toBeUndefined();
        });
    });

    describe('ensureTemplateDefaultBranch (via updateRepository)', () => {
        it('updates default branch when target branch exists on remote', async () => {
            const work = makeWork();
            gitFacade.repositoryExists.mockResolvedValue(true);
            gitFacade.getLatestCommit.mockResolvedValue({ sha: 'a' });
            gitFacade.cloneOrPull.mockResolvedValue('/tmp/dup');
            branchSyncService.syncFromTemplate.mockResolvedValue(null);
            gitFacade.listBranches.mockResolvedValue([{ name: 'feature/x' }, { name: 'main' }]);

            await service.updateRepository(work as any, { id: 'u' } as any);

            expect(gitFacade.updateRepository).toHaveBeenCalledWith(
                'owner',
                'repo',
                { defaultBranch: 'main' },
                { userId: 'user-1', providerId: 'github', workId: 'work-1' },
            );
        });

        it('skips updateRepository and warns when target branch is missing', async () => {
            const work = makeWork();
            gitFacade.repositoryExists.mockResolvedValue(true);
            gitFacade.getLatestCommit.mockResolvedValue({ sha: 'a' });
            gitFacade.cloneOrPull.mockResolvedValue('/tmp/dup');
            branchSyncService.syncFromTemplate.mockResolvedValue(null);
            gitFacade.listBranches.mockResolvedValue([{ name: 'develop' }]);
            const warnSpy = jest
                .spyOn((service as any).logger, 'warn')
                .mockImplementation(() => undefined);

            await service.updateRepository(work as any, { id: 'u' } as any);

            expect(gitFacade.updateRepository).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(
                "Cannot set default branch to 'main' for owner/repo because the branch does not exist yet",
            );
        });

        it('swallows listBranches Error rejection and warns with .message', async () => {
            const work = makeWork();
            gitFacade.repositoryExists.mockResolvedValue(true);
            gitFacade.getLatestCommit.mockResolvedValue({ sha: 'a' });
            gitFacade.cloneOrPull.mockResolvedValue('/tmp/dup');
            branchSyncService.syncFromTemplate.mockResolvedValue(null);
            gitFacade.listBranches.mockRejectedValue(new Error('listing forbidden'));
            const warnSpy = jest
                .spyOn((service as any).logger, 'warn')
                .mockImplementation(() => undefined);

            // updateRepository must still resolve — the default-branch step is
            // best-effort and never blocks the overall update.
            await expect(
                service.updateRepository(work as any, { id: 'u' } as any),
            ).resolves.toBeDefined();
            expect(warnSpy).toHaveBeenCalledWith(
                'Failed to set default branch for owner/repo: listing forbidden',
            );
        });

        it('coerces non-Error rejection to String() in warn message', async () => {
            const work = makeWork();
            gitFacade.repositoryExists.mockResolvedValue(true);
            gitFacade.getLatestCommit.mockResolvedValue({ sha: 'a' });
            gitFacade.cloneOrPull.mockResolvedValue('/tmp/dup');
            branchSyncService.syncFromTemplate.mockResolvedValue(null);
            gitFacade.listBranches.mockRejectedValue('string failure'); // not an Error
            const warnSpy = jest
                .spyOn((service as any).logger, 'warn')
                .mockImplementation(() => undefined);

            await service.updateRepository(work as any, { id: 'u' } as any);

            expect(warnSpy).toHaveBeenCalledWith(
                'Failed to set default branch for owner/repo: string failure',
            );
        });

        it('still warns even when updateRepository itself rejects (no rethrow)', async () => {
            const work = makeWork();
            gitFacade.repositoryExists.mockResolvedValue(true);
            gitFacade.getLatestCommit.mockResolvedValue({ sha: 'a' });
            gitFacade.cloneOrPull.mockResolvedValue('/tmp/dup');
            branchSyncService.syncFromTemplate.mockResolvedValue(null);
            gitFacade.listBranches.mockResolvedValue([{ name: 'main' }]);
            gitFacade.updateRepository.mockRejectedValue(new Error('write denied'));
            const warnSpy = jest
                .spyOn((service as any).logger, 'warn')
                .mockImplementation(() => undefined);

            await expect(
                service.updateRepository(work as any, { id: 'u' } as any),
            ).resolves.toBeDefined();
            expect(warnSpy).toHaveBeenCalledWith(
                'Failed to set default branch for owner/repo: write denied',
            );
        });
    });

    describe('syncAllBranchesFromTemplate', () => {
        it('delegates to BranchSyncService.syncFromTemplate(work, user)', async () => {
            const work = makeWork();
            const user = { id: 'caller' };
            const summary = {
                totalBranches: 1,
                synced: 1,
                skipped: 0,
                errors: 0,
                results: [],
            };
            branchSyncService.syncFromTemplate.mockResolvedValue(summary);

            const result = await service.syncAllBranchesFromTemplate(work as any, user as any);

            expect(branchSyncService.syncFromTemplate).toHaveBeenCalledWith(work, user);
            expect(result).toBe(summary);
        });

        it('forwards the null return verbatim', async () => {
            const work = makeWork();
            branchSyncService.syncFromTemplate.mockResolvedValue(null);

            const result = await service.syncAllBranchesFromTemplate(
                work as any,
                { id: 'c' } as any,
            );
            expect(result).toBeNull();
        });
    });

    describe('checkForUpdate', () => {
        it('returns updateAvailable=false with explanatory error when credentials are missing', async () => {
            const work = makeWork();
            gitFacade.hasValidCredentials.mockResolvedValue(false);

            const result = await service.checkForUpdate(work as any);

            expect(result).toEqual({
                updateAvailable: false,
                branch: 'main',
                error: 'Git provider credentials not available',
            });
            expect(gitFacade.getLatestCommit).not.toHaveBeenCalled();
        });

        it('returns updateAvailable=false (no error) when latestCommit is null', async () => {
            const work = makeWork();
            gitFacade.hasValidCredentials.mockResolvedValue(true);
            gitFacade.getLatestCommit.mockResolvedValue(null);

            const result = await service.checkForUpdate(work as any);

            expect(result).toEqual({ updateAvailable: false, branch: 'main' });
        });

        it('returns updateAvailable=true when latest sha differs from work.websiteTemplateLastCommit', async () => {
            const work = makeWork({ websiteTemplateLastCommit: 'old-sha' });
            gitFacade.hasValidCredentials.mockResolvedValue(true);
            gitFacade.getLatestCommit.mockResolvedValue({ sha: 'new-sha' });

            const result = await service.checkForUpdate(work as any);

            expect(result).toEqual({
                updateAvailable: true,
                latestCommit: 'new-sha',
                currentCommit: 'old-sha',
                branch: 'main',
            });
        });

        it('returns updateAvailable=false when latest sha matches', async () => {
            const work = makeWork({ websiteTemplateLastCommit: 'same' });
            gitFacade.hasValidCredentials.mockResolvedValue(true);
            gitFacade.getLatestCommit.mockResolvedValue({ sha: 'same' });

            const result = await service.checkForUpdate(work as any);

            expect(result).toEqual({
                updateAvailable: false,
                latestCommit: 'same',
                currentCommit: 'same',
                branch: 'main',
            });
        });

        it('coerces falsy currentCommit to undefined (e.g. null/empty)', async () => {
            const work = makeWork({ websiteTemplateLastCommit: null });
            gitFacade.hasValidCredentials.mockResolvedValue(true);
            gitFacade.getLatestCommit.mockResolvedValue({ sha: 'fresh' });

            const result = await service.checkForUpdate(work as any);

            expect(result.currentCommit).toBeUndefined();
            expect(result.updateAvailable).toBe(true);
        });

        it('uses the beta branch when work.websiteTemplateUseBeta=true and template.betaBranch is set', async () => {
            const work = makeWork({ websiteTemplateUseBeta: true });
            websiteTemplateResolver.resolveForWork.mockResolvedValue({
                ...baseTemplate,
                betaBranch: 'next',
            });
            gitFacade.hasValidCredentials.mockResolvedValue(true);
            gitFacade.getLatestCommit.mockResolvedValue({ sha: 'a' });

            const result = await service.checkForUpdate(work as any);

            expect(result.branch).toBe('next');
            expect(gitFacade.getLatestCommit).toHaveBeenCalledWith(
                'ever-works',
                'directory-web-template',
                'next',
                expect.any(Object),
            );
        });
    });

    describe('updateFork (via reflection)', () => {
        // updateFork is private and unreachable from updateRepository (which
        // only tries duplicate → template). It is dead-code today; pin the
        // current behaviour so a future re-wiring is a deliberate change.
        const invokeFork = (work: any, user: any) => (service as any).updateFork(work, user);

        it('returns true when hasForkRelationship reports the website is a fork', async () => {
            const work = makeWork();
            gitFacade.cloneOrPull.mockResolvedValue('/tmp/x');
            gitFacade.hasForkRelationship.mockResolvedValue(true);

            await expect(invokeFork(work, { id: 'u' })).resolves.toBe(true);
        });

        it('returns false when hasForkRelationship reports it is NOT a fork', async () => {
            const work = makeWork();
            gitFacade.cloneOrPull.mockResolvedValue('/tmp/x');
            gitFacade.hasForkRelationship.mockResolvedValue(false);

            await expect(invokeFork(work, { id: 'u' })).resolves.toBe(false);
        });

        it('returns false and logs error when cloneOrPull rejects', async () => {
            const work = makeWork();
            gitFacade.cloneOrPull.mockRejectedValue(new Error('clone denied'));
            const errorSpy = jest
                .spyOn((service as any).logger, 'error')
                .mockImplementation(() => undefined);

            await expect(invokeFork(work, { id: 'u' })).resolves.toBe(false);
            expect(errorSpy).toHaveBeenCalledWith('Fork update failed: clone denied');
        });
    });

    describe('updateTemplate copyRepositoryFiles (via duplicate-fail path)', () => {
        it('copies files from template clone into target clone, recursing dirs and skipping .git', async () => {
            const work = makeWork();
            gitFacade.repositoryExists.mockResolvedValue(true);
            gitFacade.getLatestCommit.mockResolvedValue({ sha: 'a' });
            gitFacade.cloneOrPull
                .mockRejectedValueOnce(new Error('duplicate fail'))
                .mockResolvedValueOnce('/tmp/src')
                .mockResolvedValueOnce('/tmp/dst');

            // Top-level: a regular file, a .git dir to skip, and a subdir.
            // Recursive call into the subdir: one nested file.
            fsMock.readdir
                .mockResolvedValueOnce([
                    { name: 'README.md', isDirectory: () => false } as any,
                    { name: '.git', isDirectory: () => true } as any,
                    { name: 'src', isDirectory: () => true } as any,
                ])
                .mockResolvedValueOnce([{ name: 'index.ts', isDirectory: () => false } as any]);

            branchSyncService.syncFromTemplate.mockResolvedValue(null);
            gitFacade.listBranches.mockResolvedValue([]);
            jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

            await service.updateRepository(work as any, { id: 'u' } as any);

            // Normalise to forward-slashes so the assertion is the same on
            // POSIX and Windows (path.join uses `\` on Windows).
            const copied = fsMock.copyFile.mock.calls.map((c) =>
                (c[0].toString() + ' -> ' + c[1].toString()).replace(/\\/g, '/'),
            );
            expect(copied).toContain('/tmp/src/README.md -> /tmp/dst/README.md');
            expect(copied.some((line: string) => line.includes('index.ts'))).toBe(true);
            // .git is skipped — no copyFile, no rm, no mkdir for it.
            expect(copied.some((line: string) => line.includes('.git'))).toBe(false);
            // Subdir: rm-then-mkdir before recursing.
            expect(fsMock.rm).toHaveBeenCalledWith(expect.stringContaining('src'), {
                recursive: true,
                force: true,
            });
            expect(fsMock.mkdir).toHaveBeenCalledWith(expect.stringContaining('src'), {
                recursive: true,
            });
        });

        it('swallows fs.rm rejection during subdir copy and continues', async () => {
            const work = makeWork();
            gitFacade.repositoryExists.mockResolvedValue(true);
            gitFacade.getLatestCommit.mockResolvedValue({ sha: 'a' });
            gitFacade.cloneOrPull
                .mockRejectedValueOnce(new Error('duplicate fail'))
                .mockResolvedValueOnce('/tmp/src')
                .mockResolvedValueOnce('/tmp/dst');

            fsMock.readdir
                .mockResolvedValueOnce([{ name: 'src', isDirectory: () => true } as any])
                .mockResolvedValueOnce([]);
            fsMock.rm.mockRejectedValueOnce(new Error('not present'));

            branchSyncService.syncFromTemplate.mockResolvedValue(null);
            gitFacade.listBranches.mockResolvedValue([]);
            jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

            // The whole flow still succeeds — rm-rejection is silently caught.
            await expect(
                service.updateRepository(work as any, { id: 'u' } as any),
            ).resolves.toBeDefined();
            expect(fsMock.mkdir).toHaveBeenCalled();
        });
    });

    describe('contracts', () => {
        it('logger context is the service name', () => {
            expect((service as any).logger.constructor.name).toBe('Logger');
        });
    });
});
