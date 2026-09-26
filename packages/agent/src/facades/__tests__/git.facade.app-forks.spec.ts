import { GitFacadeService, GitOperationNotSupportedError } from '../git.facade';

/**
 * APW-02 T22 — the fork-lifecycle facade methods (plan §4.2, plan §10.2's
 * `git.facade.app-forks.spec.ts` row).
 *
 * The load-bearing assertions are about **absence**, exactly as in
 * `git.facade.pr-insights.spec.ts`: every one of these capabilities is
 * OPTIONAL on `IGitProviderPlugin`, and the lazy-plugin proxy in this codebase
 * over-reports optional methods (the known gotcha plan 04 §7.7 names). So the
 * facade must materialise the member off the RESOLVED plugin, verify it is
 * callable before calling it, and raise
 * `GitOperationNotSupportedError` otherwise — the one leaf
 * `FacadeExceptionFilter` maps to HTTP 409 **by that exact `name`**
 * (`apps/api/src/common/filters/facade-exception.filter.ts:78`, whose spec
 * `apps/api/src/common/filters/facade-exception.filter.spec.ts` is unchanged by
 * this task). The `name` is therefore asserted here, not assumed: it is the
 * whole coupling between this file and that filter.
 *
 * Plan §4.2 names nine methods in total — the seven APW-02 capabilities, plus
 * APW-09's `createBranchFromSha` / `updateBranchRef`, which are already in
 * `git.facade.ts` and are included here so one spec proves the guard holds for
 * all nine (tasks.md:318-324 says "the eight methods"; see the task report).
 *
 * The second half of this spec is the `cloneOrPull` coalescing key: plan §4.2
 * appends **both** `checkoutKey` and `expectExisting === true` to it, because a
 * plain clone that finds an empty repository legally leaves an initialised
 * directory behind, and an `expectExisting` caller handed that directory would
 * be told a repository exists that does not (FR-8).
 */

const OPTIONS = { providerId: 'github', userId: 'user-1', workId: 'work-1' } as const;

const COPY_INPUT = {
    sourceOwner: 'upstream-org',
    sourceRepo: 'widgets',
    sourceBranch: 'main',
    targetOwner: 'me',
    targetRepo: 'widgets-copy',
    maxSizeKb: 512_000,
};

const ACTIONS_INPUT = {
    disableWorkflowsExcept: ['.github/workflows/ever-works-build.yml'],
    skipWorkflowIds: [11, 12],
    maxWorkflows: 100,
};

const WEBHOOK_INPUT = {
    url: 'https://ever.works/api/webhooks/github',
    secret: 'shhh',
    events: ['push', 'workflow_run'],
};

const REPOSITORY = {
    owner: 'me',
    name: 'widgets',
    fullName: 'me/widgets',
    defaultBranch: 'main',
    isPrivate: false,
    url: 'https://github.com/me/widgets',
    cloneUrl: 'https://github.com/me/widgets.git',
};

const SYNC_RESULT = { outcome: 'fast_forwarded' as const };
const DIVERGENCE = {
    aheadBy: 2,
    behindBy: 3,
    upstreamHeadSha: 'a'.repeat(40),
    forkHeadSha: 'b'.repeat(40),
};
const COPY_RESULT = { pushedSha: 'c'.repeat(40), alreadyUpToDate: false };
const ACTIONS_RESULT = {
    actionsEnabled: true,
    disabled: [{ id: 2, path: '.github/workflows/deploy.yml' }],
    kept: [{ id: 1, path: '.github/workflows/ever-works-build.yml' }],
    enabled: [],
    seenIds: [1, 2],
    truncated: false,
};
const BRANCH = { name: 'ever-works/upstream-sync', commit: { sha: 'd'.repeat(40) } };

/** A facade whose plugin resolution is fixed — no registry, no credentials. */
function makeFacade(plugin: Record<string, unknown>) {
    const facade = new GitFacadeService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
    );
    (
        facade as unknown as {
            resolvePluginAndToken: () => Promise<{ plugin: unknown; token: string }>;
        }
    ).resolvePluginAndToken = jest
        .fn()
        .mockResolvedValue({ plugin: { id: 'github', ...plugin }, token: 'tok' });
    return facade;
}

/**
 * One row per method: the call, and the arguments the provider must receive
 * (before the token, which every row ends with).
 */
