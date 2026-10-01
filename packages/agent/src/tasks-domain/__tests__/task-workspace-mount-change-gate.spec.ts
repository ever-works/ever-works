import { TaskStatus, type Task } from '../../entities/task.entity';
import { TaskWorkspaceService } from '../task-workspace.service';
import type {
    AppWorkChangeGate,
    AppWorkChangeGateInput,
    AppWorkChangeGateVerdict,
} from '../app-work-change-gate.port';

/**
 * APW-08 — the App Work change gate on the MOUNT path.
 *
 * `finalizeMountPush` opens a pull request in any repository a fleet run pushed
 * as a mount. Mounts come from repository-registry connections — agent
 * attachments and Task extras — and a connection is just a URL: nothing stops
 * it naming ANOTHER App Work's code repository. Every other change-gate call
 * is keyed on the Task's own Work, so that App Work's rules never ran, and a
 * Task in Work A could open a pull request in App Work B's repository
 * (verified end to end by an adversarial review with an executed probe).
 *
 * The mount is now judged against the rules of every App Work whose Task
 * repository it is, with THAT Work's coordinates, credentials and base, before
 * any of `finalizeMountPush`'s three branches.
 */

const USER = 'user-1';
const APP_B = {
    id: 'work-app-b',
    name: 'Shop App',
    kind: 'app',
    gitProvider: 'github',
    taskIsolationBaseBranch: 'production',
    // An App Work's code lives in its WEBSITE role; `getDataRepo` is the
    // phantom `${slug}-data` that must never be used for it.
    getRepoOwner: () => 'acme',
    getMainRepo: () => 'shop-app-main',
    getWebsiteRepo: () => 'shop-app',
    getDataRepo: () => 'shop-app-data',
};
const DIRECTORY_C = {
    id: 'work-dir-c',
    name: 'Tools Directory',
    kind: 'directory',
    gitProvider: 'github',
    taskIsolationBaseBranch: null,
    getRepoOwner: () => 'acme',
    getMainRepo: () => 'tools-main',
    getWebsiteRepo: () => 'tools-site',
    getDataRepo: () => 'tools-data',
};
const WORK_A = {
    id: 'work-a',
    name: 'Platform',
    kind: 'directory',
    gitProvider: 'github',
    taskIsolationBaseBranch: null,
    getRepoOwner: () => 'acme',
    getMainRepo: () => 'platform-main',
    getWebsiteRepo: () => 'platform-site',
    getDataRepo: () => 'platform',
};

function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        slug: 'TSK-9',
        title: 'Change the checkout',
        userId: USER,
        workId: WORK_A.id,
        branchRef: 'task/tsk-9-task1',
        branchState: 'pushed',
        status: TaskStatus.IN_PROGRESS,
        labels: ['checkout'],
        linkedPullRequests: null,
        ...over,
    } as unknown as Task;
}

function refused(paths = ['.github/workflows/deploy.yml']): AppWorkChangeGateVerdict {
    return {
        allowed: false,
        message: 'This change edits paths this Work protects, which an agent may not change.',
        paths,
    };
}

