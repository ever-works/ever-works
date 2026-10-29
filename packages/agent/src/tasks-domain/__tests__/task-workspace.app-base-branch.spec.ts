import { WORK_KINDS } from '@ever-works/contracts';
import { TaskStatus, type Task } from '../../entities/task.entity';
import { resolveTaskRepository } from '../task-repository';
import { TaskWorkspaceService } from '../task-workspace.service';

/** Constructor slots, so the doubles are typed against the real contracts. */
type ServiceArgs = ConstructorParameters<typeof TaskWorkspaceService>;

/**
 * APW-08 T11 (ACC-08-06) — on an App Work whose base branch is `production`, a Task branch is cut
 * from `production` and its pull request targets `production`, never the repository's default
 * branch; and the clone is the `website`-role Work Repository, never `<slug>-data`.
 *
 * ## What this pins, and what it found
 *
 * T11 was written when `provisionForRun` still hard-coded `getRepoOwner()` / `getDataRepo()`
 * (`tasks.md:223-225`). That is no longer true on `develop`: every Task path now resolves its
 * repository through `resolveTaskRepository` (`task-repository.ts`), which answers the `website`
 * role for `app` — the one kind whose `data` role is off — and the base branch through
 * `work.taskIsolationBaseBranch`, which T11's listener and T50's backfill now write. So this spec
 * VERIFIES the consumers rather than driving a change in them: provisioning (cloud), the Fleet
 * workspace description, and the pull request a node-pushed branch opens. If any of them ever
 * drifts back to the `data` role, or to the repository default while a base branch is set, it
 * fails here.
 *
 * The App Work double below answers a DIFFERENT repository for every role, so a call on the wrong
 * role is a visibly wrong call rather than a lucky match.
 */

const TASK_ID = '123e4567-e89b-12d3-a456-426614174000';
const BRANCH = 'task/t-42-123e4567e89b12d3a456426614174000';

function makeAppWork(over: Record<string, unknown> = {}) {
    return {
        id: 'work-app',
        kind: 'app',
        slug: 'shop',
        gitProvider: 'github',
        userId: 'user-1',
        organizationId: null,
        tenantId: null,
        // The column T11 writes. Off here on purpose: an App Work is isolated regardless.
        taskIsolation: 'off',
        taskIsolationBaseBranch: 'production',
        taskIsolationTargetRepo: 'website',
        taskBranchCleanup: 'on-merge',
        getRepoOwner: (role: string = 'data') => (role === 'website' ? 'acme' : `owner-of-${role}`),
        getDataRepo: () => 'shop-data',
        getWebsiteRepo: () => 'shop',
        getMainRepo: () => 'shop-work',
        ...over,
    };
}

function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: TASK_ID,
        slug: 't-42',
        title: 'Change the checkout copy',
        userId: 'user-1',
        workId: 'work-app',
        status: TaskStatus.IN_PROGRESS,
        // The Task asks for OFF: on an App Work it cannot opt out (FR-9).
        isolationMode: 'off',
        branchRef: null,
        branchState: null,
        prNumber: null,
        prUrl: null,
        ...over,
    } as unknown as Task;
}