const FORWARDING_CASES: Array<{
    name: string;
    member: string;
    call: (facade: GitFacadeService) => Promise<unknown>;
    args: unknown[];
    resolves: unknown;
}> = [
    {
        name: 'findExistingFork',
        member: 'findExistingFork',
        call: (facade) => facade.findExistingFork('upstream-org', 'widgets', 'me', OPTIONS),
        args: ['upstream-org', 'widgets', 'me'],
        resolves: REPOSITORY,
    },
    {
        name: 'syncForkBranch',
        member: 'syncForkBranch',
        call: (facade) => facade.syncForkBranch('me', 'widgets', 'main', OPTIONS),
        args: ['me', 'widgets', 'main'],
        resolves: SYNC_RESULT,
    },
    {
        name: 'getForkDivergence',
        member: 'getForkDivergence',
        call: (facade) =>
            facade.getForkDivergence('me', 'widgets', 'main', 'upstream-org', 'main', OPTIONS),
        args: ['me', 'widgets', 'main', 'upstream-org', 'main'],
        resolves: DIVERGENCE,
    },
    {
        name: 'createRepositoryCopy',
        member: 'createRepositoryCopy',
        call: (facade) => facade.createRepositoryCopy(COPY_INPUT, OPTIONS),
        args: [COPY_INPUT],
        resolves: COPY_RESULT,
    },
    {
        name: 'setActionsPermissions',
        member: 'setActionsPermissions',
        call: (facade) => facade.setActionsPermissions('me', 'widgets', ACTIONS_INPUT, OPTIONS),
        args: ['me', 'widgets', ACTIONS_INPUT],
        resolves: ACTIONS_RESULT,
    },
    {
        name: 'createWebhook',
        member: 'createWebhook',
        call: (facade) => facade.createWebhook('me', 'widgets', WEBHOOK_INPUT, OPTIONS),
        args: ['me', 'widgets', WEBHOOK_INPUT],
        resolves: { id: 7, created: true },
    },
    {
        name: 'deleteWebhook',
        member: 'deleteWebhook',
        call: (facade) => facade.deleteWebhook('me', 'widgets', 7, OPTIONS),
        args: ['me', 'widgets', 7],
        resolves: undefined,
    },
    // APW-09's two (plan §4.2 counts them with the seven above).
    {
        name: 'createBranchFromSha',
        member: 'createBranchFromSha',
        call: (facade) =>
            facade.createBranchFromSha(
                'me',
                'widgets',
                'ever-works/upstream-sync',
                'e'.repeat(40),
                OPTIONS,
            ),
        args: ['me', 'widgets', 'ever-works/upstream-sync', 'e'.repeat(40)],
        resolves: BRANCH,
    },
    {
        name: 'updateBranchRef',
        member: 'updateBranchRef',
        call: (facade) =>
            facade.updateBranchRef(
                'me',
                'widgets',
                'ever-works/upstream-sync',
                'f'.repeat(40),
                { force: false },
                OPTIONS,
            ),
        args: ['me', 'widgets', 'ever-works/upstream-sync', 'f'.repeat(40), { force: false }],
        resolves: BRANCH,
    },
];