function harness(opts: { bound?: boolean; task?: Task } = {}) {
    const task = opts.task ?? makeTask();
    const m = {
        findById: jest.fn(async (id: string) =>
            id === WORK_A.id ? WORK_A : id === APP_B.id ? APP_B : null,
        ),
        findByUser: jest.fn(async () => [WORK_A, APP_B, DIRECTORY_C]),
        updateById: jest.fn(async () => undefined),
        findTask: jest.fn(async () => task),
        getRepository: jest.fn(async () => ({ defaultBranch: 'main', cloneUrl: '' })),
        createPullRequest: jest.fn(async () => ({
            number: 42,
            url: 'https://github.com/acme/shop-app/pull/42',
        })),
        transition: jest.fn(async () => undefined),
        post: jest.fn(async (_userId: string, _message: { body: string }) => undefined),
        evaluate: jest.fn(
            async (_input: AppWorkChangeGateInput): Promise<AppWorkChangeGateVerdict> => ({
                allowed: true,
                note: null,
            }),
        ),
    };
    const gate: AppWorkChangeGate = {
        evaluate: m.evaluate,
        checkPaths: jest.fn(async () => {
            throw new Error('the mount path must not call checkPaths');
        }),
    };
    const service = new TaskWorkspaceService(
        { findById: m.findById, findByUser: m.findByUser } as never, // works
        { updateById: m.updateById, findById: m.findTask } as never, // tasks
        {} as never, // runs
        {} as never, // workspaceFacade
        { getRepository: m.getRepository, createPullRequest: m.createPullRequest } as never, // gitFacade
        { transition: m.transition } as never, // transitions
        { post: m.post } as never, // taskChat
        undefined as never, // mergePolicy
        undefined as never, // activityLog
        undefined as never, // agentRepoAttachments
        undefined as never, // repoConnections
        opts.bound === false ? (undefined as never) : gate,
    );
    return { service, m, task };
}

const push = (task: Task, over: Record<string, unknown> = {}) => ({
    task,
    userId: USER,
    agentId: 'agent-1',
    agentCanOpenPullRequests: true,
    repositoryId: 'acme/shop-app',
    branch: 'task/tsk-9-task1',
    baseRef: 'main',
    headSha: 'e'.repeat(40),
    primaryPrUrl: null,
    summary: null,
    ...over,
});

const recorded = (m: ReturnType<typeof harness>['m']) =>
    (m.updateById.mock.calls.at(-1) as unknown as [string, { linkedPullRequests: unknown[] }])?.[1]
        ?.linkedPullRequests ?? [];
const blocked = (m: ReturnType<typeof harness>['m']) =>
    m.transition.mock.calls.some((call) => (call as unknown[])[1] === TaskStatus.BLOCKED);