describe('APW-08 T11 — an App Work Task cuts from and targets its base branch, on the Work Repository', () => {
    let works: { findById: jest.Mock };
    let tasks: { updateById: jest.Mock; findById: jest.Mock };
    let runs: { setWorkspaceMeta: jest.Mock; updateTelemetry: jest.Mock };
    let workspaceFacade: { provision: jest.Mock };
    let gitFacade: {
        getAccessToken: jest.Mock;
        getRepository: jest.Mock;
        createPullRequest: jest.Mock;
    };
    let transitions: { transition: jest.Mock };

    const build = () =>
        new TaskWorkspaceService(
            works as unknown as ServiceArgs[0],
            tasks as unknown as ServiceArgs[1],
            runs as unknown as ServiceArgs[2],
            workspaceFacade as unknown as ServiceArgs[3],
            gitFacade as unknown as ServiceArgs[4],
            transitions as unknown as ServiceArgs[5],
        );

    beforeEach(() => {
        works = { findById: jest.fn().mockResolvedValue(makeAppWork()) };
        tasks = { updateById: jest.fn().mockResolvedValue(undefined), findById: jest.fn() };
        runs = {
            setWorkspaceMeta: jest.fn().mockResolvedValue(undefined),
            updateTelemetry: jest.fn().mockResolvedValue(undefined),
        };
        workspaceFacade = {
            provision: jest.fn().mockResolvedValue({
                path: '/ws/task',
                baseSha: 'abc123def456',
                reused: false,
                branch: BRANCH,
                bindingKey: TASK_ID,
            }),
        };
        gitFacade = {
            getAccessToken: jest.fn().mockResolvedValue('tok-123'),
            // The repository DEFAULT is `main` — the branch a wrong reading would land on.
            getRepository: jest.fn(async (owner: string, repo: string) => ({
                defaultBranch: 'main',
                cloneUrl: `https://github.com/${owner}/${repo}.git`,
            })),
            createPullRequest: jest
                .fn()
                .mockResolvedValue({ number: 7, url: 'https://github.com/acme/shop/pull/7' }),
        };
        transitions = { transition: jest.fn().mockResolvedValue(undefined) };
    });

    describe('provisionForRun (cloud)', () => {
        const input = () => ({
            task: makeTask(),
            userId: 'user-1',
            runId: 'run-1',
            agentCanCommit: true,
        });

        it('cuts the Task branch from `production`, never the repository default', async () => {
            const result = await build().provisionForRun(input());

            expect(result).not.toBeNull();
            expect(workspaceFacade.provision).toHaveBeenCalledTimes(1);
            expect(workspaceFacade.provision.mock.calls[0][0]).toMatchObject({
                baseRef: 'production',
            });
            expect(workspaceFacade.provision.mock.calls[0][0].baseRef).not.toBe('main');
        });

        it('clones the `website`-role Work Repository, not `<slug>-data`', async () => {
            await build().provisionForRun(input());

            expect(gitFacade.getRepository).toHaveBeenCalledWith('acme', 'shop', {
                userId: 'user-1',
                providerId: 'github',
                workId: 'work-app',
            });
            for (const [owner, repo] of gitFacade.getRepository.mock.calls) {
                expect(repo).not.toBe('shop-data');
                expect(owner).not.toBe('owner-of-data');
            }
            expect(workspaceFacade.provision.mock.calls[0][0]).toMatchObject({
                repoUrl: 'https://github.com/acme/shop.git',
            });
        });

        it('isolates the Task even with the Work setting off and the Task asking for off (FR-9)', async () => {
            works.findById.mockResolvedValue(makeAppWork({ taskIsolation: 'off' }));
            const result = await build().provisionForRun({
                ...input(),
                task: makeTask({ isolationMode: 'off' }),
            });

            expect(result).toMatchObject({ cwd: '/ws/task', branch: BRANCH });
        });

        it('falls back to the repository default only when no base branch is recorded', async () => {
            works.findById.mockResolvedValue(makeAppWork({ taskIsolationBaseBranch: null }));
            await build().provisionForRun(input());

            expect(workspaceFacade.provision.mock.calls[0][0]).toMatchObject({ baseRef: 'main' });
        });
    });

    describe('describeFleetWorkspace (a Fleet node provisions itself)', () => {
        it('describes the Work Repository at `production`', async () => {
            const spec = await build().describeFleetWorkspace({
                task: makeTask(),
                userId: 'user-1',
            });

            expect(spec).toMatchObject({
                repositoryId: 'acme/shop',
                repoUrl: 'https://github.com/acme/shop.git',
                baseRef: 'production',
            });
        });
    });

    describe('openPullRequestForBranch (through finalizeRemotePush, the node-pushed path)', () => {
        const input = () => ({
            task: makeTask(),
            userId: 'user-1',
            agentId: 'agent-1',
            agentCanOpenPullRequests: true,
            branch: BRANCH,
            headSha: 'b'.repeat(40),
            baseSha: 'a'.repeat(40),
            changedFiles: 3,
            runId: 'run-1',
            gateStatus: 'green' as const,
        });

        it('opens the pull request into `production` on the Work Repository', async () => {
            const outcome = await build().finalizeRemotePush(input());

            expect(outcome).toMatchObject({ outcome: 'pr-opened', prNumber: 7 });
            expect(gitFacade.createPullRequest).toHaveBeenCalledTimes(1);
            expect(gitFacade.createPullRequest.mock.calls[0][0]).toMatchObject({
                owner: 'acme',
                repo: 'shop',
                head: BRANCH,
                base: 'production',
            });
            expect(gitFacade.createPullRequest.mock.calls[0][0].base).not.toBe('main');
        });
    });
});

describe('APW-08 T11 — resolveTaskRepository golden table (every kind × every target-repo value)', () => {
    /** A Work double whose three roles are three different repositories. */
    function workOf(kind: string | undefined, taskIsolationTargetRepo: string | undefined) {
        return {
            kind,
            taskIsolationTargetRepo,
            getRepoOwner: (role: string = 'data') => `owner-${role}`,
            getDataRepo: () => 'repo-data',
            getWebsiteRepo: () => 'repo-website',
        };
    }

    /**
     * Written out, not computed: `app` acts on its Work Repository (the `website` role), the
     * repo-less `project` kind on nothing, and every other kind on its `data` repository — exactly
     * as before T11.
     */
    function expected(
        kind: string | undefined,
    ): { role: string; owner: string; repo: string } | null {
        if (kind === 'app')
            return { role: 'website', owner: 'owner-website', repo: 'repo-website' };
        if (kind === 'project') return null;
        return { role: 'data', owner: 'owner-data', repo: 'repo-data' };
    }

    // `taskIsolationTargetRepo` is RECORDED (T11 writes `website` on an App Work), never an
    // override: no value of it — the default, the DTO's values, the web's reserved `linked`, or
    // garbage — moves any kind to another repository.
    const TARGET_VALUES = [
        'work-output',
        'data',
        'provider',
        'website',
        'linked',
        'banana',
        undefined,
    ];

    it.each([...WORK_KINDS, undefined, 'something-new'])('kind %p', (kind) => {
        for (const target of TARGET_VALUES) {
            const got = resolveTaskRepository(workOf(kind, target));
            expect({ kind, target, got }).toEqual({ kind, target, got: expected(kind) });
        }
    });
});
