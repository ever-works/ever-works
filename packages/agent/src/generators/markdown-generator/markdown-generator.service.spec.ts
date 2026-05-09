// `github-slugger` is shipped as ESM-only, which Jest's CommonJS pipeline
// cannot parse. The transitive import path is:
//     markdown-generator.service → readme-builder → github-slugger
// We stub it the same way `readme-builder.spec.ts` does. The shape only
// needs to be `class { slug(input: string): string }` so the constructor
// in readme-builder can build an instance.
jest.mock('github-slugger', () => {
    return class MockGithubSlugger {
        private seen = new Map<string, number>();
        slug(input: string): string {
            const base = input
                .toLowerCase()
                .replace(/&/g, '')
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
            const count = this.seen.get(base) ?? 0;
            this.seen.set(base, count + 1);
            return count === 0 ? base : `${base}-${count}`;
        }
    };
});

jest.mock('node:fs/promises', () => ({
    readdir: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../utils/fresh-repository-clone.utils', () => ({
    cloneFreshRepository: jest.fn(),
}));

import { GenerationMethod } from '@ever-works/contracts/api';
import { MarkdownGeneratorService } from './markdown-generator.service';
import { MarkdownRepository } from './markdown-repository';
import { ReadmeBuilder } from './readme-builder';
import { DataRepository } from '../data-generator/data-repository';
import { cloneFreshRepository } from '../../utils/fresh-repository-clone.utils';
import { createGenerationCancelledError } from '../../utils/generation-cancellation.utils';
import type { GitFacadeService } from '../../facades/git.facade';
import type { WorkOperationsService } from '@src/work-operations';
import type { Work } from '../../entities/work.entity';
import type { User } from '../../entities/user.entity';

const fsMock = jest.requireMock('node:fs/promises') as {
    readdir: jest.Mock;
};

const cloneFreshRepositoryMock = cloneFreshRepository as jest.MockedFunction<
    typeof cloneFreshRepository
>;

type FacadeMock = jest.Mocked<GitFacadeService>;
type WorkOpsMock = jest.Mocked<WorkOperationsService>;

const COMMITTER = { name: 'Test User', email: 'test@example.com' } as const;

const createGitFacadeMock = (): FacadeMock =>
    ({
        createRepository: jest.fn().mockResolvedValue({
            owner: 'acme',
            name: 'test-work',
            fullName: 'acme/test-work',
        }),
        cloneOrPull: jest.fn().mockResolvedValue('/tmp/data-repo'),
        getMainBranch: jest.fn().mockResolvedValue('main'),
        switchBranch: jest.fn().mockResolvedValue(undefined),
        addAll: jest.fn().mockResolvedValue(undefined),
        commit: jest.fn().mockResolvedValue(undefined),
        push: jest.fn().mockResolvedValue(undefined),
        createPullRequest: jest.fn().mockResolvedValue({ number: 42, url: 'https://pr/42' }),
        deleteRepository: jest.fn().mockResolvedValue(undefined),
        getLocalDir: jest.fn().mockReturnValue('/tmp/local'),
    }) as unknown as FacadeMock;

const createWorkOpsMock = (): WorkOpsMock =>
    ({
        updateLastPullRequest: jest.fn().mockResolvedValue(undefined),
    }) as unknown as WorkOpsMock;

const createWork = (overrides: Partial<Record<string, unknown>> = {}): Work =>
    ({
        id: 'dir-1',
        slug: 'test-work',
        gitProvider: 'github',
        organization: null,
        description: 'A test work',
        user: { id: 'user-1' },
        getRepoOwner: jest
            .fn()
            .mockImplementation((kind?: string) => (kind === 'work' ? 'acme' : 'acme')),
        getMainRepo: jest.fn().mockReturnValue('test-work'),
        getDataRepo: jest.fn().mockReturnValue('test-work-data'),
        resolveCommitter: jest.fn().mockReturnValue({ ...COMMITTER }),
        ...overrides,
    }) as unknown as Work;

const createUser = (): User => ({ id: 'user-1' }) as User;

