import { TaskGitLinkService } from '../task-git-link.service';

/**
 * Git activity ingestion (audit item j) — the branch/PR → Task resolver
 * the GitHub receiver stamps onto push / commit / merge envelopes.
 *
 * Three properties carry the whole contract: it is OWNER-SCOPED (the
 * candidate Works come from the ingesting user), `null` is an ORDINARY
 * outcome (most repositories are not Works and most branches are not
 * Tasks), and it NEVER throws — the caller is a webhook that must answer
 * 200 whatever the database is doing.
 */
describe('TaskGitLinkService (git activity ingestion)', () => {
    let tasks: any;
    let works: any;

    const task = { id: 'task-1', slug: 'T-42', workId: 'work-1', prNumber: 42 };

    function makeSvc(): TaskGitLinkService {
        const svc = new TaskGitLinkService(tasks, works);
        jest.spyOn(
            (svc as never as { logger: Record<string, () => void> }).logger,
            'warn',
        ).mockImplementation(() => undefined);
        return svc;
    }

    beforeEach(() => {
        tasks = {
            findByWorkAndPrNumber: jest.fn().mockResolvedValue({ ...task }),
            findByWorkAndBranchRef: jest.fn().mockResolvedValue({ ...task }),
        };
        // `matchWorkByRepo` reads repo roles through the Work's accessor
        // methods, so the fixture speaks that interface.
        works = {
            findByUser: jest.fn().mockResolvedValue([
                {
                    id: 'work-1',
                    getRepoOwner: (role: string) => (role === 'work' ? 'acme' : null),
                    getMainRepo: () => 'widgets',
                    getWebsiteRepo: () => null,
                    getDataRepo: () => null,
                },
            ]),
        };
    });

    afterEach(() => jest.restoreAllMocks());

    describe('findByBranch', () => {
        it('resolves the branch to its Work and Task', async () => {
            await expect(
                makeSvc().findByBranch({
                    userId: 'u1',
                    owner: 'acme',
                    repo: 'widgets',
                    branch: 'ever/task-t-42',
                }),
            ).resolves.toEqual({ workId: 'work-1', taskId: 'task-1', taskSlug: 'T-42' });
            expect(works.findByUser).toHaveBeenCalledWith('u1');
            expect(tasks.findByWorkAndBranchRef).toHaveBeenCalledWith('work-1', 'ever/task-t-42');
        });

        it('returns null for a repository that is not a Work — never queries Tasks', async () => {
            await expect(
                makeSvc().findByBranch({
                    userId: 'u1',
                    owner: 'stranger',
                    repo: 'thing',
                    branch: 'main',
                }),
            ).resolves.toBeNull();
            expect(tasks.findByWorkAndBranchRef).not.toHaveBeenCalled();
        });

        it('returns null when no Task owns the branch (a human pushed to main)', async () => {
            tasks.findByWorkAndBranchRef.mockResolvedValue(null);
            await expect(
                makeSvc().findByBranch({
                    userId: 'u1',
                    owner: 'acme',
                    repo: 'widgets',
                    branch: 'main',
                }),
            ).resolves.toBeNull();
        });

        it('refuses an empty branch without touching the database', async () => {
            await expect(
                makeSvc().findByBranch({
                    userId: 'u1',
                    owner: 'acme',
                    repo: 'widgets',
                    branch: '   ',
                }),
            ).resolves.toBeNull();
            expect(works.findByUser).not.toHaveBeenCalled();
        });
    });

    describe('findByPullRequest', () => {
        it('resolves the PR number to its Work and Task', async () => {
            await expect(
                makeSvc().findByPullRequest({
                    userId: 'u1',
                    owner: 'acme',
                    repo: 'widgets',
                    prNumber: 42,
                }),
            ).resolves.toEqual({ workId: 'work-1', taskId: 'task-1', taskSlug: 'T-42' });
            expect(tasks.findByWorkAndPrNumber).toHaveBeenCalledWith('work-1', 42);
        });

        it('refuses a non-integer PR number without touching the database', async () => {
            await expect(
                makeSvc().findByPullRequest({
                    userId: 'u1',
                    owner: 'acme',
                    repo: 'widgets',
                    prNumber: Number.NaN,
                }),
            ).resolves.toBeNull();
            expect(works.findByUser).not.toHaveBeenCalled();
        });
    });

    it('NEVER throws — a repository failure resolves to "not linked"', async () => {
        works.findByUser.mockRejectedValue(new Error('db down'));
        await expect(
            makeSvc().findByBranch({
                userId: 'u1',
                owner: 'acme',
                repo: 'widgets',
                branch: 'ever/task-t-42',
            }),
        ).resolves.toBeNull();
    });

    it('is owner-scoped: another user’s Works are never candidates', async () => {
        works.findByUser.mockResolvedValue([]);
        await expect(
            makeSvc().findByPullRequest({
                userId: 'intruder',
                owner: 'acme',
                repo: 'widgets',
                prNumber: 42,
            }),
        ).resolves.toBeNull();
        expect(works.findByUser).toHaveBeenCalledWith('intruder');
        expect(tasks.findByWorkAndPrNumber).not.toHaveBeenCalled();
    });
});
