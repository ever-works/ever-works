import { TaskStatus, type Task } from '../../entities/task.entity';
import { TaskWorkspaceService } from '../task-workspace.service';

/** Constructor slots, so the doubles are typed against the real contracts. */
type ServiceArgs = ConstructorParameters<typeof TaskWorkspaceService>;

/**
 * Agent execution v2 (slice B) — `finalizeRemotePush`.
 *
 * A fleet node pushed the branch itself; the platform's job is what a
 * cloud run does AFTER its push: record the branch, open the PR (or leave
 * it to a human), transition to review. Same helper as the cloud path,
 * so the two cannot drift.
 */

function makeWork(over: Record<string, unknown> = {}) {
    return {
        id: 'work-1',
        gitProvider: 'github',
        taskIsolationBaseBranch: null,
        organizationId: null,
        tenantId: null,
        getRepoOwner: () => 'acme',
        getDataRepo: () => 'site-data',
        ...over,
    };
}

function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        slug: 'TSK-9',
        title: 'Fix login',
        userId: 'user-1',
        workId: 'work-1',
        status: TaskStatus.IN_PROGRESS,
        branchRef: null,
        branchState: null,
        prNumber: null,
        prUrl: null,
        ...over,
    } as unknown as Task;
}

describe('TaskWorkspaceService.finalizeRemotePush', () => {
    let works: { findById: jest.Mock };
    let tasks: { updateById: jest.Mock; findById: jest.Mock };
    let runs: { updateTelemetry: jest.Mock };
    let gitFacade: { getRepository: jest.Mock; createPullRequest: jest.Mock };
    let transitions: { transition: jest.Mock };

    const build = () =>
        new TaskWorkspaceService(
            works as unknown as ServiceArgs[0],
            tasks as unknown as ServiceArgs[1],
            runs as unknown as ServiceArgs[2],
            {} as unknown as ServiceArgs[3],
            gitFacade as unknown as ServiceArgs[4],
            transitions as unknown as ServiceArgs[5],
        );

    beforeEach(() => {
        works = { findById: jest.fn().mockResolvedValue(makeWork()) };
        tasks = { updateById: jest.fn().mockResolvedValue(undefined), findById: jest.fn() };
        runs = { updateTelemetry: jest.fn().mockResolvedValue(undefined) };
        gitFacade = {
            getRepository: jest.fn().mockResolvedValue({
                defaultBranch: 'main',
                cloneUrl: 'https://github.com/acme/site-data.git',
            }),
            createPullRequest: jest
                .fn()
                .mockResolvedValue({ number: 7, url: 'https://github.com/acme/site-data/pull/7' }),
        };
        transitions = { transition: jest.fn().mockResolvedValue(undefined) };
    });

    const input = () => ({
        task: makeTask(),
        userId: 'user-1',
        agentId: 'agent-1',
        agentCanOpenPullRequests: true,
        branch: 'task/tsk-9-task1',
        headSha: 'b'.repeat(40),
        baseSha: 'a'.repeat(40),
        changedFiles: 3,
        runId: 'run-1',
        gate: { checksPassed: 2 },
        gateStatus: 'green' as const,
    });

    it('records the pushed branch, opens the PR against the default branch and moves the Task to review', async () => {
        const outcome = await build().finalizeRemotePush(input());
        expect(runs.updateTelemetry).toHaveBeenCalledWith('run-1', { changedFilesCount: 3 });
        expect(tasks.updateById).toHaveBeenCalledWith('task-1', {
            branchRef: 'task/tsk-9-task1',
            branchState: 'pushed',
            baseSha: 'a'.repeat(40),
        });
        expect(gitFacade.createPullRequest).toHaveBeenCalledWith(
            expect.objectContaining({
                owner: 'acme',
                repo: 'site-data',
                head: 'task/tsk-9-task1',
                base: 'main',
                title: 'Task TSK-9: Fix login',
                body: expect.stringContaining('all 2 acceptance checks green'),
            }),
            { userId: 'user-1', providerId: 'github', workId: 'work-1' },
        );
        expect(tasks.updateById).toHaveBeenCalledWith('task-1', {
            branchState: 'pr-open',
            prNumber: 7,
            prUrl: 'https://github.com/acme/site-data/pull/7',
        });
        expect(outcome).toEqual({
            outcome: 'pr-opened',
            prNumber: 7,
            prUrl: 'https://github.com/acme/site-data/pull/7',
        });
    });

    it('honours the Work base branch', async () => {
        works.findById.mockResolvedValue(makeWork({ taskIsolationBaseBranch: 'develop' }));
        await build().finalizeRemotePush(input());
        expect(gitFacade.createPullRequest).toHaveBeenCalledWith(
            expect.objectContaining({ base: 'develop' }),
            expect.anything(),
        );
    });

    it('leaves the PR to a human when the agent may not open one, but still moves to review', async () => {
        const outcome = await build().finalizeRemotePush({
            ...input(),
            agentCanOpenPullRequests: false,
        });
        expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
        expect(outcome).toEqual({ outcome: 'pushed-no-pr' });
    });

    it('is idempotent: a Task that already has a PR is not given another', async () => {
        const outcome = await build().finalizeRemotePush({
            ...input(),
            task: makeTask({ prNumber: 5, prUrl: 'https://github.com/acme/site-data/pull/5' }),
        });
        expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
        expect(outcome).toEqual({
            outcome: 'pr-opened',
            prNumber: 5,
            prUrl: 'https://github.com/acme/site-data/pull/5',
        });
        // One write, and it keeps the branch at `pr-open` — never a
        // `pushed` downgrade followed by a repair (review Q-R1-01).
        expect(tasks.updateById).toHaveBeenCalledTimes(1);
        expect(tasks.updateById).toHaveBeenCalledWith(
            'task-1',
            expect.objectContaining({ branchRef: 'task/tsk-9-task1', branchState: 'pr-open' }),
        );
    });

    it('refuses without a branch or a Work', async () => {
        await expect(build().finalizeRemotePush({ ...input(), branch: '  ' })).rejects.toThrow(
            /no branch/,
        );
        await expect(
            build().finalizeRemotePush({
                ...input(),
                task: makeTask({ workId: null } as Partial<Task>),
            }),
        ).rejects.toThrow(/lost its Work/);
    });

    describe('recordRemotePush (self-build slice Q — a run parked on an owner question)', () => {
        it('records the branch as pushed and stamps changed files without opening a PR or transitioning the Task', async () => {
            await build().recordRemotePush({
                task: makeTask(),
                branch: 'task/tsk-9-task1',
                runId: 'run-1',
                headSha: 'b'.repeat(40),
                baseSha: 'a'.repeat(40),
                changedFiles: 3,
            });
            expect(runs.updateTelemetry).toHaveBeenCalledWith('run-1', { changedFilesCount: 3 });
            expect(tasks.updateById).toHaveBeenCalledTimes(1);
            expect(tasks.updateById).toHaveBeenCalledWith('task-1', {
                branchRef: 'task/tsk-9-task1',
                branchState: 'pushed',
                baseSha: 'a'.repeat(40),
            });
            // No pull request, no Work lookup, no `in_review` transition:
            // partial work waits for the owner's answer, not for a review.
            expect(gitFacade.getRepository).not.toHaveBeenCalled();
            expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
            expect(transitions.transition).not.toHaveBeenCalled();
        });

        it('keeps pr-open when the Task already has a pull request (review Q-R1-01)', async () => {
            // A question asked in a LATER run of a Task whose earlier run
            // opened the PR: the row must not fall back to `pushed` with
            // prNumber / prUrl still set (the branch chip would lose the
            // PR link while the Inbox item still advertises it).
            await build().recordRemotePush({
                task: makeTask({ prNumber: 5, prUrl: 'https://github.com/acme/site-data/pull/5' }),
                branch: 'task/tsk-9-task1',
                baseSha: 'a'.repeat(40),
            });
            expect(tasks.updateById).toHaveBeenCalledTimes(1);
            expect(tasks.updateById).toHaveBeenCalledWith('task-1', {
                branchRef: 'task/tsk-9-task1',
                branchState: 'pr-open',
                baseSha: 'a'.repeat(40),
            });
            expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
            expect(transitions.transition).not.toHaveBeenCalled();
        });

        it('trims the branch and skips the telemetry stamp without a run id', async () => {
            await build().recordRemotePush({ task: makeTask(), branch: '  task/tsk-9-task1 ' });
            expect(runs.updateTelemetry).not.toHaveBeenCalled();
            expect(tasks.updateById).toHaveBeenCalledWith('task-1', {
                branchRef: 'task/tsk-9-task1',
                branchState: 'pushed',
            });
        });

        it('refuses without a branch, like finalizeRemotePush', async () => {
            await expect(
                build().recordRemotePush({ task: makeTask(), branch: '   ' }),
            ).rejects.toThrow(/without a branch/);
            expect(tasks.updateById).not.toHaveBeenCalled();
        });
    });
});