describe('MarkdownGeneratorService', () => {
    let dataRepoCreateSpy: jest.SpyInstance;
    let writeReadmeSpy: jest.SpyInstance;
    let writeDetailsSpy: jest.SpyInstance;
    let writeLicenseSpy: jest.SpyInstance;
    let removeDetailsSpy: jest.SpyInstance;
    let resetFilesSpy: jest.SpyInstance;
    let ensureWorksExistSpy: jest.SpyInstance;
    let cleanupSpy: jest.SpyInstance;

    const mountDataRepoMock = (overrides: Partial<Record<string, unknown>> = {}) => {
        const dataRepo = {
            dir: '/tmp/data-repo',
            dataDir: '/tmp/data-repo/data',
            getMarkdown: jest.fn().mockResolvedValue(undefined),
            getItem: jest.fn().mockResolvedValue(null),
            getCategories: jest.fn().mockResolvedValue([]),
            getTags: jest.fn().mockResolvedValue([]),
            getLicense: jest.fn().mockResolvedValue(null),
            getConfig: jest.fn().mockResolvedValue({ content_table: false }),
            readMarkdownTemplate: jest.fn().mockResolvedValue({ header: '', footer: '' }),
            ...overrides,
        };
        dataRepoCreateSpy.mockResolvedValue(dataRepo as unknown as DataRepository);
        return dataRepo;
    };

    beforeEach(() => {
        jest.clearAllMocks();
        cloneFreshRepositoryMock.mockResolvedValue('/tmp/markdown-repo');
        fsMock.readdir.mockResolvedValue([]);

        dataRepoCreateSpy = jest.spyOn(DataRepository, 'create');
        writeReadmeSpy = jest
            .spyOn(MarkdownRepository.prototype, 'writeReadme')
            .mockResolvedValue(undefined);
        writeDetailsSpy = jest
            .spyOn(MarkdownRepository.prototype, 'writeDetails')
            .mockResolvedValue(undefined);
        writeLicenseSpy = jest
            .spyOn(MarkdownRepository.prototype, 'writeLicense')
            .mockResolvedValue(undefined);
        removeDetailsSpy = jest
            .spyOn(MarkdownRepository.prototype, 'removeDetails')
            .mockResolvedValue(undefined);
        resetFilesSpy = jest
            .spyOn(MarkdownRepository.prototype, 'resetFiles')
            .mockResolvedValue(undefined);
        ensureWorksExistSpy = jest
            .spyOn(MarkdownRepository.prototype, 'ensureWorksExist')
            .mockResolvedValue(undefined);
        cleanupSpy = jest
            .spyOn(MarkdownRepository.prototype, 'cleanup')
            .mockResolvedValue(undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('initialize — repository setup', () => {
        it('creates markdown repo via gitFacade with private flag and personal owner when work has no organization', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            expect(gitFacade.createRepository).toHaveBeenCalledTimes(1);
            const [payload, options] = gitFacade.createRepository.mock.calls[0];
            expect(payload).toEqual({
                name: 'test-work',
                description: 'A test work',
                organization: undefined,
                isPrivate: true,
            });
            expect(options).toEqual({
                userId: 'user-1',
                providerId: 'github',
                workId: 'dir-1',
            });
        });

        it('passes the work owner as organization on createRepository when work.organization is truthy', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock();
            const work = createWork({ organization: 'acme-org' });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(work, createUser());

            const [payload] = gitFacade.createRepository.mock.calls[0];
            expect(payload.organization).toBe('acme');
        });

        it('throws when the created repository owner/name does not match the work expectation', async () => {
            const gitFacade = createGitFacadeMock();
            gitFacade.createRepository.mockResolvedValueOnce({
                owner: 'someone-else',
                name: 'test-work',
                fullName: 'someone-else/test-work',
            } as any);
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await expect(service.initialize(createWork(), createUser())).rejects.toThrow(
                /Markdown repository was created as someone-else\/test-work/,
            );
        });

        it('clones markdown repo via cloneFreshRepository (NOT cloneOrPull) — retry-safe path', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            expect(cloneFreshRepositoryMock).toHaveBeenCalledTimes(1);
            const [, args] = cloneFreshRepositoryMock.mock.calls[0];
            expect(args).toEqual({
                owner: 'acme',
                repo: 'test-work',
                committer: COMMITTER,
                userId: 'user-1',
                providerId: 'github',
                workId: 'dir-1',
            });
        });

        it('clones data repo via cloneOrPull with the data-repo coordinates', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            expect(gitFacade.cloneOrPull).toHaveBeenCalledTimes(1);
            const [cloneOpts, gitOpts] = gitFacade.cloneOrPull.mock.calls[0];
            expect(cloneOpts).toEqual({
                owner: 'acme',
                repo: 'test-work-data',
                committer: COMMITTER,
            });
            expect(gitOpts).toEqual({
                userId: 'user-1',
                providerId: 'github',
                workId: 'dir-1',
            });
        });
    });

    describe('initialize — generation_method branches', () => {
        it('RECREATE: switches to default branch then resetFiles (canCreatePR=false ⇒ no PR)', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser(), {
                generation_method: GenerationMethod.RECREATE,
                pr_update: { branch: 'feature-x', title: 't', body: 'b' },
            });

            expect(gitFacade.switchBranch).toHaveBeenCalledWith(
                'github',
                '/tmp/markdown-repo',
                'main',
            );
            expect(resetFilesSpy).toHaveBeenCalledTimes(1);
            // PR is not created on RECREATE even with pr_update.branch present
            expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
            expect(workOps.updateLastPullRequest).not.toHaveBeenCalled();
        });

        it('RECREATE skips main-branch switch when getMainBranch returns null (still resetFiles)', async () => {
            const gitFacade = createGitFacadeMock();
            gitFacade.getMainBranch.mockResolvedValueOnce(null as any);
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser(), {
                generation_method: GenerationMethod.RECREATE,
            });

            expect(gitFacade.switchBranch).not.toHaveBeenCalled();
            expect(resetFilesSpy).toHaveBeenCalledTimes(1);
        });

        it('RECREATE swallows getMainBranch rejection (logs error, treats as null)', async () => {
            const gitFacade = createGitFacadeMock();
            gitFacade.getMainBranch.mockRejectedValueOnce(new Error('boom'));
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await expect(
                service.initialize(createWork(), createUser(), {
                    generation_method: GenerationMethod.RECREATE,
                }),
            ).resolves.toBeUndefined();
            // The default branch was treated as null → no switchBranch call
            expect(gitFacade.switchBranch).not.toHaveBeenCalled();
            expect(resetFilesSpy).toHaveBeenCalledTimes(1);
        });

        it('RECREATE swallows switchBranch rejection (continues to resetFiles)', async () => {
            const gitFacade = createGitFacadeMock();
            gitFacade.switchBranch.mockRejectedValueOnce(new Error('switch failed'));
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await expect(
                service.initialize(createWork(), createUser(), {
                    generation_method: GenerationMethod.RECREATE,
                }),
            ).resolves.toBeUndefined();
            expect(resetFilesSpy).toHaveBeenCalledTimes(1);
        });

        it('CREATE_UPDATE with pr_update.branch: switches BOTH markdown + data repos to PR branch (force=true)', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser(), {
                generation_method: GenerationMethod.CREATE_UPDATE,
                pr_update: { branch: 'feature-y', title: 't', body: 'b' },
            });

            const calls = gitFacade.switchBranch.mock.calls;
            const targets = calls.map((c) => `${c[1]}|${c[2]}|${c[3] === true}`);
            expect(targets).toEqual(
                expect.arrayContaining([
                    `/tmp/markdown-repo|feature-y|true`,
                    `/tmp/data-repo|feature-y|true`,
                ]),
            );
            // Reset files NOT called in CREATE_UPDATE
            expect(resetFilesSpy).not.toHaveBeenCalled();
        });

        it('CREATE_UPDATE: PR branch switch failure clears canCreatePR (no PR even when defaultBranch present)', async () => {
            const gitFacade = createGitFacadeMock();
            // markdown switch resolves; data switch rejects → Promise.all rejects
            gitFacade.switchBranch
                .mockResolvedValueOnce(undefined)
                .mockRejectedValueOnce(new Error('data switch failed'));
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser(), {
                generation_method: GenerationMethod.CREATE_UPDATE,
                pr_update: { branch: 'feature-z', title: 't', body: 'b' },
            });

            expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
            expect(workOps.updateLastPullRequest).not.toHaveBeenCalled();
        });

        it('CREATE_UPDATE without pr_update: no branch switch, no resetFiles, no PR', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser(), {
                generation_method: GenerationMethod.CREATE_UPDATE,
            });

            expect(gitFacade.switchBranch).not.toHaveBeenCalled();
            expect(resetFilesSpy).not.toHaveBeenCalled();
            expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
        });
    });

    describe('initialize — items / categories / tags', () => {
        it('writes details for slugs whose markdown is non-empty and skips slugs without markdown', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            fsMock.readdir.mockResolvedValueOnce(['alpha', 'beta', 'gamma']);
            mountDataRepoMock({
                getMarkdown: jest
                    .fn()
                    .mockResolvedValueOnce('# Alpha')
                    .mockResolvedValueOnce(undefined)
                    .mockResolvedValueOnce('# Gamma'),
                getItem: jest.fn().mockImplementation((slug: string) => ({
                    slug,
                    name: slug,
                    description: '',
                    category: 'misc',
                    source_url: 'https://e.x',
                })),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            const written = writeDetailsSpy.mock.calls.map((c) => c[0]);
            expect(written).toEqual(['alpha', 'gamma']);
        });

        it('continues iteration when getItem returns null for a slug (no group entry)', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const builderSpy = jest.spyOn(ReadmeBuilder.prototype, 'addItem');
            fsMock.readdir.mockResolvedValueOnce(['alpha', 'beta']);
            mountDataRepoMock({
                getMarkdown: jest.fn().mockResolvedValue(undefined),
                getItem: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
                    slug: 'beta',
                    name: 'Beta',
                    description: '',
                    category: 'tools',
                }),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            // Only beta should be added
            expect(builderSpy).toHaveBeenCalledTimes(1);
            expect(builderSpy.mock.calls[0][0]).toMatchObject({ slug: 'beta' });
        });

        it('warn-and-skip an item when getItem rejects (other items still processed)', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            fsMock.readdir.mockResolvedValueOnce(['bad', 'good']);
            mountDataRepoMock({
                getMarkdown: jest.fn().mockResolvedValue(undefined),
                getItem: jest
                    .fn()
                    .mockRejectedValueOnce(new Error('parse failed'))
                    .mockResolvedValueOnce({
                        slug: 'good',
                        name: 'Good',
                        description: '',
                        category: 'tools',
                    }),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await expect(service.initialize(createWork(), createUser())).resolves.toBeUndefined();
            // Push happens at the end — proves iteration completed past the rejection
            expect(gitFacade.push).toHaveBeenCalledTimes(1);
        });

        it('coerces non-Error throw value via String() in the per-item warn message', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            fsMock.readdir.mockResolvedValueOnce(['oops']);
            mountDataRepoMock({
                getMarkdown: jest.fn().mockRejectedValueOnce('string-thrown'),
                getItem: jest.fn().mockResolvedValue(null),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await expect(service.initialize(createWork(), createUser())).resolves.toBeUndefined();
            expect(gitFacade.push).toHaveBeenCalledTimes(1);
        });

        it('normalises array category and registers ad-hoc categories not present in the loaded map', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const builderSpy = jest.spyOn(ReadmeBuilder.prototype, 'addItem');
            fsMock.readdir.mockResolvedValueOnce(['multi']);
            mountDataRepoMock({
                getMarkdown: jest.fn().mockResolvedValue(undefined),
                getItem: jest.fn().mockResolvedValueOnce({
                    slug: 'multi',
                    name: 'Multi',
                    description: '',
                    category: ['tools', 'extras'],
                }),
                // categories list returns no entries — both are ad-hoc registered
                getCategories: jest.fn().mockResolvedValue([]),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            // The same item should have been added under each of its two categories
            expect(builderSpy).toHaveBeenCalledTimes(2);
        });

        it('populates each item.tags entry from the loaded tags map (string → tag object)', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const builderSpy = jest.spyOn(ReadmeBuilder.prototype, 'addItem');
            fsMock.readdir.mockResolvedValueOnce(['x']);
            mountDataRepoMock({
                getMarkdown: jest.fn().mockResolvedValue(undefined),
                getItem: jest.fn().mockResolvedValueOnce({
                    slug: 'x',
                    name: 'X',
                    description: '',
                    category: 'misc',
                    tags: ['hot'],
                }),
                getTags: jest.fn().mockResolvedValue([{ id: 'hot', name: 'Hot' }]),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            const passedItem = builderSpy.mock.calls[0][0] as { tags?: any };
            expect(passedItem.tags).toEqual([{ id: 'hot', name: 'Hot' }]);
        });

        it('removes detail files listed in options.remove_details (and excludes them from "details" markdown set)', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            fsMock.readdir.mockResolvedValueOnce([]);
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser(), {
                remove_details: ['gone-1', 'gone-2'],
            });

            const removed = removeDetailsSpy.mock.calls.map((c) => c[0]);
            expect(removed).toEqual(['gone-1', 'gone-2']);
        });

        it('writes LICENSE.md only when DataRepository.getLicense returns truthy', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock({ getLicense: jest.fn().mockResolvedValue('MIT') });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            expect(writeLicenseSpy).toHaveBeenCalledWith('MIT');
        });

        it('skips writeLicense when getLicense returns null', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock({ getLicense: jest.fn().mockResolvedValue(null) });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            expect(writeLicenseSpy).not.toHaveBeenCalled();
        });
    });

    describe('initialize — README + commit/push/PR', () => {
        it('passes content_table=true through to ReadmeBuilder.enableToC()', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const enableToCSpy = jest.spyOn(ReadmeBuilder.prototype, 'enableToC');
            mountDataRepoMock({
                getConfig: jest.fn().mockResolvedValue({ content_table: true }),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            expect(enableToCSpy).toHaveBeenCalledTimes(1);
        });

        it('skips ReadmeBuilder.enableToC when content_table is false', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const enableToCSpy = jest.spyOn(ReadmeBuilder.prototype, 'enableToC');
            mountDataRepoMock({
                getConfig: jest.fn().mockResolvedValue({ content_table: false }),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            expect(enableToCSpy).not.toHaveBeenCalled();
        });

        it('addAll → commit("sync README.md", committer) → push order is preserved', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            expect(gitFacade.addAll).toHaveBeenCalledWith('github', '/tmp/markdown-repo');
            expect(gitFacade.commit).toHaveBeenCalledWith(
                'github',
                '/tmp/markdown-repo',
                'sync README.md',
                COMMITTER,
            );
            expect(gitFacade.push).toHaveBeenCalledWith(
                { dir: '/tmp/markdown-repo' },
                {
                    userId: 'user-1',
                    providerId: 'github',
                    workId: 'dir-1',
                },
            );
            const addOrder = gitFacade.addAll.mock.invocationCallOrder[0];
            const commitOrder = gitFacade.commit.mock.invocationCallOrder[0];
            const pushOrder = gitFacade.push.mock.invocationCallOrder[0];
            expect(addOrder).toBeLessThan(commitOrder);
            expect(commitOrder).toBeLessThan(pushOrder);
        });

        it('writes README.md from ReadmeBuilder.build() output', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock();
            const buildSpy = jest
                .spyOn(ReadmeBuilder.prototype, 'build')
                .mockReturnValue('# README');

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            expect(buildSpy).toHaveBeenCalled();
            expect(writeReadmeSpy).toHaveBeenCalledWith('# README');
        });

        it('CREATE_UPDATE + canCreatePR + defaultBranch: opens PR and persists lastPullRequest', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser(), {
                generation_method: GenerationMethod.CREATE_UPDATE,
                pr_update: { branch: 'pr-branch', title: 'My PR', body: 'PR body' },
            });

            expect(gitFacade.createPullRequest).toHaveBeenCalledWith(
                {
                    owner: 'acme',
                    repo: 'test-work',
                    base: 'main',
                    head: 'pr-branch',
                    title: 'My PR',
                    body: 'PR body',
                },
                {
                    userId: 'user-1',
                    providerId: 'github',
                    workId: 'dir-1',
                },
            );
            expect(workOps.updateLastPullRequest).toHaveBeenCalledWith('dir-1', {
                main: {
                    branch: 'pr-branch',
                    title: 'My PR',
                    body: 'PR body',
                    number: 42,
                    url: 'https://pr/42',
                },
            });
        });

        it('createPullRequest rejection is swallowed; no updateLastPullRequest, no service throw', async () => {
            const gitFacade = createGitFacadeMock();
            gitFacade.createPullRequest.mockRejectedValueOnce(new Error('upstream 500'));
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await expect(
                service.initialize(createWork(), createUser(), {
                    generation_method: GenerationMethod.CREATE_UPDATE,
                    pr_update: { branch: 'feat', title: 't', body: 'b' },
                }),
            ).resolves.toBeUndefined();
            expect(workOps.updateLastPullRequest).not.toHaveBeenCalled();
        });

        it('does NOT open a PR when canCreatePR is true but defaultBranch resolved to null', async () => {
            const gitFacade = createGitFacadeMock();
            gitFacade.getMainBranch.mockResolvedValueOnce(null as any);
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser(), {
                generation_method: GenerationMethod.CREATE_UPDATE,
                pr_update: { branch: 'feat', title: 't', body: 'b' },
            });

            expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
        });

        it('rethrows when an inner step (e.g. addAll) rejects — error path logs + propagates', async () => {
            const gitFacade = createGitFacadeMock();
            gitFacade.addAll.mockRejectedValueOnce(new Error('addAll failed'));
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await expect(service.initialize(createWork(), createUser())).rejects.toThrow(
                'addAll failed',
            );
        });
    });

    describe('initialize — generation cancellation', () => {
        it('throws GenerationCancelledError immediately when signal already aborted', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const ac = new AbortController();
            ac.abort();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await expect(
                service.initialize(createWork(), createUser(), { signal: ac.signal }),
            ).rejects.toThrow(/cancelled/i);
            // No git operations should have happened
            expect(gitFacade.createRepository).not.toHaveBeenCalled();
        });

        it('uses signal.reason if provided as Error during cancellation check', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const ac = new AbortController();
            const reason = new Error('user-cancelled');
            ac.abort(reason);
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await expect(
                service.initialize(createWork(), createUser(), { signal: ac.signal }),
            ).rejects.toBe(reason);
        });

        it('produces a generic AbortError when isGenerationCancelledError-style helper is exercised', () => {
            const err = createGenerationCancelledError();
            expect(err.name).toBe('AbortError');
            expect(err.message).toMatch(/cancelled/i);
        });
    });

    describe('removeItemDetail', () => {
        it('clones via cloneOrPull (not cloneFreshRepository) and calls removeDetails(slug)', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.removeItemDetail(createWork(), createUser(), 'item-x');

            expect(cloneFreshRepositoryMock).not.toHaveBeenCalled();
            expect(gitFacade.cloneOrPull).toHaveBeenCalledTimes(1);
            const [cloneOpts, gitOpts] = gitFacade.cloneOrPull.mock.calls[0];
            expect(cloneOpts).toEqual({
                owner: 'acme',
                repo: 'test-work',
                committer: COMMITTER,
            });
            expect(gitOpts).toEqual({
                userId: 'user-1',
                providerId: 'github',
                workId: 'dir-1',
            });
            expect(removeDetailsSpy).toHaveBeenCalledWith('item-x');
        });

        it('switches to PR branch (force=true) when branch arg is provided BEFORE removing the detail', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.removeItemDetail(createWork(), createUser(), 'item-x', 'pr-feature');

            expect(gitFacade.switchBranch).toHaveBeenCalledWith(
                'github',
                expect.any(String),
                'pr-feature',
                true,
            );
            const switchOrder = gitFacade.switchBranch.mock.invocationCallOrder[0];
            const removeOrder = removeDetailsSpy.mock.invocationCallOrder[0];
            expect(switchOrder).toBeLessThan(removeOrder);
        });

        it('swallows switchBranch rejection but STILL calls removeDetails', async () => {
            const gitFacade = createGitFacadeMock();
            gitFacade.switchBranch.mockRejectedValueOnce(new Error('cannot checkout'));
            const workOps = createWorkOpsMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await expect(
                service.removeItemDetail(createWork(), createUser(), 'item-x', 'pr'),
            ).resolves.toBeUndefined();
            expect(removeDetailsSpy).toHaveBeenCalledWith('item-x');
        });

        it('does NOT call switchBranch when branch arg is omitted', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.removeItemDetail(createWork(), createUser(), 'item-x');

            expect(gitFacade.switchBranch).not.toHaveBeenCalled();
            expect(removeDetailsSpy).toHaveBeenCalledWith('item-x');
        });
    });

    describe('removeRepository', () => {
        it('deletes the remote repo, then cleans the local dir derived from getLocalDir()', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.removeRepository(createWork(), createUser());

            expect(gitFacade.deleteRepository).toHaveBeenCalledWith('acme', 'test-work', {
                userId: 'user-1',
                providerId: 'github',
                workId: 'dir-1',
            });
            expect(gitFacade.getLocalDir).toHaveBeenCalledWith('github', 'acme', 'test-work');
            expect(cleanupSpy).toHaveBeenCalledTimes(1);
            const deleteOrder = gitFacade.deleteRepository.mock.invocationCallOrder[0];
            const cleanupOrder = cleanupSpy.mock.invocationCallOrder[0];
            expect(deleteOrder).toBeLessThan(cleanupOrder);
        });

        it('rethrows when deleteRepository rejects (cleanup is NOT attempted)', async () => {
            const gitFacade = createGitFacadeMock();
            gitFacade.deleteRepository.mockRejectedValueOnce(new Error('403 forbidden'));
            const workOps = createWorkOpsMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await expect(service.removeRepository(createWork(), createUser())).rejects.toThrow(
                '403 forbidden',
            );
            expect(cleanupSpy).not.toHaveBeenCalled();
        });
    });

    describe('cleanup', () => {
        it('returns the markdown-repository cleanup() result on the dir derived from getLocalDir()', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            cleanupSpy.mockResolvedValueOnce('ok' as any);

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            const result = await service.cleanup(createWork());

            expect(gitFacade.getLocalDir).toHaveBeenCalledWith('github', 'acme', 'test-work');
            expect(cleanupSpy).toHaveBeenCalledTimes(1);
            expect(result).toBe('ok');
        });
    });

    describe('private — generateReadme + sortCategoriesByPriority', () => {
        const callPrivate = (
            service: MarkdownGeneratorService,
            method: 'generateReadme' | 'sortCategoriesByPriority',
            ...args: unknown[]
        ): unknown =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (service as any)[method](...args);

        it('sorts featured-bearing categories before non-featured (regardless of priority)', () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const service = new MarkdownGeneratorService(gitFacade, workOps);

            const groups = {
                'no-featured': [{ slug: 'a', name: 'A', featured: false }],
                'with-featured': [{ slug: 'b', name: 'B', featured: true }],
            };
            const categories = new Map<string, any>([
                ['no-featured', { id: 'no-featured', name: 'No Featured', priority: 1 }],
                ['with-featured', { id: 'with-featured', name: 'With Featured', priority: 99 }],
            ]);

            const result = callPrivate(service, 'sortCategoriesByPriority', groups, categories);
            expect(result).toEqual(['with-featured', 'no-featured']);
        });

        it('within the same featured-bucket, sorts by ascending priority when both have priority', () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const service = new MarkdownGeneratorService(gitFacade, workOps);

            const groups = {
                low: [{ slug: 'a', name: 'A' }],
                high: [{ slug: 'b', name: 'B' }],
            };
            const categories = new Map<string, any>([
                ['low', { id: 'low', name: 'Low', priority: 10 }],
                ['high', { id: 'high', name: 'High', priority: 1 }],
            ]);

            const result = callPrivate(service, 'sortCategoriesByPriority', groups, categories);
            expect(result).toEqual(['high', 'low']);
        });

        it('A-has-priority / B-has-no-priority → A wins (returns -1)', () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const service = new MarkdownGeneratorService(gitFacade, workOps);

            const groups = {
                noprio: [{ slug: 'a', name: 'A' }],
                prio: [{ slug: 'b', name: 'B' }],
            };
            const categories = new Map<string, any>([
                ['noprio', { id: 'noprio', name: 'No prio' }],
                ['prio', { id: 'prio', name: 'Prio', priority: 5 }],
            ]);

            const result = callPrivate(service, 'sortCategoriesByPriority', groups, categories);
            expect(result).toEqual(['prio', 'noprio']);
        });

        it('falls back to alphabetical name when both lack priority and have equal featured count', () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const service = new MarkdownGeneratorService(gitFacade, workOps);

            const groups = {
                bee: [{ slug: 'a', name: 'A' }],
                ant: [{ slug: 'b', name: 'B' }],
            };
            const categories = new Map<string, any>([
                ['bee', { id: 'bee', name: 'Bee' }],
                ['ant', { id: 'ant', name: 'Ant' }],
            ]);

            const result = callPrivate(service, 'sortCategoriesByPriority', groups, categories);
            expect(result).toEqual(['ant', 'bee']);
        });

        it('when both have no priority but different featured counts, the higher featured count wins', () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const service = new MarkdownGeneratorService(gitFacade, workOps);

            const groups = {
                one: [{ slug: 'a', featured: true }],
                two: [
                    { slug: 'b', featured: true },
                    { slug: 'c', featured: true },
                ],
            };
            const categories = new Map<string, any>([
                ['one', { id: 'one', name: 'One' }],
                ['two', { id: 'two', name: 'Two' }],
            ]);

            const result = callPrivate(service, 'sortCategoriesByPriority', groups, categories);
            expect(result).toEqual(['two', 'one']);
        });

        it('within a category: featured-true items precede featured-false (stable across order)', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const builderSpy = jest.spyOn(ReadmeBuilder.prototype, 'addItem');
            fsMock.readdir.mockResolvedValueOnce(['a', 'b']);
            mountDataRepoMock({
                getMarkdown: jest.fn().mockResolvedValue(undefined),
                getItem: jest
                    .fn()
                    .mockImplementation((slug: string) =>
                        slug === 'a'
                            ? {
                                  slug: 'a',
                                  name: 'A',
                                  description: '',
                                  category: 'misc',
                                  featured: false,
                              }
                            : {
                                  slug: 'b',
                                  name: 'B',
                                  description: '',
                                  category: 'misc',
                                  featured: true,
                              },
                    ),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            const orderedSlugs = builderSpy.mock.calls.map((c) => (c[0] as any).slug);
            expect(orderedSlugs).toEqual(['b', 'a']);
        });

        it('within a category, equal-featured items sort by explicit ascending order, then alphabetical name', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const builderSpy = jest.spyOn(ReadmeBuilder.prototype, 'addItem');
            fsMock.readdir.mockResolvedValueOnce(['c', 'a', 'b']);
            mountDataRepoMock({
                getMarkdown: jest.fn().mockResolvedValue(undefined),
                getItem: jest.fn().mockImplementation((slug: string) => {
                    const map: Record<string, any> = {
                        a: { slug: 'a', name: 'AA', description: '', category: 'misc', order: 5 },
                        b: { slug: 'b', name: 'BB', description: '', category: 'misc', order: 5 },
                        c: { slug: 'c', name: 'CC', description: '', category: 'misc', order: 1 },
                    };
                    return map[slug];
                }),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            const orderedSlugs = builderSpy.mock.calls.map((c) => (c[0] as any).slug);
            expect(orderedSlugs).toEqual(['c', 'a', 'b']);
        });

        it('passes hasDetails:true to addItem when markdowns Set contains the slug', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const builderSpy = jest.spyOn(ReadmeBuilder.prototype, 'addItem');
            fsMock.readdir.mockResolvedValueOnce(['x', 'y']);
            mountDataRepoMock({
                getMarkdown: jest
                    .fn()
                    .mockResolvedValueOnce('# X')
                    .mockResolvedValueOnce(undefined),
                getItem: jest.fn().mockImplementation((slug: string) => ({
                    slug,
                    name: slug,
                    description: '',
                    category: 'misc',
                })),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            const calls = builderSpy.mock.calls;
            const xCall = calls.find((c) => (c[0] as any).slug === 'x');
            const yCall = calls.find((c) => (c[0] as any).slug === 'y');
            expect(xCall![1]).toEqual({ hasDetails: true });
            expect(yCall![1]).toEqual({ hasDetails: false });
        });
    });

    describe('private — populate (via initialize tags path)', () => {
        it('returns the cached value when a tag id is already in the map', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const builderSpy = jest.spyOn(ReadmeBuilder.prototype, 'addItem');
            fsMock.readdir.mockResolvedValueOnce(['x']);
            mountDataRepoMock({
                getMarkdown: jest.fn().mockResolvedValue(undefined),
                getItem: jest.fn().mockResolvedValueOnce({
                    slug: 'x',
                    name: 'X',
                    description: '',
                    category: 'misc',
                    // pass an object that already exists in tag map by id
                    tags: [{ id: 'hot', name: 'Stale' }],
                }),
                getTags: jest.fn().mockResolvedValue([{ id: 'hot', name: 'Hot' }]),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            const passedItem = builderSpy.mock.calls[0][0] as { tags?: any };
            // The cached tag (Hot) wins over the inline-passed object (Stale).
            expect(passedItem.tags).toEqual([{ id: 'hot', name: 'Hot' }]);
        });

        it('when a tag string is not in the map, registers a freshly-built {id,name} entry and reuses it', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const builderSpy = jest.spyOn(ReadmeBuilder.prototype, 'addItem');
            fsMock.readdir.mockResolvedValueOnce(['x', 'y']);
            mountDataRepoMock({
                getMarkdown: jest.fn().mockResolvedValue(undefined),
                getItem: jest.fn().mockImplementation((slug: string) => ({
                    slug,
                    name: slug,
                    description: '',
                    category: 'misc',
                    tags: ['shiny'],
                })),
                getTags: jest.fn().mockResolvedValue([]),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            const xTags = (builderSpy.mock.calls[0][0] as any).tags;
            const yTags = (builderSpy.mock.calls[1][0] as any).tags;
            expect(xTags).toEqual([{ id: 'shiny', name: 'shiny' }]);
            // Same instance reused on subsequent population
            expect(yTags[0]).toBe(xTags[0]);
        });
    });
});
