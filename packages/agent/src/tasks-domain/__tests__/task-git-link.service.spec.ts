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
     * Tasks actually live in (the DATA repo for every kind that has one, the
     * website-role Work Repository for an App Work — see `taskRepositoryRole`).
     * The default fixture below declares only a `work` repo, so a
     * consumer that ACTS on the Task it resolved must refuse this link —
     * and since the third adversarial review so does the git-activity
     * decoration (`taskFields` in the PR review bridge): naming a Task that
     * opened the same number in another repository labels the event with
     * the wrong Task.
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

        it('marks an App Work’s own pull request as the Task repository — the WEBSITE role', async () => {
            // An App Work has no data repository (`repos.data: false`): its
            // Tasks branch and open pull requests in its `website`-role Work
            // Repository. Keying on the data role alone would call every one
            // of those pull requests "not the Task repository", and every
            // consumer that acts on a Task would drop it.
            works.findByUser = jest.fn().mockResolvedValue([
                {
                    id: 'work-1',
                    kind: 'app',
                    getRepoOwner: () => 'acme',
                    getMainRepo: () => 'their-app-main',
                    getWebsiteRepo: () => 'their-app',
                    getDataRepo: () => 'their-app-data',
                },
            ]);
            await expect(
                makeSvc().findByPullRequest({
                    userId: 'u1',
                    owner: 'acme',
                    repo: 'their-app',
                    prNumber: 42,
                }),
            ).resolves.toMatchObject({ repoRoles: ['website'], isTaskRepo: true });
        });

        it('does NOT mark a directory Work’s website pull request as the Task repository', async () => {
            // The other half of the same rule: a directory Work's Tasks live in
            // its data repository, so pull request #42 in its website repository
            // is a different pull request that happens to share a number.
            works.findByUser = jest.fn().mockResolvedValue([
                {
                    id: 'work-1',
                    kind: 'directory',
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
                    repo: 'widgets-www',
                    prNumber: 42,
                }),
            ).resolves.toMatchObject({ repoRoles: ['website'], isTaskRepo: false });
        });
    });

    /**
     * One account can register the same repository as two Works: an App Work
     * over a directory Work's generated website repository, or two App Works
     * over one code repository. The Task that owns a pull request lives in
     * only ONE of them, and `findByUser` returns them in no particular order.
     *
     * The lookup used to stop at the FIRST Work that had the repository, so
     * whether the right Task was found depended on that order: the other
     * Work's pull requests were never linked, and a check on one of them
     * could resolve to an unrelated Task that opened the same number in a
     * different repository.
     */
    describe('an account with two Works on one repository', () => {
        // A directory Work: its Tasks live in `site-data`; `site` is only
        // the website it generates.
        const directory = {
            id: 'dir-1',
            kind: 'directory',
            getRepoOwner: () => 'acme',
            getMainRepo: () => 'site-main',
            getWebsiteRepo: () => 'site',
            getDataRepo: () => 'site-data',
        };
        // An App Work wrapped around that same `site` repository: its Tasks
        // live there.
        const app = {
            id: 'app-1',
            kind: 'app',
            getRepoOwner: () => 'acme',
            getMainRepo: () => 'site-app-main',
            getWebsiteRepo: () => 'site',
            getDataRepo: () => 'site-app-data',
        };
        const APP_TASK = { id: 'app-task', slug: 'A-12' };
        const DIR_TASK = { id: 'dir-task', slug: 'D-12' };

        it.each([
            ['the directory Work first', [directory, app]],
            ['the App Work first', [app, directory]],
        ])('finds the App Work’s pull request with %s', async (_order, list) => {
            works.findByUser = jest.fn().mockResolvedValue(list);
            tasks.findByWorkAndPrNumber = jest
                .fn()
                .mockImplementation(async (workId: string) =>
                    workId === 'app-1' ? APP_TASK : null,
                );

            await expect(
                makeSvc().findByPullRequest({
                    userId: 'u1',
                    owner: 'acme',
                    repo: 'site',
                    prNumber: 12,
                }),
            ).resolves.toMatchObject({ workId: 'app-1', taskId: 'app-task', isTaskRepo: true });
            expect(works.findByUser).toHaveBeenCalledTimes(1);
        });

        it.each([
            ['the directory Work first', [directory, app]],
            ['the App Work first', [app, directory]],
        ])(
            'prefers the Work whose TASK repository this is over a same-numbered Task elsewhere, with %s',
            async (_order, list) => {
                // Both Works have a Task #12 — the directory Work's opened #12 in
                // `site-data`, a different pull request. The delivery is about
                // `site`, so the App Work's Task is the owner.
                works.findByUser = jest.fn().mockResolvedValue(list);
                tasks.findByWorkAndPrNumber = jest
                    .fn()
                    .mockImplementation(async (workId: string) =>
                        workId === 'app-1' ? APP_TASK : DIR_TASK,
                    );

                await expect(
                    makeSvc().findByPullRequest({
                        userId: 'u1',
                        owner: 'acme',
                        repo: 'site',
                        prNumber: 12,
                    }),
                ).resolves.toMatchObject({ workId: 'app-1', isTaskRepo: true });
            },
        );

        it('finds a Task branch in the SECOND of two App Works on one repository', async () => {
            const otherApp = { ...app, id: 'app-2' };
            works.findByUser = jest.fn().mockResolvedValue([app, otherApp]);
            tasks.findByWorkAndBranchRef = jest
                .fn()
                .mockImplementation(async (workId: string) =>
                    workId === 'app-2' ? APP_TASK : null,
                );

            await expect(
                makeSvc().findByBranch({
                    userId: 'u1',
                    owner: 'acme',
                    repo: 'site',
                    branch: 'task/a-12',
                }),
            ).resolves.toMatchObject({ workId: 'app-2', taskId: 'app-task', isTaskRepo: true });
            expect(tasks.findByWorkAndBranchRef).toHaveBeenCalledTimes(2);
        });

        it('a Task-repository owner of a LATER number beats a same-numbered Task elsewhere', async () => {
            // The delivery lists #12 then #13. The directory Work has a Task #12
            // (in `site-data`); the App Work owns #13 in `site`. Trying #12 in
            // every Work first would hand back the directory Work's Task —
            // which the CI consumer then drops as "not the Task repository",
            // losing the real match.
            works.findByUser = jest.fn().mockResolvedValue([directory, app]);
            tasks.findByWorkAndPrNumber = jest
                .fn()
                .mockImplementation(async (workId: string, prNumber: number) => {
                    if (workId === 'dir-1' && prNumber === 12) return DIR_TASK;
                    if (workId === 'app-1' && prNumber === 13) return APP_TASK;
                    return null;
                });

            await expect(
                makeSvc().findByPullRequests(
                    { userId: 'u1', owner: 'acme', repo: 'site' },
                    [12, 13],
                ),
            ).resolves.toMatchObject({ workId: 'app-1', prNumber: 13, isTaskRepo: true });
            expect(works.findByUser).toHaveBeenCalledTimes(1);
        });

        it('still reports a Task found only in a Work that merely shares the repository — marked as NOT its Task repository', async () => {
            // Decorating consumers keep their old link; acting consumers see
            // `isTaskRepo: false` and refuse it, exactly as before.
            works.findByUser = jest.fn().mockResolvedValue([app, directory]);
            tasks.findByWorkAndPrNumber = jest
                .fn()
                .mockImplementation(async (workId: string) =>
                    workId === 'dir-1' ? DIR_TASK : null,
                );

            await expect(
                makeSvc().findByPullRequest({
                    userId: 'u1',
                    owner: 'acme',
                    repo: 'site',
                    prNumber: 12,
                }),
            ).resolves.toMatchObject({
                workId: 'dir-1',
                repoRoles: ['website'],
                isTaskRepo: false,
            });
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