describe('finalizeMountPush — a mount that is ANOTHER App Work’s code repository', () => {
    it('judges it with THAT Work’s coordinates and credentials, at the base the pull request merges into', async () => {
        const { service, m, task } = harness();

        await service.finalizeMountPush(push(task));

        expect(m.evaluate).toHaveBeenCalledTimes(1);
        const handed = m.evaluate.mock.calls[0][0];
        expect(handed).toMatchObject({
            owner: 'acme',
            repo: 'shop-app',
            // The mount's planned base — the branch its pull request merges into —
            // NOT B's isolation base `production`: judging one base while the pull
            // request targets another refused changes the agent never made, or
            // allowed ones it did (third adversarial review).
            baseRef: 'main',
            branch: 'task/tsk-9-task1',
            gitOptions: { userId: USER, providerId: 'github', workId: APP_B.id },
            taskLabels: ['checkout'],
        });
        expect(handed.work).toBe(APP_B);
    });

    it('opens the pull request exactly as before when those rules allow the change', async () => {
        const { service, m, task } = harness();

        await expect(service.finalizeMountPush(push(task))).resolves.toMatchObject({
            outcome: 'pr-opened',
            prNumber: 42,
        });
        expect(m.createPullRequest).toHaveBeenCalledTimes(1);
        expect(blocked(m)).toBe(false);
    });

    it('REFUSES: no pull request, a failed entry naming why, a message, and a blocked Task', async () => {
        const { service, m, task } = harness();
        m.evaluate.mockResolvedValue(refused());

        const outcome = await service.finalizeMountPush(push(task));

        expect(outcome).toMatchObject({
            repositoryId: 'acme/shop-app',
            outcome: 'blocked-by-guard',
        });
        expect(outcome.prNumber).toBeUndefined();
        expect(m.createPullRequest).not.toHaveBeenCalled();
        expect(recorded(m)).toEqual([
            expect.objectContaining({
                repositoryId: 'acme/shop-app',
                state: 'failed',
                prNumber: null,
                error: expect.stringContaining('App Work "Shop App"'),
            }),
        ]);
        const body = String(m.post.mock.calls[0]?.[1]?.body ?? '');
        expect(body).toContain('.github/workflows/deploy.yml');
        expect(body).toContain('no pull request was opened');
        expect(blocked(m)).toBe(true);
    });

    it('REFUSES on the re-run of an OPEN pull request, keeping its link and saying it now carries the change', async () => {
        const task = makeTask({
            linkedPullRequests: [
                {
                    repositoryId: 'acme/shop-app',
                    branch: 'task/tsk-9-task1',
                    baseRef: 'main',
                    headSha: 'a'.repeat(40),
                    prNumber: 42,
                    prUrl: 'https://github.com/acme/shop-app/pull/42',
                    state: 'pr-open',
                    error: null,
                    updatedAt: '2026-09-20T00:00:00.000Z',
                },
            ],
        });
        const { service, m } = harness({ task });
        m.evaluate.mockResolvedValue(refused());

        const outcome = await service.finalizeMountPush(push(task));

        // Not the idempotent "pr-opened" re-record: that would report the pull
        // request that now carries a refused change as fine.
        expect(outcome).toMatchObject({
            outcome: 'blocked-by-guard',
            prNumber: 42,
            prUrl: 'https://github.com/acme/shop-app/pull/42',
        });
        expect(recorded(m)).toEqual([
            expect.objectContaining({ state: 'failed', prNumber: 42, error: expect.any(String) }),
        ]);
        expect(String(m.post.mock.calls[0]?.[1]?.body ?? '')).toContain(
            'pull request #42 (https://github.com/acme/shop-app/pull/42) now contains this change',
        );
        expect(m.createPullRequest).not.toHaveBeenCalled();
        expect(blocked(m)).toBe(true);
    });

    it('REFUSES when pull requests are off too — the push landed in that repository either way', async () => {
        // The question and failure paths call finalizeMountPush with PRs off.
        const { service, m, task } = harness();
        m.evaluate.mockResolvedValue(refused());

        await expect(
            service.finalizeMountPush(push(task, { agentCanOpenPullRequests: false })),
        ).resolves.toMatchObject({ outcome: 'blocked-by-guard' });
        expect(recorded(m)).toEqual([expect.objectContaining({ state: 'failed' })]);
        expect(blocked(m)).toBe(true);
    });

    it('fails CLOSED when the gate throws', async () => {
        const { service, m, task } = harness();
        m.evaluate.mockRejectedValue(new Error('provider down'));

        await expect(service.finalizeMountPush(push(task))).resolves.toMatchObject({
            outcome: 'blocked-by-guard',
            error: expect.stringContaining('could not be read'),
        });
        expect(m.createPullRequest).not.toHaveBeenCalled();
    });

    it('fails CLOSED when the owner’s Works cannot be read', async () => {
        const { service, m, task } = harness();
        m.findByUser.mockRejectedValue(new Error('db down'));

        await expect(service.finalizeMountPush(push(task))).resolves.toMatchObject({
            outcome: 'blocked-by-guard',
        });
        expect(m.createPullRequest).not.toHaveBeenCalled();
    });

    it('proceeds when no gate is bound — nothing was promised, as on the primary path', async () => {
        const { service, m, task } = harness({ bound: false });
        m.evaluate.mockResolvedValue(refused());

        await expect(service.finalizeMountPush(push(task))).resolves.toMatchObject({
            outcome: 'pr-opened',
        });
        expect(m.findByUser).not.toHaveBeenCalled();
    });
});