describe('GitFacadeService — APW-02 fork-lifecycle capabilities', () => {
    describe.each(FORWARDING_CASES)('$name', ({ member, call, args, resolves }) => {
        it('forwards every argument and the resolved token, and returns the provider answer', async () => {
            const impl = jest.fn().mockResolvedValue(resolves);
            const facade = makeFacade({ [member]: impl });

            await expect(call(facade)).resolves.toEqual(resolves);
            expect(impl).toHaveBeenCalledTimes(1);
            expect(impl).toHaveBeenCalledWith(...args, 'tok');
        });

        it('raises GitOperationNotSupportedError when the provider omits the member', async () => {
            const facade = makeFacade({});

            const error = await call(facade).catch((err: unknown) => err);

            expect(error).toBeInstanceOf(GitOperationNotSupportedError);
            expect(error).toMatchObject({
                // The exact string `FacadeExceptionFilter` switches on → 409.
                name: 'GitOperationNotSupportedError',
                operation: member,
                provider: 'github',
            });
        });

        it('raises it for a proxy that reports a non-function member', async () => {
            const facade = makeFacade({ [member]: undefined });

            await expect(call(facade)).rejects.toMatchObject({
                name: 'GitOperationNotSupportedError',
                operation: member,
            });
        });
    });

    it('names the missing capability in the message a 409 surfaces to the caller', async () => {
        const facade = makeFacade({});

        await expect(facade.findExistingFork('o', 'r', 'me', OPTIONS)).rejects.toThrow(
            "Git provider 'github' does not support findExistingFork.",
        );
    });

    it('passes a provider `null` (no fork by this account) straight through', async () => {
        const facade = makeFacade({ findExistingFork: jest.fn().mockResolvedValue(null) });

        await expect(facade.findExistingFork('o', 'r', 'me', OPTIONS)).resolves.toBeNull();
    });

    it('forwards the copy input by reference so a caller-owned ceiling reaches the provider', async () => {
        const createRepositoryCopy = jest.fn().mockResolvedValue(COPY_RESULT);
        const facade = makeFacade({ createRepositoryCopy });

        await facade.createRepositoryCopy(COPY_INPUT, OPTIONS);

        expect(createRepositoryCopy.mock.calls[0][0]).toBe(COPY_INPUT);
        expect(createRepositoryCopy.mock.calls[0][0].maxSizeKb).toBe(512_000);
    });
});

describe('GitFacadeService.cloneOrPull — the APW-02 coalescing key (plan §4.2)', () => {
    /** A plugin whose clone never settles until the test releases it. */
    function makeClonePlugin() {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const cloneOrPull = jest.fn(
            async (_options: { checkoutKey?: string; expectExisting?: boolean }) => {
                await gate;
                return '/tmp/checkout';
            },
        );
        return { cloneOrPull, release: () => release() };
    }

    const COORDS = { owner: 'upstream-org', repo: 'widgets' } as const;

    it('coalesces two identical calls onto one in-flight clone', async () => {
        const plugin = makeClonePlugin();
        const facade = makeFacade(plugin);

        const first = facade.cloneOrPull({ ...COORDS, checkoutKey: 'work:w1:data' }, OPTIONS);
        const second = facade.cloneOrPull({ ...COORDS, checkoutKey: 'work:w1:data' }, OPTIONS);
        plugin.release();

        await expect(Promise.all([first, second])).resolves.toEqual([
            '/tmp/checkout',
            '/tmp/checkout',
        ]);
        expect(plugin.cloneOrPull).toHaveBeenCalledTimes(1);
    });

    it('does NOT coalesce two calls that share coordinates and key but differ in expectExisting (FR-8)', async () => {
        const plugin = makeClonePlugin();
        const facade = makeFacade(plugin);

        const plain = facade.cloneOrPull({ ...COORDS, checkoutKey: 'work:w1:data' }, OPTIONS);
        const expecting = facade.cloneOrPull(
            { ...COORDS, checkoutKey: 'work:w1:data', expectExisting: true },
            OPTIONS,
        );
        plugin.release();

        await Promise.all([plain, expecting]);
        expect(plugin.cloneOrPull).toHaveBeenCalledTimes(2);
        // The flag is forwarded, so the provider can refuse the empty repository
        // instead of leaving a `git init` directory for the other caller.
        expect(plugin.cloneOrPull.mock.calls[1][0]).toMatchObject({ expectExisting: true });
    });

    it('does NOT coalesce two different checkout keys for one repository', async () => {
        const plugin = makeClonePlugin();
        const facade = makeFacade(plugin);

        const data = facade.cloneOrPull({ ...COORDS, checkoutKey: 'work:w1:data' }, OPTIONS);
        const work = facade.cloneOrPull({ ...COORDS, checkoutKey: 'work:w1:work' }, OPTIONS);
        plugin.release();

        await Promise.all([data, work]);
        expect(plugin.cloneOrPull).toHaveBeenCalledTimes(2);
    });

    it('still coalesces two `expectExisting` calls that agree', async () => {
        const plugin = makeClonePlugin();
        const facade = makeFacade(plugin);

        const first = facade.cloneOrPull({ ...COORDS, expectExisting: true }, OPTIONS);
        const second = facade.cloneOrPull({ ...COORDS, expectExisting: true }, OPTIONS);
        plugin.release();

        await Promise.all([first, second]);
        expect(plugin.cloneOrPull).toHaveBeenCalledTimes(1);
    });
});
