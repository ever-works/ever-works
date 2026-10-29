import { TaskStatus, type Task } from '../../entities/task.entity';
import { TaskWorkspaceService } from '../task-workspace.service';
import type { TaskLifecyclePoster } from '../task-lifecycle-poster.port';

/** Constructor slots, so the doubles are typed against the real contracts. */
type ServiceArgs = ConstructorParameters<typeof TaskWorkspaceService>;

/**
 * APW-08 T26 / T54 (FR-43) — the pull request a finalize opens is posted into the Task's thread
 * as **Opened pull request #{number}.**, once: only when the number recorded now differs from
 * the one the Task carried. The post goes through `TASK_LIFECYCLE_POSTER` with the run's Agent and
 * the Work's kind (the poster posts for App Work Tasks only — `task-lifecycle-posts.spec.ts`).
 */
describe('TaskWorkspaceService — Opened pull request #{number}. (APW-08 FR-43)', () => {
    const PR_URL = 'https://github.com/acme/bookings/pull/12';

    let works: { findById: jest.Mock };
    let tasks: { updateById: jest.Mock; findById: jest.Mock };
    let runs: { updateTelemetry: jest.Mock };
    let gitFacade: { getRepository: jest.Mock; createPullRequest: jest.Mock };
    let lifecycle: { post: jest.Mock };

    const makeTask = (over: Partial<Task> = {}): Task =>
        ({
            id: 'task-1',
            slug: 'T-118',
            title: 'Add an SMS reminder',
            userId: 'user-1',
            workId: 'work-1',
            agentId: 'agent-task',
            status: TaskStatus.IN_PROGRESS,
            branchRef: null,
            branchState: null,
            prNumber: null,
            prUrl: null,
            ...over,
        }) as unknown as Task;

    const build = (poster: TaskLifecyclePoster | undefined = lifecycle) => {
        const args = new Array(14).fill(undefined) as unknown[];
        args[0] = works;
        args[1] = tasks;
        args[2] = runs;
        args[4] = gitFacade;
        args[13] = poster;
        return new TaskWorkspaceService(...(args as ServiceArgs));
    };

    const input = (task: Task = makeTask()) => ({
        task,
        userId: 'user-1',
        agentId: 'agent-run',
        agentCanOpenPullRequests: true,
        branch: 'task/t-118',
        headSha: 'b'.repeat(40),
    });

    beforeEach(() => {
        works = {
            findById: jest.fn().mockResolvedValue({
                id: 'work-1',
                kind: 'app',
                gitProvider: 'github',
                taskIsolationBaseBranch: null,
                organizationId: null,
                tenantId: null,
                getRepoOwner: () => 'acme',
                getDataRepo: () => 'bookings',
            }),
        };
        tasks = { updateById: jest.fn().mockResolvedValue(undefined), findById: jest.fn() };
        runs = { updateTelemetry: jest.fn().mockResolvedValue(undefined) };
        gitFacade = {
            getRepository: jest.fn().mockResolvedValue({ defaultBranch: 'main' }),
            createPullRequest: jest.fn().mockResolvedValue({ number: 12, url: PR_URL }),
        };
        lifecycle = { post: jest.fn().mockResolvedValue(true) };
    });

    it('posts once, with the number, as the run’s Agent and with the Work’s kind', async () => {
        const outcome = await build().finalizeRemotePush(input());

        expect(outcome).toMatchObject({ outcome: 'pr-opened', prNumber: 12 });
        expect(lifecycle.post).toHaveBeenCalledTimes(1);
        expect(lifecycle.post).toHaveBeenCalledWith({
            task: expect.objectContaining({ id: 'task-1', userId: 'user-1' }),
            post: { key: 'deliveryPosts.prOpened', params: { number: 12 } },
            agentId: 'agent-run',
            workKind: 'app',
        });
    });

    it('hands a non-App Work’s kind to the poster (which then posts nothing)', async () => {
        works.findById.mockResolvedValue({
            id: 'work-1',
            kind: 'website',
            gitProvider: 'github',
            taskIsolationBaseBranch: null,
            getRepoOwner: () => 'acme',
            getDataRepo: () => 'site',
        });
        await build().finalizeRemotePush(input());

        expect(lifecycle.post.mock.calls[0][0]).toMatchObject({ workKind: 'website' });
    });

    it('a push onto a Task that already has its pull request posts nothing', async () => {
        const withPr = makeTask({ prNumber: 12, prUrl: PR_URL, branchRef: 'task/t-118' });
        const outcome = await build().finalizeRemotePush(input(withPr));

        expect(outcome).toMatchObject({ outcome: 'pr-opened', prNumber: 12 });
        expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
        expect(lifecycle.post).not.toHaveBeenCalled();
    });

    it('a finalize that re-records the SAME pull request number posts nothing', async () => {
        const service = build();
        const open = (
            service as unknown as {
                openPullRequestForBranch: (a: Record<string, unknown>) => Promise<unknown>;
            }
        ).openPullRequestForBranch.bind(service);
        await open({
            task: makeTask({ prNumber: 12, prUrl: PR_URL }),
            work: await works.findById(),
            userId: 'user-1',
            agentId: 'agent-run',
            agentCanOpenPullRequests: true,
            owner: 'acme',
            repo: 'bookings',
            gitOptions: { userId: 'user-1', providerId: 'github', workId: 'work-1' },
            baseRef: 'main',
            branch: 'task/t-118',
            gateStatus: null,
        });

        expect(gitFacade.createPullRequest).toHaveBeenCalledTimes(1);
        expect(lifecycle.post).not.toHaveBeenCalled();
    });

    it('no pull request opened (the Agent may not open one) means no post', async () => {
        await build().finalizeRemotePush({ ...input(), agentCanOpenPullRequests: false });

        expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
        expect(lifecycle.post).not.toHaveBeenCalled();
    });

    it('a poster that throws never fails the finalize', async () => {
        lifecycle.post.mockRejectedValueOnce(new Error('boom'));
        await expect(build().finalizeRemotePush(input())).resolves.toMatchObject({
            outcome: 'pr-opened',
            prNumber: 12,
        });
    });

    it('without a bound poster the finalize is exactly as before', async () => {
        await expect(build(undefined).finalizeRemotePush(input())).resolves.toMatchObject({
            outcome: 'pr-opened',
            prNumber: 12,
        });
        expect(tasks.updateById).toHaveBeenCalledWith('task-1', {
            branchState: 'pr-open',
            prNumber: 12,
            prUrl: PR_URL,
        });
    });
});