describe('finalizeMountPush — mounts that are no App Work’s code repository', () => {
    it.each([
        ['a repository that is no Work at all', 'acme/some-lib'],
        ['a directory Work’s repository (no change gate exists for it)', 'acme/tools-data'],
        [
            'an App Work’s phantom data repository, which is not its Task repository',
            'acme/shop-app-data',
        ],
    ])('asks no gate for %s', async (_what, repositoryId) => {
        const { service, m, task } = harness();
        m.evaluate.mockResolvedValue(refused());

        await expect(
            service.finalizeMountPush(push(task, { repositoryId })),
        ).resolves.toMatchObject({
            outcome: 'pr-opened',
        });
        expect(m.evaluate).not.toHaveBeenCalled();
    });
});

describe('finalizeMountPush — the judged base, and recovering from a refusal', () => {
    it('judges a mount with no planned base at the repository default — where its pull request would go', async () => {
        const { service, m, task } = harness();
        m.getRepository.mockResolvedValue({ defaultBranch: 'trunk', cloneUrl: '' });

        await service.finalizeMountPush(push(task, { baseRef: null }));

        expect(m.evaluate.mock.calls[0][0]).toMatchObject({ baseRef: 'trunk' });
    });

    it('marks a refusal of an OPEN pull request so the next ALLOWED run re-records it instead of opening another', async () => {
        // Third adversarial review, reproduced: the refusal rewrote the entry to
        // `failed`; the next allowed run did not recognise it, asked the provider
        // for a second pull request (422 "already exists") and then wiped the link.
        const open = {
            repositoryId: 'acme/shop-app',
            branch: 'task/tsk-9-task1',
            baseRef: 'main',
            headSha: 'a'.repeat(40),
            prNumber: 42,
            prUrl: 'https://github.com/acme/shop-app/pull/42',
            state: 'pr-open' as const,
            error: null,
            updatedAt: '2026-09-20T00:00:00.000Z',
        };
        const task = makeTask({ linkedPullRequests: [open] });
        const { service, m } = harness({ task });
        m.evaluate.mockResolvedValueOnce(refused());

        await service.finalizeMountPush(push(task));
        const afterRefusal = recorded(m)[0] as Record<string, unknown>;
        expect(afterRefusal).toMatchObject({ state: 'failed', prNumber: 42, refusedByGuard: true });

        // The change is fixed; the next run is allowed.
        m.findTask.mockResolvedValue(makeTask({ linkedPullRequests: [afterRefusal as never] }));
        const outcome = await service.finalizeMountPush(push(task));

        expect(outcome).toMatchObject({ outcome: 'pr-opened', prNumber: 42 });
        expect(m.createPullRequest).not.toHaveBeenCalled();
        const restored = recorded(m)[0] as Record<string, unknown>;
        expect(restored).toMatchObject({ state: 'pr-open', prNumber: 42, error: null });
        expect(restored.refusedByGuard).toBeUndefined();
    });

    it('never re-records a DISCARD survivor, and never drops its link when opening another fails', async () => {
        // `failed` with a kept link and no refusal flag: the operator tried to
        // throw this pull request away. It must stay unmatched — and the link,
        // the operator's only way back to it, must survive a failed open.
        const survivor = {
            repositoryId: 'acme/shop-app',
            branch: 'task/tsk-9-task1',
            baseRef: 'main',
            headSha: null,
            prNumber: 42,
            prUrl: 'https://github.com/acme/shop-app/pull/42',
            state: 'failed' as const,
            error: 'branch delete failed — the branch is still on the remote: 403',
            updatedAt: '2026-09-20T00:00:00.000Z',
        };
        const task = makeTask({ linkedPullRequests: [survivor] });
        const { service, m } = harness({ task });
        m.createPullRequest.mockRejectedValue(new Error('422: A pull request already exists'));

        const outcome = await service.finalizeMountPush(push(task));

        expect(m.createPullRequest).toHaveBeenCalledTimes(1);
        expect(outcome).toMatchObject({ outcome: 'failed' });
        expect(recorded(m)[0]).toMatchObject({ state: 'failed', prNumber: 42 });
    });

    it('keeps an existing link on the PRs-off path too', async () => {
        const task = makeTask({
            linkedPullRequests: [
                {
                    repositoryId: 'acme/shop-app',
                    branch: 'task/tsk-9-task1',
                    baseRef: 'main',
                    headSha: null,
                    prNumber: 42,
                    prUrl: 'https://github.com/acme/shop-app/pull/42',
                    state: 'failed',
                    error: 'branch delete failed',
                    updatedAt: '2026-09-20T00:00:00.000Z',
                },
            ],
        });
        const { service, m } = harness({ task });

        await service.finalizeMountPush(push(task, { agentCanOpenPullRequests: false }));

        expect(recorded(m)[0]).toMatchObject({ state: 'pushed', prNumber: 42 });
    });
});

