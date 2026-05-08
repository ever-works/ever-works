// Hoisted module mocks. The data-repository factory wraps `fs-extra` +
// `isomorphic-git` under the hood, so any spec that exercises
// `ItemSubmissionService` MUST stub it before the SUT import — otherwise
// the import graph pulls real disk + git operations into Jest.
jest.mock('../generators/data-generator/data-repository', () => {
    return {
        DataRepository: {
            create: jest.fn(),
        },
    };
});

import { ItemSubmissionService } from './item-submission.service';
import { DataRepository } from '../generators/data-generator/data-repository';

const dataRepoCreateMock = DataRepository.create as jest.Mock;

interface UserLike {
    id: string;
    username?: string;
    email?: string;
}

interface WorkLike {
    id: string;
    slug: string;
    user: UserLike;
    gitProvider: string;
    getDataRepo: jest.Mock<string, []>;
    getRepoOwner: jest.Mock<string, [string?]>;
    resolveCommitter: jest.Mock<{ name: string; email: string }, [UserLike]>;
}

function makeWork(overrides: Partial<WorkLike> = {}): WorkLike {
    return {
        id: 'work-1',
        slug: 'best-tools',
        user: { id: 'owner-1', username: 'octocat', email: 'octo@example.com' },
        gitProvider: 'github',
        getDataRepo: jest.fn().mockReturnValue('best-tools-data'),
        getRepoOwner: jest.fn().mockReturnValue('acme'),
        resolveCommitter: jest.fn().mockReturnValue({
            name: 'Octocat',
            email: 'octo@example.com',
        }),
        ...overrides,
    };
}

function makeUser(overrides: Partial<UserLike> = {}): UserLike {
    return {
        id: 'submitter-1',
        username: 'submitter',
        email: 'submitter@example.com',
        ...overrides,
    };
}

function makeGitFacade(overrides: Record<string, jest.Mock> = {}) {
    return {
        cloneOrPull: jest.fn().mockResolvedValue('/tmp/work-1/data'),
        getMainBranch: jest.fn().mockResolvedValue('main'),
        switchBranch: jest.fn(async (_p: string, _d: string, branch: string) => branch),
        add: jest.fn().mockResolvedValue(undefined),
        addAll: jest.fn().mockResolvedValue(undefined),
        commit: jest.fn().mockResolvedValue('sha-1'),
        push: jest.fn().mockResolvedValue(undefined),
        createPullRequest: jest.fn().mockResolvedValue({
            number: 7,
            url: 'https://github.com/acme/best-tools-data/pull/7',
        }),
        ...overrides,
    };
}

function makeScreenshotFacade(
    overrides: Partial<{ isAvailable: jest.Mock; capture: jest.Mock }> = {},
) {
    return {
        isAvailable: jest.fn().mockReturnValue(false),
        capture: jest.fn(),
        ...overrides,
    };
}

function makeDataRepoMock(
    overrides: Partial<{
        getConfig: jest.Mock;
        createItemDir: jest.Mock;
        writeItem: jest.Mock;
        writeItemMarkdown: jest.Mock;
        itemExists: jest.Mock;
        getItem: jest.Mock;
        removeItem: jest.Mock;
        updateItemMetadata: jest.Mock;
    }> = {},
) {
    return {
        getConfig: jest.fn().mockResolvedValue({ autoapproval: false }),
        createItemDir: jest.fn().mockResolvedValue(undefined),
        writeItem: jest.fn().mockResolvedValue(undefined),
        writeItemMarkdown: jest.fn().mockResolvedValue(undefined),
        itemExists: jest.fn().mockResolvedValue(true),
        getItem: jest.fn(),
        removeItem: jest.fn().mockResolvedValue(true),
        updateItemMetadata: jest.fn(),
        ...overrides,
    };
}

function makeService(gitFacade = makeGitFacade(), screenshotFacade = makeScreenshotFacade()) {
    const service = new ItemSubmissionService(gitFacade as any, screenshotFacade as any);
    return { service, gitFacade, screenshotFacade };
}

