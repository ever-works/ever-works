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

    /**
     * CI feedback + autonomous fix loop (slice AC, EW-806) added two
     * fields to every link: WHICH of the Work's repo roles the delivery's
     * repository fills, and whether that is the repository this Work's
     * Tasks actually live in (the DATA repo — see `WORK_TASK_REPO_ROLE`).
     * The default fixture below declares only a `work` repo, so a
     * consumer that ACTS on the Task it resolved must refuse this link;
     * the git-activity consumer, which only decorates an ingested event,
     * goes on ignoring both fields.
     */
    const WORK_REPO_LINK = {
        workId: 'work-1',
        taskId: 'task-1',
        taskSlug: 'T-42',
        repoRoles: ['work'],
        isTaskRepo: false,
    };

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
            ).resolves.toEqual(WORK_REPO_LINK);
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

    describe('the repo role a link came from', () => {
        it('marks a link found through the Work’s DATA repo as the Task repository', async () => {
            works.findByUser = jest.fn().mockResolvedValue([
                {
                    id: 'work-1',
                    getRepoOwner: () => 'acme',
                    getMainRepo: () => 'widgets-main',
                    getWebsiteRepo: () => 'widgets-www',
                    getDataRepo: () => 'widgets',
                },
            ]);
            await expect(
                makeSvc().findByPullRequest({
                    userId: 'u1',
                    owner: 'acme',
                    repo: 'widgets',
                    prNumber: 42,
                }),
            ).resolves.toMatchObject({ repoRoles: ['data'], isTaskRepo: true });
        });

        it('reports EVERY role a repository fills, because two can be the same repo', async () => {
            works.findByUser = jest.fn().mockResolvedValue([
                {
                    id: 'work-1',
                    getRepoOwner: () => 'acme',
                    getMainRepo: () => 'widgets',
                    getWebsiteRepo: () => 'widgets-www',
                    getDataRepo: () => 'widgets',
                },
            ]);
            await expect(
                makeSvc().findByPullRequest({
                    userId: 'u1',
                    owner: 'acme',
                    repo: 'widgets',
                    prNumber: 42,
                }),
            ).resolves.toMatchObject({ repoRoles: ['work', 'data'], isTaskRepo: true });
        });
    });

    describe('findByPullRequests (one Works scan for a whole delivery)', () => {
        beforeEach(() => {
            works.findByUser = jest.fn().mockResolvedValue([
                {
                    id: 'work-1',
                    getRepoOwner: () => 'acme',
                    getMainRepo: () => 'widgets-main',
                    getWebsiteRepo: () => null,
                    getDataRepo: () => 'widgets',
                },
            ]);
        });

        /**
         * A commit can head several pull requests (a stacked chain, a
         * shared branch) and a check delivery lists all of them, capped at
         * 20. Resolving each through `findByPullRequest` re-loaded the
         * owner's ENTIRE Works list every time and threw away every scan
         * before the matching one — on a webhook hot path, for the busiest
         * account on the platform, on every one of the ~30 deliveries a
         * single push produces.
         */
        it('loads the owner’s Works exactly once however many PR numbers are reported', async () => {
            tasks.findByWorkAndPrNumber = jest
                .fn()
                .mockImplementation(async (_workId: string, prNumber: number) =>
                    prNumber === 9 ? { id: 'task-1', slug: 'T-42' } : null,
                );

            await expect(
                makeSvc().findByPullRequests(
                    { userId: 'u1', owner: 'acme', repo: 'widgets' },
                    [3, 5, 7, 9],
                ),
            ).resolves.toMatchObject({ taskId: 'task-1', prNumber: 9, isTaskRepo: true });
            expect(works.findByUser).toHaveBeenCalledTimes(1);
            expect(tasks.findByWorkAndPrNumber).toHaveBeenCalledTimes(4);
        });

        it('tries the numbers in the order it was given and stops at the first hit', async () => {
            tasks.findByWorkAndPrNumber = jest
                .fn()
                .mockResolvedValue({ id: 'task-1', slug: 'T-42' });
            await expect(
                makeSvc().findByPullRequests(
                    { userId: 'u1', owner: 'acme', repo: 'widgets' },
                    [42, 7],
                ),
            ).resolves.toMatchObject({ prNumber: 42 });
            expect(tasks.findByWorkAndPrNumber).toHaveBeenCalledTimes(1);
        });

        it('touches nothing for an empty or non-integer list', async () => {
            await expect(
                makeSvc().findByPullRequests({ userId: 'u1', owner: 'acme', repo: 'widgets' }, []),
            ).resolves.toBeNull();
            await expect(
                makeSvc().findByPullRequests({ userId: 'u1', owner: 'acme', repo: 'widgets' }, [
                    Number.NaN,
                ]),
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
            ).resolves.toEqual(WORK_REPO_LINK);
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
