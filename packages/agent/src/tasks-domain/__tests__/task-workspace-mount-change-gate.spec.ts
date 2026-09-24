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
    it('judges it with THAT Work’s coordinates, credentials, base and the Task’s labels', async () => {
        const { service, m, task } = harness();

        await service.finalizeMountPush(push(task));

        expect(m.evaluate).toHaveBeenCalledTimes(1);
        const handed = m.evaluate.mock.calls[0][0];
        expect(handed).toMatchObject({
            owner: 'acme',
            repo: 'shop-app',
            // B's own base — where its rules live — not the mount's `main`.
            baseRef: 'production',
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