/**
 * Third adversarial review: an open mount pull request picks up new commits on
 * paths that never call `finalizeMountPush` — a cancel, a question for a
 * settled run, a mount the node reports as unpushed / empty / not at all. The
 * primary pull request is re-judged on those paths; mount pull requests now are.
 */
describe('judgeMountedPullRequests', () => {
    const open = (over: Record<string, unknown> = {}) => ({
        repositoryId: 'acme/shop-app',
        branch: 'task/tsk-9-task1',
        baseRef: 'main',
        headSha: null,
        prNumber: 42,
        prUrl: 'https://github.com/acme/shop-app/pull/42',
        state: 'pr-open' as const,
        error: null,
        updatedAt: '2026-09-20T00:00:00.000Z',
        ...over,
    });

    it('refuses an open mount pull request whose recorded branch the Work’s rules now refuse', async () => {
        const task = makeTask({ linkedPullRequests: [open() as never] });
        const { service, m } = harness({ task });
        m.evaluate.mockResolvedValue(refused());

        const outcomes = await service.judgeMountedPullRequests({
            task,
            userId: USER,
            agentId: 'agent-1',
        });

        expect(outcomes).toEqual([
            expect.objectContaining({ outcome: 'blocked-by-guard', prNumber: 42 }),
        ]);
        expect(m.evaluate.mock.calls[0][0]).toMatchObject({
            branch: 'task/tsk-9-task1',
            baseRef: 'main',
        });
        expect(recorded(m)[0]).toMatchObject({
            state: 'failed',
            prNumber: 42,
            refusedByGuard: true,
        });
        expect(blocked(m)).toBe(true);
    });

    it('does nothing when the rules allow it, for repositories already finalised, or with no gate', async () => {
        const task = makeTask({ linkedPullRequests: [open() as never] });

        const allowed = harness({ task });
        await expect(
            allowed.service.judgeMountedPullRequests({ task, userId: USER, agentId: 'agent-1' }),
        ).resolves.toEqual([]);

        const excepted = harness({ task });
        excepted.m.evaluate.mockResolvedValue(refused());
        await expect(
            excepted.service.judgeMountedPullRequests({
                task,
                userId: USER,
                agentId: 'agent-1',
                except: new Set(['acme/shop-app']),
            }),
        ).resolves.toEqual([]);
        expect(excepted.m.evaluate).not.toHaveBeenCalled();

        const unbound = harness({ task, bound: false });
        await expect(
            unbound.service.judgeMountedPullRequests({ task, userId: USER, agentId: 'agent-1' }),
        ).resolves.toEqual([]);
    });

    it('skips entries that are not open pull requests', async () => {
        const task = makeTask({
            linkedPullRequests: [
                open({ state: 'pushed', prNumber: null, prUrl: null }) as never,
                open({
                    repositoryId: 'acme/other',
                    state: 'failed',
                    refusedByGuard: true,
                }) as never,
            ],
        });
        const { service, m } = harness({ task });
        m.evaluate.mockResolvedValue(refused());

        await expect(
            service.judgeMountedPullRequests({ task, userId: USER, agentId: 'agent-1' }),
        ).resolves.toEqual([]);
        expect(m.evaluate).not.toHaveBeenCalled();
    });
});