describe('ItemSubmissionService', () => {
    beforeEach(() => {
        dataRepoCreateMock.mockReset();
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-05-08T12:00:00Z'));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('submitItem', () => {
        it('clones using work-owner credentials but writes the submitter as the committer', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const work = makeWork();
            const submitter = makeUser({ id: 'submitter-1' });
            const { service, gitFacade } = makeService();

            await service.submitItem(
                work as any,
                submitter as any,
                {
                    name: 'Tool A',
                    description: 'A tool',
                    source_url: 'https://example.com',
                    category: 'AI',
                } as any,
            );

            // Clone should use the WORK OWNER's userId, NOT the submitter's.
            expect(gitFacade.cloneOrPull).toHaveBeenCalledWith(
                {
                    owner: 'acme',
                    repo: 'best-tools-data',
                    committer: { name: 'Octocat', email: 'octo@example.com' },
                },
                {
                    userId: 'owner-1',
                    providerId: 'github',
                    workId: 'work-1',
                },
            );
            // resolveCommitter is called with the SUBMITTER for clone-time committer
            // AND for the actual git commit author later.
            expect(work.resolveCommitter).toHaveBeenCalledWith(submitter);
        });

        it('creates a PR by default when neither pay_and_publish_now nor autoapproval is set', async () => {
            const dataRepo = makeDataRepoMock({
                getConfig: jest.fn().mockResolvedValue({ autoapproval: false }),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            const result = await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                } as any,
            );

            // A new branch is created when shouldCreatePR is true.
            expect(gitFacade.switchBranch).toHaveBeenCalledWith(
                'github',
                '/tmp/work-1/data',
                expect.stringMatching(/^item-tool-a-\d+$/),
                true,
            );
            expect(gitFacade.createPullRequest).toHaveBeenCalled();
            expect(result.status).toBe('success');
            expect(result.pr_number).toBe(7);
            expect(result.auto_merged).toBe(false);
            expect(result.direct_commit).toBeUndefined();
        });

        it('commits directly to main when pay_and_publish_now is true', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            const result = await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                    pay_and_publish_now: true,
                } as any,
            );

            // Direct-commit path: switch to main, NOT a feature branch.
            expect(gitFacade.switchBranch).toHaveBeenCalledWith(
                'github',
                '/tmp/work-1/data',
                'main',
            );
            expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
            expect(result.status).toBe('success');
            expect(result.direct_commit).toBe(true);
            expect(result.message).toContain('committed directly to main');
            expect(result.pr_number).toBeUndefined();
        });

        it('commits directly to main when config.autoapproval is true', async () => {
            const dataRepo = makeDataRepoMock({
                getConfig: jest.fn().mockResolvedValue({ autoapproval: true }),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            const result = await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                } as any,
            );

            expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
            expect(result.direct_commit).toBe(true);
        });

        it('forces PR mode when create_pull_request is true (overrides autoapproval AND pay_and_publish_now)', async () => {
            const dataRepo = makeDataRepoMock({
                getConfig: jest.fn().mockResolvedValue({ autoapproval: true }),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            const result = await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                    pay_and_publish_now: true,
                    create_pull_request: true,
                } as any,
            );

            // Even though autoapproval AND pay_and_publish_now are true,
            // an explicit create_pull_request:true wins.
            expect(gitFacade.createPullRequest).toHaveBeenCalledTimes(1);
            expect(result.direct_commit).toBeUndefined();
            expect(result.pr_number).toBe(7);
        });

        it('treats getConfig() rejection as null (default branch: PR)', async () => {
            const dataRepo = makeDataRepoMock({
                getConfig: jest.fn().mockRejectedValue(new Error('config missing')),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            const result = await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                } as any,
            );

            // No autoapproval available → falls back to PR mode.
            expect(gitFacade.createPullRequest).toHaveBeenCalled();
            expect(result.status).toBe('success');
        });

        it('uses categories[] when provided, falling back to category when categories is empty', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service } = makeService();

            await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    categories: ['AI', 'Dev'],
                    category: 'Ignored',
                } as any,
            );

            expect(dataRepo.writeItem).toHaveBeenCalledWith(
                expect.objectContaining({ category: ['AI', 'Dev'] }),
            );
        });

        it('falls back to single category string when categories is an empty array', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service } = makeService();

            await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    categories: [],
                    category: 'AI',
                } as any,
            );

            expect(dataRepo.writeItem).toHaveBeenCalledWith(
                expect.objectContaining({ category: 'AI' }),
            );
        });

        it('uses provided slug when set, otherwise slugifies name', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service } = makeService();

            await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'A Cool Tool!',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                } as any,
            );

            expect(dataRepo.writeItem).toHaveBeenCalledWith(
                expect.objectContaining({ slug: 'a-cool-tool' }),
            );
        });

        it('passes through caller-supplied slug verbatim', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service } = makeService();

            await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Anything',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                    slug: 'my-explicit-slug',
                } as any,
            );

            expect(dataRepo.writeItem).toHaveBeenCalledWith(
                expect.objectContaining({ slug: 'my-explicit-slug' }),
            );
        });

        it('captures a screenshot when screenshotFacade.isAvailable() is true and prepends to images', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const captureMock = jest.fn().mockResolvedValue({
                success: true,
                cacheUrl: 'https://cache.example.com/abc.png',
            });
            const screenshotFacade = makeScreenshotFacade({
                isAvailable: jest.fn().mockReturnValue(true),
                capture: captureMock,
            });
            const { service } = makeService(undefined, screenshotFacade);

            await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                    images: ['https://existing.png'],
                } as any,
            );

            expect(captureMock).toHaveBeenCalledWith(
                {
                    url: 'https://example.com',
                    blockAds: true,
                    blockCookieBanners: true,
                    cache: true,
                },
                { userId: 'owner-1', workId: 'work-1' },
            );
            // Screenshot URL is PREPENDED — not appended.
            expect(dataRepo.writeItem).toHaveBeenCalledWith(
                expect.objectContaining({
                    images: ['https://cache.example.com/abc.png', 'https://existing.png'],
                }),
            );
        });

        it('does not duplicate the screenshot URL when images[] already contains it', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const screenshotFacade = makeScreenshotFacade({
                isAvailable: jest.fn().mockReturnValue(true),
                capture: jest.fn().mockResolvedValue({
                    success: true,
                    cacheUrl: 'https://cache.example.com/abc.png',
                }),
            });
            const { service } = makeService(undefined, screenshotFacade);

            await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                    images: ['https://cache.example.com/abc.png', 'https://other.png'],
                } as any,
            );

            const written = dataRepo.writeItem.mock.calls[0][0] as { images: string[] };
            expect(written.images).toEqual([
                'https://cache.example.com/abc.png',
                'https://other.png',
            ]);
        });

        it('skips screenshot capture when isAvailable() returns false', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const captureMock = jest.fn();
            const screenshotFacade = makeScreenshotFacade({
                isAvailable: jest.fn().mockReturnValue(false),
                capture: captureMock,
            });
            const { service } = makeService(undefined, screenshotFacade);

            await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                } as any,
            );

            expect(captureMock).not.toHaveBeenCalled();
        });

        it('skips screenshot capture when source_url is missing', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const captureMock = jest.fn();
            const screenshotFacade = makeScreenshotFacade({
                isAvailable: jest.fn().mockReturnValue(true),
                capture: captureMock,
            });
            const { service } = makeService(undefined, screenshotFacade);

            await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: '',
                    category: 'AI',
                } as any,
            );

            expect(captureMock).not.toHaveBeenCalled();
        });

        it('continues when screenshot capture rejects (warn-only, no rethrow)', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const screenshotFacade = makeScreenshotFacade({
                isAvailable: jest.fn().mockReturnValue(true),
                capture: jest.fn().mockRejectedValue(new Error('upstream 500')),
            });
            const { service } = makeService(undefined, screenshotFacade);

            const result = await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                } as any,
            );

            // Should still succeed — screenshot is best-effort.
            expect(result.status).toBe('success');
            expect(dataRepo.writeItem).toHaveBeenCalled();
        });

        it('does not modify images when screenshot capture returns success:false', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const screenshotFacade = makeScreenshotFacade({
                isAvailable: jest.fn().mockReturnValue(true),
                capture: jest.fn().mockResolvedValue({ success: false }),
            });
            const { service } = makeService(undefined, screenshotFacade);

            await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                } as any,
            );

            const written = dataRepo.writeItem.mock.calls[0][0] as { images: string[] };
            expect(written.images).toEqual([]);
        });

        it('writes a default markdown body when none is provided', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service } = makeService();

            await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'A short description',
                    source_url: 'https://example.com',
                    category: 'AI',
                } as any,
            );

            expect(dataRepo.writeItemMarkdown).toHaveBeenCalledWith(
                expect.any(Object),
                expect.stringContaining('# Tool A'),
            );
            expect(dataRepo.writeItemMarkdown.mock.calls[0][1]).toContain('A short description');
            expect(dataRepo.writeItemMarkdown.mock.calls[0][1]).toContain(
                '[https://example.com](https://example.com)',
            );
        });

        it('passes through DTO with positional shape: cloneOrPull → DataRepository.create → getConfig', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                } as any,
            );

            expect(gitFacade.cloneOrPull).toHaveBeenCalledTimes(1);
            expect(dataRepoCreateMock).toHaveBeenCalledWith('/tmp/work-1/data');
            expect(dataRepo.getConfig).toHaveBeenCalled();
        });

        it('commits with `Add <name>` message and pushes with workOwner identity (PR path)', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const work = makeWork();
            const { service, gitFacade } = makeService();

            await service.submitItem(
                work as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                } as any,
            );

            expect(gitFacade.add).toHaveBeenCalledWith('github', '/tmp/work-1/data', '.');
            expect(gitFacade.commit).toHaveBeenCalledWith(
                'github',
                '/tmp/work-1/data',
                'Add Tool A',
                { name: 'Octocat', email: 'octo@example.com' },
            );
            expect(gitFacade.push).toHaveBeenCalledWith(
                { dir: '/tmp/work-1/data' },
                {
                    userId: 'owner-1',
                    providerId: 'github',
                    workId: 'work-1',
                },
            );
        });

        it('builds PR title with date-fns format MM/dd/yyyy HH:mm', async () => {
            jest.setSystemTime(new Date('2026-05-08T12:34:00Z'));
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'My Tool',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                } as any,
            );

            const prCall = gitFacade.createPullRequest.mock.calls[0][0];
            // The exact HH:mm depends on the runner timezone (date-fns
            // formats in local time), so only pin the structural shape.
            expect(prCall.title).toMatch(/^Add My Tool - \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
        });

        it('includes badge information in PR body when item has badges', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepo.writeItem = jest.fn(async (item: any) => {
                // Mutate the item to inject badges before the PR body is built.
                item.badges = {
                    security: { value: 'A+', details: 'green' },
                    license: { value: 'MIT' },
                    quality: { value: '95', details: 'lints clean' },
                };
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                } as any,
            );

            const prCall = gitFacade.createPullRequest.mock.calls[0][0];
            expect(prCall.body).toContain('**Badges:**');
            expect(prCall.body).toContain('- Security: A+ (green)');
            expect(prCall.body).toContain('- License: MIT');
            expect(prCall.body).toContain('- Quality: 95 (lints clean)');
        });

        it('omits the badges section from PR body when item has no badges', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                } as any,
            );

            const prCall = gitFacade.createPullRequest.mock.calls[0][0];
            expect(prCall.body).not.toContain('**Badges:**');
        });

        it('includes brand and brand_logo_url in PR body only when present', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                    brand: 'AcmeCo',
                    brand_logo_url: 'https://acme.com/logo.png',
                } as any,
            );

            const body = gitFacade.createPullRequest.mock.calls[0][0].body as string;
            expect(body).toContain('**Brand:** AcmeCo');
            expect(body).toContain('**Brand Logo:** https://acme.com/logo.png');
        });

        it('joins tags with ", " in PR body, falling back to empty string for non-array tags', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                    tags: ['ai', 'productivity'],
                } as any,
            );

            const body = gitFacade.createPullRequest.mock.calls[0][0].body as string;
            expect(body).toContain('**Tags:** ai, productivity');
        });

        it('forwards createPullRequest with workOwner.id (NOT submitter.id) in options', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const work = makeWork();
            const submitter = makeUser({ id: 'submitter-1' });
            const { service, gitFacade } = makeService();

            await service.submitItem(
                work as any,
                submitter as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                } as any,
            );

            const opts = gitFacade.createPullRequest.mock.calls[0][1];
            expect(opts).toEqual({
                userId: 'owner-1',
                providerId: 'github',
                workId: 'work-1',
            });
        });

        it('returns success envelope with pr_number/pr_url/branch_name in PR mode', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service } = makeService();

            const result = await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                } as any,
            );

            expect(result.status).toBe('success');
            expect(result.pr_number).toBe(7);
            expect(result.pr_url).toBe('https://github.com/acme/best-tools-data/pull/7');
            expect(result.pr_branch_name).toMatch(/^item-tool-a-/);
            expect(result.auto_merged).toBe(false);
            expect(result.item).toEqual(expect.objectContaining({ name: 'Tool A' }));
        });

        it('returns success envelope with direct_commit:true and message mentioning the default branch (direct mode)', async () => {
            const dataRepo = makeDataRepoMock({
                getConfig: jest.fn().mockResolvedValue({ autoapproval: true }),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service } = makeService(
                makeGitFacade({
                    getMainBranch: jest.fn().mockResolvedValue('trunk'),
                }),
            );

            const result = await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                } as any,
            );

            expect(result.direct_commit).toBe(true);
            expect(result.message).toContain('trunk');
        });

        it('throws-wrapper: any error inside submitItem returns {status:"error", message}', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = makeGitFacade({
                cloneOrPull: jest.fn().mockRejectedValue(new Error('boom: clone failed')),
            });
            const { service } = makeService(gitFacade);

            const result = await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                } as any,
            );

            expect(result.status).toBe('error');
            expect(result.message).toBe('boom: clone failed');
            expect(result.item_name).toBe('Tool A');
            expect(result.slug).toBe('best-tools');
        });

        it('rethrow→error envelope when switching to main branch fails in direct-commit mode', async () => {
            const dataRepo = makeDataRepoMock({
                getConfig: jest.fn().mockResolvedValue({ autoapproval: true }),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = makeGitFacade({
                switchBranch: jest.fn().mockRejectedValue(new Error('fs locked')),
            });
            const { service } = makeService(gitFacade);

            const result = await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                } as any,
            );

            expect(result.status).toBe('error');
            expect(result.message).toBe('Failed to switch to main branch for direct commit');
        });

        it('skips switchBranch in direct-commit mode when defaultBranch is null (graceful no-op)', async () => {
            const dataRepo = makeDataRepoMock({
                getConfig: jest.fn().mockResolvedValue({ autoapproval: true }),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = makeGitFacade({
                getMainBranch: jest.fn().mockResolvedValue(null),
            });
            const { service } = makeService(gitFacade);

            const result = await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Tool A',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                } as any,
            );

            // No switchBranch call (defaultBranch was null), but the rest
            // of the path still runs and returns success.
            expect(gitFacade.switchBranch).not.toHaveBeenCalled();
            expect(result.status).toBe('success');
            expect(result.direct_commit).toBe(true);
        });

        it('uses the slugified name when caller-supplied slug becomes empty after slugification', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service } = makeService();

            // submitItemDto.slug is provided but empty → falls back to slugifyText(name).
            // Then writeItem path runs slugifyText(itemWithMarkdown.slug || itemWithMarkdown.name)
            // again, which preserves the value.
            await service.submitItem(
                makeWork() as any,
                makeUser() as any,
                {
                    name: 'Real Name',
                    description: 'desc',
                    source_url: 'https://example.com',
                    category: 'AI',
                    slug: '',
                } as any,
            );

            expect(dataRepo.writeItem).toHaveBeenCalledWith(
                expect.objectContaining({ slug: 'real-name' }),
            );
        });
    });

    describe('removeItem', () => {
        it('returns error envelope when item does not exist', async () => {
            const dataRepo = makeDataRepoMock({
                itemExists: jest.fn().mockResolvedValue(false),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service } = makeService();

            const result = await service.removeItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'missing' } as any,
            );

            expect(result.status).toBe('error');
            expect(result.message).toContain("'missing' not found");
            expect(result.item_name).toBe('Unknown');
            expect(result.item_slug).toBe('missing');
        });

        it('returns error envelope when getItem returns null even after itemExists==true', async () => {
            const dataRepo = makeDataRepoMock({
                itemExists: jest.fn().mockResolvedValue(true),
                getItem: jest.fn().mockResolvedValue(null),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service } = makeService();

            const result = await service.removeItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'flaky' } as any,
            );

            expect(result.status).toBe('error');
            expect(result.message).toContain('Failed to retrieve item details');
        });

        it('returns error envelope when removeItem itself returns false', async () => {
            const dataRepo = makeDataRepoMock({
                itemExists: jest.fn().mockResolvedValue(true),
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                    category: 'AI',
                }),
                removeItem: jest.fn().mockResolvedValue(false),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service } = makeService();

            const result = await service.removeItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'tool-a' } as any,
            );

            expect(result.status).toBe('error');
            expect(result.item_name).toBe('Tool A');
            expect(result.message).toContain("Failed to remove item 'tool-a'");
        });

        it('commits to main directly when create_pull_request is not true', async () => {
            const dataRepo = makeDataRepoMock({
                itemExists: jest.fn().mockResolvedValue(true),
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                    category: 'AI',
                }),
                removeItem: jest.fn().mockResolvedValue(true),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            const result = await service.removeItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'tool-a' } as any,
            );

            // switchBranch is called with 'main' (NOT a remove- branch).
            expect(gitFacade.switchBranch).toHaveBeenCalledWith(
                'github',
                '/tmp/work-1/data',
                'main',
            );
            expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
            expect(result.status).toBe('success');
            expect(result.pr_number).toBeUndefined();
            expect(result.message).toContain('removed successfully');
        });

        it('creates a PR when create_pull_request is true, with `remove-<slug>-<ts>` branch', async () => {
            const dataRepo = makeDataRepoMock({
                itemExists: jest.fn().mockResolvedValue(true),
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                    category: 'AI',
                }),
                removeItem: jest.fn().mockResolvedValue(true),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            const result = await service.removeItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'tool-a', create_pull_request: true } as any,
            );

            expect(gitFacade.switchBranch).toHaveBeenCalledWith(
                'github',
                '/tmp/work-1/data',
                expect.stringMatching(/^remove-tool-a-\d+$/),
                true,
            );
            expect(gitFacade.createPullRequest).toHaveBeenCalled();
            expect(result.status).toBe('success');
            expect(result.pr_number).toBe(7);
            expect(result.pr_branch_name).toMatch(/^remove-tool-a-/);
        });

        it('uses commit message `Remove <name> - <reason>` when reason is provided', async () => {
            const dataRepo = makeDataRepoMock({
                itemExists: jest.fn().mockResolvedValue(true),
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                    category: 'AI',
                }),
                removeItem: jest.fn().mockResolvedValue(true),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            await service.removeItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'tool-a', reason: 'spam' } as any,
            );

            expect(gitFacade.commit).toHaveBeenCalledWith(
                'github',
                '/tmp/work-1/data',
                'Remove Tool A - spam',
                expect.any(Object),
            );
        });

        it('uses bare `Remove <name>` commit message when no reason is provided', async () => {
            const dataRepo = makeDataRepoMock({
                itemExists: jest.fn().mockResolvedValue(true),
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                    category: 'AI',
                }),
                removeItem: jest.fn().mockResolvedValue(true),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            await service.removeItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'tool-a' } as any,
            );

            expect(gitFacade.commit).toHaveBeenCalledWith(
                'github',
                '/tmp/work-1/data',
                'Remove Tool A',
                expect.any(Object),
            );
        });

        it('PR body includes the reason when provided, omits it otherwise', async () => {
            const dataRepo = makeDataRepoMock({
                itemExists: jest.fn().mockResolvedValue(true),
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                    category: 'AI',
                }),
                removeItem: jest.fn().mockResolvedValue(true),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            await service.removeItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'tool-a', reason: 'spam', create_pull_request: true } as any,
            );

            const body = gitFacade.createPullRequest.mock.calls[0][0].body as string;
            expect(body).toContain('**Reason:** spam');
        });

        it('PR body omits Reason when reason is missing', async () => {
            const dataRepo = makeDataRepoMock({
                itemExists: jest.fn().mockResolvedValue(true),
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                    category: 'AI',
                }),
                removeItem: jest.fn().mockResolvedValue(true),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            await service.removeItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'tool-a', create_pull_request: true } as any,
            );

            const body = gitFacade.createPullRequest.mock.calls[0][0].body as string;
            expect(body).not.toContain('**Reason:**');
        });

        it('uses addAll (NOT add) for staging changes', async () => {
            const dataRepo = makeDataRepoMock({
                itemExists: jest.fn().mockResolvedValue(true),
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                    category: 'AI',
                }),
                removeItem: jest.fn().mockResolvedValue(true),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            await service.removeItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'tool-a' } as any,
            );

            expect(gitFacade.addAll).toHaveBeenCalledWith('github', '/tmp/work-1/data');
            expect(gitFacade.add).not.toHaveBeenCalled();
        });

        it('swallows switch-to-main error in direct-commit mode (does NOT abort)', async () => {
            const dataRepo = makeDataRepoMock({
                itemExists: jest.fn().mockResolvedValue(true),
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                    category: 'AI',
                }),
                removeItem: jest.fn().mockResolvedValue(true),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = makeGitFacade({
                switchBranch: jest.fn().mockRejectedValue(new Error('fs locked')),
            });
            const { service } = makeService(gitFacade);

            const result = await service.removeItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'tool-a' } as any,
            );

            // switchBranch failure is logged & swallowed (.catch returns null) —
            // the removal still proceeds and succeeds.
            expect(result.status).toBe('success');
        });

        it('returns generic error envelope when an outer step throws (e.g. cloneOrPull)', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = makeGitFacade({
                cloneOrPull: jest.fn().mockRejectedValue(new Error('clone exploded')),
            });
            const { service } = makeService(gitFacade);

            const result = await service.removeItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'tool-a' } as any,
            );

            expect(result.status).toBe('error');
            expect(result.item_name).toBe('Unknown');
            expect(result.item_slug).toBe('tool-a');
            expect(result.message).toBe('clone exploded');
        });
    });

    describe('updateItem', () => {
        it('returns error envelope when existingItem is null', async () => {
            const dataRepo = makeDataRepoMock({
                getItem: jest.fn().mockResolvedValue(null),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service } = makeService();

            const result = await service.updateItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'missing', featured: true } as any,
            );

            expect(result.status).toBe('error');
            expect(result.message).toContain("'missing' not found");
        });

        it('returns error envelope when getItem rejects (caught → null)', async () => {
            const dataRepo = makeDataRepoMock({
                getItem: jest.fn().mockRejectedValue(new Error('disk error')),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service } = makeService();

            const result = await service.updateItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'tool-a' } as any,
            );

            expect(result.status).toBe('error');
            expect(result.message).toContain("'tool-a' not found");
        });

        it('returns error envelope when updateItemMetadata returns null', async () => {
            const dataRepo = makeDataRepoMock({
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                    featured: false,
                    order: 0,
                }),
                updateItemMetadata: jest.fn().mockResolvedValue(null),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service } = makeService();

            const result = await service.updateItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'tool-a', featured: true } as any,
            );

            expect(result.status).toBe('error');
            expect(result.message).toContain("Failed to update item 'tool-a'");
        });

        it('passes only the explicitly-set fields into updateItemMetadata', async () => {
            const dataRepo = makeDataRepoMock({
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://old.example.com',
                    featured: false,
                    order: 0,
                }),
                updateItemMetadata: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://old.example.com',
                    featured: true,
                    order: 5,
                }),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service } = makeService();

            await service.updateItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'tool-a', featured: true, order: 5 } as any,
            );

            expect(dataRepo.updateItemMetadata).toHaveBeenCalledWith('tool-a', {
                featured: true,
                order: 5,
            });
        });

        it('treats order:null as "not provided" (does NOT include in updates)', async () => {
            const dataRepo = makeDataRepoMock({
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://old.example.com',
                    featured: false,
                    order: 7,
                }),
                updateItemMetadata: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://old.example.com',
                    featured: true,
                    order: 7,
                }),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service } = makeService();

            await service.updateItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'tool-a', featured: true, order: null } as any,
            );

            expect(dataRepo.updateItemMetadata).toHaveBeenCalledWith('tool-a', {
                featured: true,
            });
            // order field should NOT be present in the update payload.
            expect(
                Object.prototype.hasOwnProperty.call(
                    dataRepo.updateItemMetadata.mock.calls[0][1],
                    'order',
                ),
            ).toBe(false);
        });

        it('clears health + source_validation when source_url changes from existing', async () => {
            const dataRepo = makeDataRepoMock({
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://old.example.com',
                }),
                updateItemMetadata: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://new.example.com',
                    featured: false,
                }),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service } = makeService();

            await service.updateItem(
                makeWork() as any,
                makeUser() as any,
                {
                    item_slug: 'tool-a',
                    source_url: 'https://new.example.com',
                } as any,
            );

            expect(dataRepo.updateItemMetadata).toHaveBeenCalledWith('tool-a', {
                source_url: 'https://new.example.com',
                health: { status: 'unchecked' },
                source_validation: undefined,
            });
        });

        it('does NOT clear health when source_url is repeated identically', async () => {
            const dataRepo = makeDataRepoMock({
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                }),
                updateItemMetadata: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                    featured: true,
                }),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service } = makeService();

            await service.updateItem(
                makeWork() as any,
                makeUser() as any,
                {
                    item_slug: 'tool-a',
                    source_url: 'https://example.com',
                    featured: true,
                } as any,
            );

            const update = dataRepo.updateItemMetadata.mock.calls[0][1] as Record<string, unknown>;
            expect(update.source_url).toBe('https://example.com');
            expect(update.health).toBeUndefined();
            expect(Object.prototype.hasOwnProperty.call(update, 'health')).toBe(false);
        });

        it('uses commit message "Update <name> source" when sourceUrlChanged', async () => {
            const dataRepo = makeDataRepoMock({
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://old.example.com',
                }),
                updateItemMetadata: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://new.example.com',
                }),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            await service.updateItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'tool-a', source_url: 'https://new.example.com' } as any,
            );

            expect(gitFacade.commit).toHaveBeenCalledWith(
                'github',
                '/tmp/work-1/data',
                'Update Tool A source',
                expect.any(Object),
            );
        });

        it('uses commit message "Update <name> metadata" when source_url is unchanged', async () => {
            const dataRepo = makeDataRepoMock({
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                }),
                updateItemMetadata: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                    featured: true,
                }),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            await service.updateItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'tool-a', featured: true } as any,
            );

            expect(gitFacade.commit).toHaveBeenCalledWith(
                'github',
                '/tmp/work-1/data',
                'Update Tool A metadata',
                expect.any(Object),
            );
        });

        it('creates a PR with `update-<slug>-<ts>` branch when create_pull_request is true', async () => {
            const dataRepo = makeDataRepoMock({
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                }),
                updateItemMetadata: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                    featured: true,
                    order: 3,
                }),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            const result = await service.updateItem(
                makeWork() as any,
                makeUser() as any,
                {
                    item_slug: 'tool-a',
                    featured: true,
                    order: 3,
                    create_pull_request: true,
                } as any,
            );

            expect(gitFacade.switchBranch).toHaveBeenCalledWith(
                'github',
                '/tmp/work-1/data',
                expect.stringMatching(/^update-tool-a-\d+$/),
                true,
            );
            expect(gitFacade.createPullRequest).toHaveBeenCalled();
            expect(result.status).toBe('success');
            expect(result.pr_number).toBe(7);
            expect(result.pr_branch_name).toMatch(/^update-tool-a-/);
        });

        it('PR title differs based on sourceUrlChanged: "Update source for X" vs "Update X"', async () => {
            const dataRepo = makeDataRepoMock({
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://old.example.com',
                }),
                updateItemMetadata: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://new.example.com',
                }),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            await service.updateItem(
                makeWork() as any,
                makeUser() as any,
                {
                    item_slug: 'tool-a',
                    source_url: 'https://new.example.com',
                    create_pull_request: true,
                } as any,
            );

            const prCall = gitFacade.createPullRequest.mock.calls[0][0];
            expect(prCall.title).toMatch(/^Update source for Tool A - \d{2}\/\d{2}\/\d{4}/);
            expect(prCall.body.startsWith('Update item source')).toBe(true);
        });

        it('PR body when no source change uses "Update item metadata" prefix', async () => {
            const dataRepo = makeDataRepoMock({
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                }),
                updateItemMetadata: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                    featured: true,
                    order: 0,
                }),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            await service.updateItem(
                makeWork() as any,
                makeUser() as any,
                {
                    item_slug: 'tool-a',
                    featured: true,
                    create_pull_request: true,
                } as any,
            );

            const body = gitFacade.createPullRequest.mock.calls[0][0].body as string;
            expect(body.startsWith('Update item metadata')).toBe(true);
        });

        it('PR body shows "Order: n/a" when updatedItem.order is null/undefined', async () => {
            const dataRepo = makeDataRepoMock({
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                }),
                updateItemMetadata: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                    featured: true,
                    order: undefined,
                }),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            await service.updateItem(
                makeWork() as any,
                makeUser() as any,
                {
                    item_slug: 'tool-a',
                    featured: true,
                    create_pull_request: true,
                } as any,
            );

            const body = gitFacade.createPullRequest.mock.calls[0][0].body as string;
            expect(body).toContain('**Order:** n/a');
        });

        it('PR body coerces falsy `featured` to "false" via String(!!...)', async () => {
            const dataRepo = makeDataRepoMock({
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                }),
                updateItemMetadata: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                    featured: false,
                    order: 1,
                }),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            await service.updateItem(
                makeWork() as any,
                makeUser() as any,
                {
                    item_slug: 'tool-a',
                    featured: false,
                    create_pull_request: true,
                } as any,
            );

            const body = gitFacade.createPullRequest.mock.calls[0][0].body as string;
            expect(body).toContain('**Featured:** false');
        });

        it('returns success envelope with sourceUrlChanged-flavored message in direct-commit mode', async () => {
            const dataRepo = makeDataRepoMock({
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://old.example.com',
                }),
                updateItemMetadata: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://new.example.com',
                }),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service } = makeService();

            const result = await service.updateItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'tool-a', source_url: 'https://new.example.com' } as any,
            );

            expect(result.status).toBe('success');
            expect(result.message).toContain('source updated');
            expect(result.pr_number).toBeUndefined();
        });

        it('returns success envelope with metadata-flavored message in direct-commit mode', async () => {
            const dataRepo = makeDataRepoMock({
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                }),
                updateItemMetadata: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                    featured: true,
                }),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service } = makeService();

            const result = await service.updateItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'tool-a', featured: true } as any,
            );

            expect(result.status).toBe('success');
            expect(result.message).toContain('metadata updated');
        });

        it('uses addAll for staging changes', async () => {
            const dataRepo = makeDataRepoMock({
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                }),
                updateItemMetadata: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                    featured: true,
                }),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const { service, gitFacade } = makeService();

            await service.updateItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'tool-a', featured: true } as any,
            );

            expect(gitFacade.addAll).toHaveBeenCalledWith('github', '/tmp/work-1/data');
            expect(gitFacade.add).not.toHaveBeenCalled();
        });

        it('forwards push with workOwner identity (NOT submitter)', async () => {
            const dataRepo = makeDataRepoMock({
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                }),
                updateItemMetadata: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                    featured: true,
                }),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const submitter = makeUser({ id: 'submitter-9' });
            const { service, gitFacade } = makeService();

            await service.updateItem(
                makeWork() as any,
                submitter as any,
                { item_slug: 'tool-a', featured: true } as any,
            );

            expect(gitFacade.push).toHaveBeenCalledWith(
                { dir: '/tmp/work-1/data' },
                {
                    userId: 'owner-1',
                    providerId: 'github',
                    workId: 'work-1',
                },
            );
        });

        it('returns generic error envelope when an outer step throws (e.g. cloneOrPull)', async () => {
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = makeGitFacade({
                cloneOrPull: jest.fn().mockRejectedValue(new Error('clone failed')),
            });
            const { service } = makeService(gitFacade);

            const result = await service.updateItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'tool-a', featured: true } as any,
            );

            expect(result.status).toBe('error');
            expect(result.item_name).toBe('Unknown');
            expect(result.message).toBe('clone failed');
        });

        it('swallows switch-to-main error in direct-commit mode (does NOT abort)', async () => {
            const dataRepo = makeDataRepoMock({
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                }),
                updateItemMetadata: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                    featured: true,
                }),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = makeGitFacade({
                switchBranch: jest.fn().mockRejectedValue(new Error('fs locked')),
            });
            const { service } = makeService(gitFacade);

            const result = await service.updateItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'tool-a', featured: true } as any,
            );

            // switchBranch failure on direct-commit branch is logged & swallowed.
            expect(result.status).toBe('success');
        });

        it('skips switchBranch entirely when defaultBranch is null and PR is not requested', async () => {
            const dataRepo = makeDataRepoMock({
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                }),
                updateItemMetadata: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                    featured: true,
                }),
            });
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = makeGitFacade({
                getMainBranch: jest.fn().mockResolvedValue(null),
            });
            const { service } = makeService(gitFacade);

            const result = await service.updateItem(
                makeWork() as any,
                makeUser() as any,
                { item_slug: 'tool-a', featured: true } as any,
            );

            expect(gitFacade.switchBranch).not.toHaveBeenCalled();
            expect(result.status).toBe('success');
        });
    });
});
