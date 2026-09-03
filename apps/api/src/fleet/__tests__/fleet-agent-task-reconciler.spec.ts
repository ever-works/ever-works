import { Logger } from '@nestjs/common';
import { FleetJobCompletedEvent, FleetJobLeasedEvent } from '@ever-works/agent/events';
import type { FleetAgentTaskResult, FleetJobView } from '@ever-works/contracts';
import {
    FleetAgentTaskReconcilerService,
    parseAgentTaskResult,
} from '../fleet-agent-task-reconciler.service';

/**
 * Agent execution v2 (slice B) — the reconciler.
 *
 * What these pin, in order of how much it would hurt to lose:
 *
 *   1. a lease marks the run STARTED (CAS) and moves the board chip;
 *   2. a successful report with a pushed branch marks the run completed
 *      with the CLI's summary, records gate results, opens the PR through
 *      the shared finalize tail, posts to the Task chat and drains the
 *      Work;
 *   3. a failed report marks the run failed with the node's reason, posts
 *      the failure (with the failing checks and the output tail) and files
 *      an Inbox notice;
 *   4. jobs that are not agent tasks, runs of another owner, and
 *      operator-cancelled jobs are ignored or only mirrored — never
 *      re-settled;
 *   5. (self-build slice Q) a report carrying `question` PARKS the run —
 *      terminal + awaitingInput, in that order, BEFORE the Inbox question
 *      exists — records the pushed branch without a pull request, and
 *      never fails the run, whatever the status / gate / git verdict says.
 */

const RUN = 'run-1';
const TASK = 'task-1';
const AGENT = 'agent-1';
const USER = 'user-1';
const NODE = '11111111-1111-4111-8111-111111111111';

function job(over: Partial<FleetJobView> = {}): FleetJobView {
    return {
        id: 'job-1',
        kind: 'agent-task',
        status: 'done',
        nodeId: NODE,
        requiredCapabilities: [],
        payload: { taskId: TASK, runId: RUN, agentId: AGENT, userId: USER },
        leaseExpiresAt: null,
        attempts: 1,
        maxAttempts: 3,
        createdAt: null,
        startedAt: null,
        completedAt: null,
        ...over,
    };
}

const successResult: FleetAgentTaskResult = {
    status: 'succeeded',
    taskId: TASK,
    runId: RUN,
    workspace: null,
    steps: [],
    model: {
        provider: 'claude-code',
        status: 'succeeded',
        exitCode: 0,
        durationMs: 5000,
        summary: 'Fixed it.',
        costUsd: 0.42,
        turns: 4,
    },
    checks: [{ id: 'unit', status: 'green', exitCode: 0, durationMs: 100 }],
    gateStatus: 'green',
    git: {
        branch: 'task/tsk-1-task1',
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        empty: false,
        pushed: true,
        changedFiles: 3,
    },
};

describe('FleetAgentTaskReconcilerService', () => {
    let runs: Record<string, jest.Mock>;
    let tasks: { findById: jest.Mock };
    let agents: { findById: jest.Mock };
    let runDenorm: { recordStarted: jest.Mock; recordTerminal: jest.Mock };
    let taskWorkspace: {
        finalizeRemotePush: jest.Mock;
        finalizeMountPush: jest.Mock;
        recordRemotePush: jest.Mock;
    };
    let taskChat: { post: jest.Mock };
    let dispatchGate: { drainForWork: jest.Mock };
    let inbox: { notice: jest.Mock; questionRaised: jest.Mock } | undefined;
    let nodes: { findById: jest.Mock };

    const build = () =>
        new FleetAgentTaskReconcilerService(
            runs as never,
            tasks as never,
            agents as never,
            runDenorm as never,
            taskWorkspace as never,
            taskChat as never,
            dispatchGate as never,
            inbox as never,
            nodes as never,
        );

    beforeEach(() => {
        runs = {
            findById: jest
                .fn()
                .mockResolvedValue({ id: RUN, userId: USER, agentId: AGENT, workId: 'work-1' }),
            markStarted: jest.fn().mockResolvedValue(true),
            markCompleted: jest.fn().mockResolvedValue(undefined),
            tryMarkCompleted: jest.fn().mockResolvedValue(true),
            markFailed: jest.fn().mockResolvedValue(undefined),
            setAwaitingInput: jest.fn().mockResolvedValue(undefined),
            updateGateResults: jest.fn().mockResolvedValue(undefined),
            updateTelemetry: jest.fn().mockResolvedValue(undefined),
        };
        tasks = {
            findById: jest.fn().mockResolvedValue({
                id: TASK,
                workId: 'work-1',
                title: 'Fix the thing',
                organizationId: null,
            }),
        };
        agents = {
            findById: jest
                .fn()
                .mockResolvedValue({ id: AGENT, permissions: { canOpenPullRequests: true } }),
        };
        runDenorm = {
            recordStarted: jest.fn().mockResolvedValue(true),
            recordTerminal: jest.fn().mockResolvedValue(true),
        };
        taskWorkspace = {
            finalizeRemotePush: jest.fn().mockResolvedValue({
                outcome: 'pr-opened',
                prNumber: 42,
                prUrl: 'https://github.com/acme/repo/pull/42',
            }),
            finalizeMountPush: jest.fn(async (input: { repositoryId: string }) => ({
                repositoryId: input.repositoryId,
                outcome: 'pr-opened',
                prNumber: 7,
                prUrl: `https://github.com/${input.repositoryId}/pull/7`,
            })),
            recordRemotePush: jest.fn().mockResolvedValue(undefined),
        };
        taskChat = { post: jest.fn().mockResolvedValue({}) };
        dispatchGate = { drainForWork: jest.fn().mockResolvedValue({ dispatched: false }) };
        inbox = {
            notice: jest.fn().mockResolvedValue(undefined),
            questionRaised: jest.fn().mockResolvedValue(undefined),
        };
        nodes = {
            findById: jest.fn().mockResolvedValue({ id: NODE, userId: USER, name: 'everdesk2' }),
        };
    });

    it('correlates only agent-task jobs that carry run and task ids', () => {
        expect(FleetAgentTaskReconcilerService.correlate(job())).toEqual({
            runId: RUN,
            taskId: TASK,
            agentId: AGENT,
        });
        expect(
            FleetAgentTaskReconcilerService.correlate(job({ kind: 'acceptance-checks' })),
        ).toBeNull();
        expect(
            FleetAgentTaskReconcilerService.correlate(job({ payload: { taskId: TASK } })),
        ).toBeNull();
        expect(FleetAgentTaskReconcilerService.correlate(job({ payload: null }))).toBeNull();
    });

    it('marks the run started on lease and moves the board chip', async () => {
        await build().onLeased(new FleetJobLeasedEvent(job({ status: 'leased' }), NODE, USER));
        expect(runs.markStarted).toHaveBeenCalledWith(RUN, 'job-1');
        expect(runDenorm.recordStarted).toHaveBeenCalledWith(TASK, RUN);
        expect(runs.updateTelemetry).toHaveBeenCalledWith(RUN, {
            currentActivity: expect.stringContaining('everdesk2'),
        });
    });

    it('does not touch the board when the run was already terminal at lease time', async () => {
        runs.markStarted.mockResolvedValue(false);
        await build().onLeased(new FleetJobLeasedEvent(job({ status: 'leased' }), NODE, USER));
        expect(runDenorm.recordStarted).not.toHaveBeenCalled();
    });

    it('reconciles a successful pushed run: gate results, PR, summary, chat, drain', async () => {
        await build().onCompleted(
            new FleetJobCompletedEvent(
                job(),
                USER,
                'node-report',
                NODE,
                successResult as unknown as Record<string, unknown>,
            ),
        );
        expect(runs.updateGateResults).toHaveBeenCalledWith(RUN, {
            checkResults: successResult.checks,
            gateStatus: 'green',
        });
        expect(runs.updateTelemetry).toHaveBeenCalledWith(RUN, { changedFilesCount: 3 });
        expect(taskWorkspace.finalizeRemotePush).toHaveBeenCalledWith(
            expect.objectContaining({
                task: expect.objectContaining({ id: TASK }),
                userId: USER,
                agentId: AGENT,
                agentCanOpenPullRequests: true,
                branch: 'task/tsk-1-task1',
                headSha: 'b'.repeat(40),
                baseSha: 'a'.repeat(40),
                changedFiles: 3,
                runId: RUN,
                gate: { checksPassed: 1 },
                gateStatus: 'green',
            }),
        );
        expect(runs.markCompleted).toHaveBeenCalledWith(RUN, 'Fixed it.');
        expect(runs.markFailed).not.toHaveBeenCalled();
        expect(runDenorm.recordTerminal).toHaveBeenCalledWith(TASK, RUN, 'completed');
        expect(taskChat.post).toHaveBeenCalledTimes(1);
        const body: string = taskChat.post.mock.calls[0][1].body;
        expect(taskChat.post.mock.calls[0][1]).toMatchObject({
            taskId: TASK,
            authorType: 'agent',
            authorId: AGENT,
        });
        expect(body).toContain('Fleet run finished');
        expect(body).toContain('Fixed it.');
        expect(body).toContain('Pull request #42');
        expect(body).toContain('$0.42');
        expect(dispatchGate.drainForWork).toHaveBeenCalledWith('work-1');
    });

    it('honours the agent PR permission and a no-changes run', async () => {
        agents.findById.mockResolvedValue({
            id: AGENT,
            permissions: { canOpenPullRequests: false },
        });
        await build().onCompleted(
            new FleetJobCompletedEvent(
                job(),
                USER,
                'node-report',
                NODE,
                successResult as unknown as Record<string, unknown>,
            ),
        );
        expect(taskWorkspace.finalizeRemotePush).toHaveBeenCalledWith(
            expect.objectContaining({ agentCanOpenPullRequests: false }),
        );

        taskWorkspace.finalizeRemotePush.mockClear();
        const empty = {
            ...successResult,
            git: { ...successResult.git!, empty: true, pushed: false, changedFiles: 0 },
        };
        await build().onCompleted(
            new FleetJobCompletedEvent(
                job(),
                USER,
                'node-report',
                NODE,
                empty as unknown as Record<string, unknown>,
            ),
        );
        expect(taskWorkspace.finalizeRemotePush).not.toHaveBeenCalled();
        expect(runs.markCompleted).toHaveBeenLastCalledWith(RUN, 'Fixed it.');
        expect(taskChat.post.mock.calls.at(-1)?.[1].body).toContain('no file changes');
    });

    it('keeps the run completed when opening the PR fails, and says so in the chat', async () => {
        taskWorkspace.finalizeRemotePush.mockRejectedValue(new Error('GitHub 502'));
        await build().onCompleted(
            new FleetJobCompletedEvent(
                job(),
                USER,
                'node-report',
                NODE,
                successResult as unknown as Record<string, unknown>,
            ),
        );
        expect(runs.markCompleted).toHaveBeenCalledWith(RUN, 'Fixed it.');
        expect(taskChat.post.mock.calls[0][1].body).toContain(
            'opening the pull request failed: GitHub 502',
        );
    });

    it('reconciles a failed run: reason, failing checks, output tail, inbox notice', async () => {
        const failed: FleetAgentTaskResult = {
            ...successResult,
            status: 'failed',
            gateStatus: 'red',
            checks: [
                {
                    id: 'unit',
                    status: 'red',
                    exitCode: 1,
                    durationMs: 100,
                    logTail: 'FAIL login.spec',
                },
            ],
            model: {
                ...successResult.model!,
                status: 'failed',
                summary: null,
                outputTail: 'boom TOKEN=abc',
            },
            failureReason: 'a required acceptance check did not pass',
        };
        await build().onCompleted(
            new FleetJobCompletedEvent(
                job({ status: 'failed' }),
                USER,
                'node-report',
                NODE,
                failed as unknown as Record<string, unknown>,
            ),
        );
        expect(runs.markFailed).toHaveBeenCalledWith(
            RUN,
            'a required acceptance check did not pass',
        );
        expect(runs.markCompleted).not.toHaveBeenCalled();
        expect(taskWorkspace.finalizeRemotePush).not.toHaveBeenCalled();
        expect(runDenorm.recordTerminal).toHaveBeenCalledWith(TASK, RUN, 'failed');
        const body: string = taskChat.post.mock.calls[0][1].body;
        expect(body).toContain('Fleet run failed');
        expect(body).toContain('- unit: red (exit 1)');
        expect(body).toContain('CLI output tail');
        expect(inbox!.notice).toHaveBeenCalledWith(
            USER,
            expect.objectContaining({
                title: expect.stringContaining('Fleet run failed'),
                taskId: TASK,
                agentRunId: RUN,
            }),
        );
        expect(dispatchGate.drainForWork).toHaveBeenCalledWith('work-1');
    });

    it('uses the job error when the node reported no structured result', async () => {
        await build().onCompleted(
            new FleetJobCompletedEvent(
                job({ status: 'failed' }),
                USER,
                'node-report',
                NODE,
                null,
                'This node has no claude-code CLI configured',
            ),
        );
        expect(runs.markFailed).toHaveBeenCalledWith(
            RUN,
            'This node has no claude-code CLI configured',
        );
    });

    it('fails the run when the lease budget was exhausted without a report', async () => {
        await build().onCompleted(
            new FleetJobCompletedEvent(
                job({ status: 'failed' }),
                USER,
                'lease-exhausted',
                NODE,
                null,
                'Lease expired 3 time(s)',
            ),
        );
        expect(runs.markFailed).toHaveBeenCalledWith(RUN, 'Lease expired 3 time(s)');
    });

    it('only mirrors the board for an operator-cancelled job', async () => {
        await build().onCompleted(
            new FleetJobCompletedEvent(job({ status: 'failed' }), USER, 'cancelled', null),
        );
        expect(runs.markFailed).not.toHaveBeenCalled();
        expect(runs.markCompleted).not.toHaveBeenCalled();
        expect(runDenorm.recordTerminal).toHaveBeenCalledWith(TASK, RUN, 'failed');
    });

    it('ignores a run that belongs to another owner, and non-agent jobs', async () => {
        runs.findById.mockResolvedValue({ id: RUN, userId: 'someone-else' });
        await build().onCompleted(
            new FleetJobCompletedEvent(
                job(),
                USER,
                'node-report',
                NODE,
                successResult as unknown as Record<string, unknown>,
            ),
        );
        expect(runs.markCompleted).not.toHaveBeenCalled();
        await build().onCompleted(
            new FleetJobCompletedEvent(job({ kind: 'browser-check' }), USER, 'node-report', NODE),
        );
        expect(runs.findById).toHaveBeenCalledTimes(1);
    });

    it('never throws out of a listener', async () => {
        runs.findById.mockRejectedValue(new Error('db down'));
        await expect(
            build().onCompleted(new FleetJobCompletedEvent(job(), USER, 'node-report', NODE)),
        ).resolves.toBeUndefined();
    });

    describe('multi-repo mounts (slice C)', () => {
        /** The PLAN: what the planner put on the job, and the only mounts a node may report on. */
        const plannedMount = (repositoryId: string, over: Record<string, unknown> = {}) => ({
            repositoryId,
            repoUrl: `https://github.com/${repositoryId}.git`,
            baseRef: 'main',
            branch: 'task/tsk-1-task1',
            mountDir: repositoryId.split('/')[1],
            writable: true,
            ...over,
        });
        const mountedJob = (
            mounts: unknown[] = [plannedMount('acme/template'), plannedMount('acme/docs')],
        ) =>
            job({
                payload: {
                    taskId: TASK,
                    runId: RUN,
                    agentId: AGENT,
                    userId: USER,
                    workspace: {
                        repositoryId: 'acme/repo',
                        repoUrl: 'https://github.com/acme/repo.git',
                        baseRef: 'develop',
                        branch: 'task/tsk-1-task1',
                        mounts,
                    },
                },
            });
        const mountedResult = {
            ...successResult,
            workspace: {
                path: '/w',
                repositoryId: 'acme/repo',
                baseRef: 'develop',
                branch: 'task/tsk-1-task1',
                baseSha: 'a'.repeat(40),
                headSha: 'b'.repeat(40),
                reused: false,
                mounts: [
                    {
                        path: '/m1',
                        linkPath: '/w/.mounts/template',
                        repositoryId: 'acme/template',
                        baseRef: 'main',
                        branch: 'task/tsk-1-task1',
                        baseSha: 'c'.repeat(40),
                        headSha: 'c'.repeat(40),
                        reused: false,
                        mountDir: 'template',
                        writable: true,
                    },
                ],
            },
            mountGit: [
                {
                    repositoryId: 'acme/template',
                    mountDir: 'template',
                    branch: 'task/tsk-1-task1',
                    baseSha: 'c'.repeat(40),
                    headSha: 'd'.repeat(40),
                    empty: false,
                    pushed: true,
                    changedFiles: 1,
                },
                {
                    repositoryId: 'acme/docs',
                    mountDir: 'docs',
                    branch: 'task/tsk-1-task1',
                    baseSha: 'e'.repeat(40),
                    headSha: null,
                    empty: true,
                    pushed: false,
                },
            ],
        };

        it('opens one pull request per pushed mount, cross-linked to the primary, and posts one Inbox notice', async () => {
            await build().onCompleted(
                new FleetJobCompletedEvent(
                    mountedJob(),
                    USER,
                    'node-report',
                    NODE,
                    mountedResult as unknown as Record<string, unknown>,
                ),
            );
            expect(taskWorkspace.finalizeRemotePush).toHaveBeenCalledTimes(1);
            expect(taskWorkspace.finalizeMountPush).toHaveBeenCalledTimes(1);
            expect(taskWorkspace.finalizeMountPush).toHaveBeenCalledWith(
                expect.objectContaining({
                    task: expect.objectContaining({ id: TASK }),
                    userId: USER,
                    agentId: AGENT,
                    agentCanOpenPullRequests: true,
                    repositoryId: 'acme/template',
                    branch: 'task/tsk-1-task1',
                    baseRef: 'main',
                    headSha: 'd'.repeat(40),
                    primaryPrUrl: 'https://github.com/acme/repo/pull/42',
                    summary: 'Fixed it.',
                }),
            );
            const body: string = taskChat.post.mock.calls[0][1].body;
            expect(body).toContain('Mounted repositories:');
            expect(body).toContain('`acme/template`: pull request #7 opened');
            expect(body).toContain('`acme/docs`: no changes.');
            expect(inbox!.notice).toHaveBeenCalledWith(
                USER,
                expect.objectContaining({
                    title: 'Fleet run finished: Fix the thing',
                    body: expect.stringContaining('Pull requests to review (2):'),
                    taskId: TASK,
                    agentRunId: RUN,
                }),
            );
            const noticeBody: string = inbox!.notice.mock.calls[0][1].body;
            expect(noticeBody).toContain('https://github.com/acme/repo/pull/42');
            expect(noticeBody).toContain('https://github.com/acme/template/pull/7');
            expect(runs.markCompleted).toHaveBeenCalledWith(RUN, 'Fixed it.');
        });

        it('keeps going when one mount pull request fails and reports it', async () => {
            taskWorkspace.finalizeMountPush.mockResolvedValue({
                repositoryId: 'acme/template',
                outcome: 'failed',
                error: '403: resource not accessible',
            });
            await build().onCompleted(
                new FleetJobCompletedEvent(
                    mountedJob(),
                    USER,
                    'node-report',
                    NODE,
                    mountedResult as unknown as Record<string, unknown>,
                ),
            );
            const body: string = taskChat.post.mock.calls[0][1].body;
            expect(body).toContain(
                '`acme/template`: branch `task/tsk-1-task1` pushed, but opening the pull request failed: 403',
            );
            expect(runs.markCompleted).toHaveBeenCalledTimes(1);
            expect(inbox!.notice.mock.calls[0][1].body).toContain('Pull requests to review (1):');
        });

        it('still completes the run when recording a mount pull request throws, and says so', async () => {
            taskWorkspace.finalizeMountPush.mockRejectedValue(new Error('db down'));
            await build().onCompleted(
                new FleetJobCompletedEvent(
                    mountedJob(),
                    USER,
                    'node-report',
                    NODE,
                    mountedResult as unknown as Record<string, unknown>,
                ),
            );
            expect(runs.markCompleted).toHaveBeenCalledWith(RUN, 'Fixed it.');
            expect(runDenorm.recordTerminal).toHaveBeenCalledWith(TASK, RUN, 'completed');
            expect(taskChat.post.mock.calls[0][1].body).toContain(
                '`acme/template`: branch `task/tsk-1-task1` pushed, but recording it failed: db down',
            );
            expect(dispatchGate.drainForWork).toHaveBeenCalledWith('work-1');
        });

        it('records branches a FAILED run still pushed in mounts, without opening pull requests', async () => {
            const failed = {
                ...mountedResult,
                status: 'failed',
                failureReason: 'a required acceptance check did not pass',
            };
            await build().onCompleted(
                new FleetJobCompletedEvent(
                    mountedJob(),
                    USER,
                    'node-report',
                    NODE,
                    failed as unknown as Record<string, unknown>,
                ),
            );
            expect(runs.markFailed).toHaveBeenCalledWith(
                RUN,
                'a required acceptance check did not pass',
            );
            expect(taskWorkspace.finalizeRemotePush).not.toHaveBeenCalled();
            expect(taskWorkspace.finalizeMountPush).toHaveBeenCalledTimes(1);
            expect(taskWorkspace.finalizeMountPush).toHaveBeenCalledWith(
                expect.objectContaining({
                    repositoryId: 'acme/template',
                    agentCanOpenPullRequests: false,
                    baseRef: 'main',
                }),
            );
        });

        /**
         * The node's word is not the plan's. Repository, branch and base come
         * from the job payload; a verdict the plan does not cover is logged,
         * mentioned, and never turned into a pull request or a Task entry —
         * on the success AND the failure path.
         */
        describe.each([
            ['success', mountedResult],
            [
                'failure',
                {
                    ...mountedResult,
                    status: 'failed',
                    failureReason: 'a required acceptance check did not pass',
                },
            ],
        ])('planned-mount gate on the %s path', (_path, baseResult) => {
            const withEntry = (entry: Record<string, unknown>) => ({
                ...baseResult,
                mountGit: [{ ...mountedResult.mountGit[0], ...entry }],
            });

            it('ignores a repository the plan did not mount', async () => {
                await build().onCompleted(
                    new FleetJobCompletedEvent(
                        mountedJob(),
                        USER,
                        'node-report',
                        NODE,
                        withEntry({ repositoryId: 'victim/anything' }) as unknown as Record<
                            string,
                            unknown
                        >,
                    ),
                );
                expect(taskWorkspace.finalizeMountPush).not.toHaveBeenCalled();
                if (baseResult.status === 'succeeded') {
                    expect(taskChat.post.mock.calls[0][1].body).toContain(
                        'ignored: `victim/anything` was not a planned mount of this run',
                    );
                }
            });

            it('ignores a verdict for a read-only mount', async () => {
                await build().onCompleted(
                    new FleetJobCompletedEvent(
                        mountedJob([
                            plannedMount('acme/template', { writable: false }),
                            plannedMount('acme/docs'),
                        ]),
                        USER,
                        'node-report',
                        NODE,
                        baseResult as unknown as Record<string, unknown>,
                    ),
                );
                expect(taskWorkspace.finalizeMountPush).not.toHaveBeenCalled();
            });

            it('ignores a verdict from a branch other than the planned Task branch', async () => {
                await build().onCompleted(
                    new FleetJobCompletedEvent(
                        mountedJob(),
                        USER,
                        'node-report',
                        NODE,
                        withEntry({ branch: 'main' }) as unknown as Record<string, unknown>,
                    ),
                );
                expect(taskWorkspace.finalizeMountPush).not.toHaveBeenCalled();
            });

            it('ignores a head that is not a commit id, and every verdict when the job planned no mounts', async () => {
                await build().onCompleted(
                    new FleetJobCompletedEvent(
                        mountedJob(),
                        USER,
                        'node-report',
                        NODE,
                        withEntry({ headSha: 'refs/heads/main' }) as unknown as Record<
                            string,
                            unknown
                        >,
                    ),
                );
                expect(taskWorkspace.finalizeMountPush).not.toHaveBeenCalled();

                await build().onCompleted(
                    new FleetJobCompletedEvent(
                        job(),
                        USER,
                        'node-report',
                        NODE,
                        baseResult as unknown as Record<string, unknown>,
                    ),
                );
                expect(taskWorkspace.finalizeMountPush).not.toHaveBeenCalled();
            });

            it('takes repository, branch and base from the plan, not from the node', async () => {
                await build().onCompleted(
                    new FleetJobCompletedEvent(
                        mountedJob([plannedMount('Acme/Template', { baseRef: 'release' })]),
                        USER,
                        'node-report',
                        NODE,
                        withEntry({ repositoryId: 'acme/template' }) as unknown as Record<
                            string,
                            unknown
                        >,
                    ),
                );
                expect(taskWorkspace.finalizeMountPush).toHaveBeenCalledTimes(1);
                expect(taskWorkspace.finalizeMountPush).toHaveBeenCalledWith(
                    expect.objectContaining({
                        repositoryId: 'Acme/Template',
                        branch: 'task/tsk-1-task1',
                        baseRef: 'release',
                        headSha: 'd'.repeat(40),
                    }),
                );
            });
        });
    });

    describe('owner question (self-build slice Q)', () => {
        const question = {
            text: 'Use Postgres?',
            context: 'Both work; Postgres needs a container on the node.',
            truncated: false,
            mountDir: null,
        };
        const questionResult = { ...successResult, question };
        const completed = (
            result: Record<string, unknown>,
            jobOver: Partial<FleetJobView> = {},
        ) =>
            build().onCompleted(
                new FleetJobCompletedEvent(job(jobOver), USER, 'node-report', NODE, result),
            );

        it('parks the run (terminal → awaitingInput → Inbox question, in that order), records the branch without a PR, and never fails it', async () => {
            await completed(questionResult as unknown as Record<string, unknown>);

            expect(runs.tryMarkCompleted).toHaveBeenCalledWith(
                RUN,
                expect.stringMatching(/^Paused with a question for the owner: Use Postgres\?/),
            );
            expect(runs.markCompleted).not.toHaveBeenCalled();
            expect(runs.markFailed).not.toHaveBeenCalled();
            expect(runs.setAwaitingInput).toHaveBeenCalledWith(RUN, true);
            // Terminal BEFORE parked BEFORE the Inbox row: a question filed
            // on a live row would let a fast reply steer into a queue no
            // node reads.
            expect(runs.tryMarkCompleted.mock.invocationCallOrder[0]).toBeLessThan(
                runs.setAwaitingInput.mock.invocationCallOrder[0],
            );
            expect(runs.setAwaitingInput.mock.invocationCallOrder[0]).toBeLessThan(
                inbox!.questionRaised.mock.invocationCallOrder[0],
            );
            // Partial work lands on the Task branch, but nobody is asked to
            // review it: no PR, no `in_review`.
            expect(taskWorkspace.finalizeRemotePush).not.toHaveBeenCalled();
            expect(taskWorkspace.recordRemotePush).toHaveBeenCalledWith({
                task: expect.objectContaining({ id: TASK }),
                runId: RUN,
                branch: 'task/tsk-1-task1',
                headSha: 'b'.repeat(40),
                baseSha: 'a'.repeat(40),
                changedFiles: 3,
            });
            expect(runDenorm.recordTerminal).toHaveBeenCalledWith(TASK, RUN, 'completed');
            expect(inbox!.questionRaised).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: USER,
                    agentRunId: RUN,
                    agentId: AGENT,
                    question: 'Use Postgres?',
                    context: expect.stringContaining('Both work; Postgres needs a container'),
                    sourceMeta: expect.objectContaining({
                        nodeId: NODE,
                        nodeName: 'everdesk2',
                        branch: 'task/tsk-1-task1',
                        taskTitle: 'Fix the thing',
                        mountDir: null,
                    }),
                }),
            );
            expect(inbox!.questionRaised.mock.calls[0][0].context).toContain(
                'Work so far: pushed on branch `task/tsk-1-task1`.',
            );
            expect(inbox!.notice).not.toHaveBeenCalled();
            const body: string = taskChat.post.mock.calls[0][1].body;
            expect(body).toContain('waiting for your answer');
            expect(body).toContain('Use Postgres?');
            expect(body).toContain('pushed on branch `task/tsk-1-task1`');
            expect(body).toContain('Answer it in the Inbox');
            expect(dispatchGate.drainForWork).toHaveBeenCalledWith('work-1');
        });

        it('still parks (never fails) a report whose status, gate and model verdicts are red, and says so', async () => {
            const redResult = {
                ...questionResult,
                status: 'failed',
                gateStatus: 'red',
                checks: [{ id: 'unit', status: 'red', exitCode: 1, durationMs: 100 }],
                model: { ...successResult.model!, status: 'failed', summary: null },
                failureReason: 'a required acceptance check did not pass',
            };
            await completed(redResult as unknown as Record<string, unknown>);

            expect(runs.tryMarkCompleted).toHaveBeenCalledTimes(1);
            expect(runs.markFailed).not.toHaveBeenCalled();
            expect(runs.setAwaitingInput).toHaveBeenCalledWith(RUN, true);
            expect(runs.updateGateResults).toHaveBeenCalledWith(RUN, {
                checkResults: redResult.checks,
                gateStatus: 'red',
            });
            expect(inbox!.notice).not.toHaveBeenCalled();
            const context: string = inbox!.questionRaised.mock.calls[0][0].context;
            expect(context).toContain('Required acceptance checks did not pass: unit');
            expect(context).toContain('model failure (status failed)');
            const body: string = taskChat.post.mock.calls[0][1].body;
            expect(body).toContain('Required acceptance checks did not pass: unit');
            expect(body).toContain('model failure (status failed)');
            expect(body).not.toContain('Fleet run failed');
        });

        it('records nothing on the Task when the branch was committed but not pushed, and tells the owner', async () => {
            const unpushed = {
                ...questionResult,
                git: { ...successResult.git!, pushed: false },
            };
            await completed(unpushed as unknown as Record<string, unknown>);

            expect(taskWorkspace.recordRemotePush).not.toHaveBeenCalled();
            expect(taskWorkspace.finalizeRemotePush).not.toHaveBeenCalled();
            expect(runs.setAwaitingInput).toHaveBeenCalledWith(RUN, true);
            expect(inbox!.questionRaised.mock.calls[0][0].context).toContain(
                'committed on `task/tsk-1-task1` but not pushed',
            );
        });

        it('records pushed mounts with pull requests OFF and reports a mount-asked question', async () => {
            const mounted = {
                ...questionResult,
                question: { ...question, mountDir: 'template' },
                mountGit: [
                    {
                        repositoryId: 'acme/template',
                        mountDir: 'template',
                        branch: 'task/tsk-1-task1',
                        baseSha: 'c'.repeat(40),
                        headSha: 'd'.repeat(40),
                        empty: false,
                        pushed: true,
                        changedFiles: 1,
                    },
                    {
                        repositoryId: 'acme/docs',
                        mountDir: 'docs',
                        branch: 'task/tsk-1-task1',
                        baseSha: 'e'.repeat(40),
                        headSha: null,
                        empty: true,
                        pushed: false,
                    },
                    // Not on the plan: a node (or a model sharing its account)
                    // must not make the platform record a push it names itself.
                    {
                        repositoryId: 'acme/rogue',
                        mountDir: 'rogue',
                        branch: 'task/tsk-1-task1',
                        baseSha: 'f'.repeat(40),
                        headSha: '1'.repeat(40),
                        empty: false,
                        pushed: true,
                        changedFiles: 1,
                    },
                ],
            };
            // The plan the platform acts on comes from the job payload, exactly
            // like the success and failure paths (slice C review).
            const plannedMount = (repositoryId: string) => ({
                repositoryId,
                repoUrl: `https://github.com/${repositoryId}.git`,
                baseRef: 'main',
                branch: 'task/tsk-1-task1',
                mountDir: repositoryId.split('/')[1],
                writable: true,
            });
            await completed(mounted as unknown as Record<string, unknown>, {
                payload: {
                    taskId: TASK,
                    runId: RUN,
                    agentId: AGENT,
                    userId: USER,
                    workspace: {
                        repositoryId: 'acme/repo',
                        repoUrl: 'https://github.com/acme/repo.git',
                        baseRef: 'develop',
                        branch: 'task/tsk-1-task1',
                        mounts: [plannedMount('acme/template'), plannedMount('acme/docs')],
                    },
                },
            });

            expect(taskWorkspace.recordRemotePush).toHaveBeenCalledTimes(1);
            expect(taskWorkspace.finalizeMountPush).toHaveBeenCalledTimes(1);
            expect(taskWorkspace.finalizeMountPush).toHaveBeenCalledWith(
                expect.objectContaining({
                    task: expect.objectContaining({ id: TASK }),
                    userId: USER,
                    agentId: AGENT,
                    agentCanOpenPullRequests: false,
                    repositoryId: 'acme/template',
                    branch: 'task/tsk-1-task1',
                    baseRef: 'main',
                    headSha: 'd'.repeat(40),
                }),
            );
            expect(taskWorkspace.finalizeMountPush).not.toHaveBeenCalledWith(
                expect.objectContaining({ repositoryId: 'acme/rogue' }),
            );
            expect(inbox!.questionRaised).toHaveBeenCalledWith(
                expect.objectContaining({
                    sourceMeta: expect.objectContaining({ mountDir: 'template' }),
                    context: expect.stringContaining(
                        'Asked from the mounted repository `.mounts/template`',
                    ),
                }),
            );
        });

        it('still parks the run when no Inbox producer is bound', async () => {
            inbox = undefined;
            await expect(
                completed(questionResult as unknown as Record<string, unknown>),
            ).resolves.toBeUndefined();
            expect(runs.tryMarkCompleted).toHaveBeenCalledTimes(1);
            expect(runs.setAwaitingInput).toHaveBeenCalledWith(RUN, true);
            expect(runs.markFailed).not.toHaveBeenCalled();
            expect(taskChat.post).toHaveBeenCalledTimes(1);
        });

        it('ignores a replayed completion: an already-terminal row is neither re-parked nor asked twice', async () => {
            runs.findById.mockResolvedValue({
                id: RUN,
                userId: USER,
                agentId: AGENT,
                workId: 'work-1',
                status: 'completed',
            });
            await completed(questionResult as unknown as Record<string, unknown>);
            expect(runs.tryMarkCompleted).not.toHaveBeenCalled();
            expect(runs.setAwaitingInput).not.toHaveBeenCalled();
            expect(inbox!.questionRaised).not.toHaveBeenCalled();
            expect(runs.markFailed).not.toHaveBeenCalled();

            // Lost the terminal CAS between the read and the write: the
            // winner (a second report, or resume) owns the run now.
            runs.findById.mockResolvedValue({
                id: RUN,
                userId: USER,
                agentId: AGENT,
                workId: 'work-1',
                status: 'running',
            });
            runs.tryMarkCompleted.mockResolvedValue(false);
            await completed(questionResult as unknown as Record<string, unknown>);
            expect(runs.tryMarkCompleted).toHaveBeenCalledTimes(1);
            expect(runs.setAwaitingInput).not.toHaveBeenCalled();
            expect(inbox!.questionRaised).not.toHaveBeenCalled();
            expect(runDenorm.recordTerminal).not.toHaveBeenCalled();
        });

        it('takes every id from the event and the run row — never from the node result', async () => {
            const smuggled = {
                ...questionResult,
                question: {
                    ...question,
                    userId: 'someone-else',
                    taskId: 'task-of-someone-else',
                    agentRunId: 'run-of-someone-else',
                },
            };
            await completed(smuggled as unknown as Record<string, unknown>);
            const input = inbox!.questionRaised.mock.calls[0][0];
            expect(input).toMatchObject({ userId: USER, agentRunId: RUN, agentId: AGENT });
            expect(input.sourceMeta).toEqual(
                expect.objectContaining({ nodeId: NODE, taskTitle: 'Fix the thing' }),
            );
            expect(JSON.stringify(input)).not.toContain('someone-else');
        });

        it('hands the Task row WITH its pull request to recordRemotePush so the branch stays pr-open, and advertises the PR (review Q-R1-01)', async () => {
            // A question asked in a later run of a Task whose first run
            // opened the PR (the reviewer-rejection → resume loop).
            tasks.findById.mockResolvedValue({
                id: TASK,
                workId: 'work-1',
                title: 'Fix the thing',
                organizationId: null,
                prNumber: 42,
                prUrl: 'https://github.com/acme/repo/pull/42',
            });
            await completed(questionResult as unknown as Record<string, unknown>);
            expect(taskWorkspace.recordRemotePush).toHaveBeenCalledWith(
                expect.objectContaining({
                    task: expect.objectContaining({
                        prNumber: 42,
                        prUrl: 'https://github.com/acme/repo/pull/42',
                    }),
                    branch: 'task/tsk-1-task1',
                }),
            );
            expect(taskWorkspace.finalizeRemotePush).not.toHaveBeenCalled();
            expect(inbox!.questionRaised).toHaveBeenCalledWith(
                expect.objectContaining({
                    sourceMeta: expect.objectContaining({
                        prUrl: 'https://github.com/acme/repo/pull/42',
                    }),
                }),
            );
        });

        it('redacts secrets from the question, its context and the push error before the summary, the Inbox and the chat see them (review SR-2)', async () => {
            const pat = `ghp_${'A'.repeat(36)}`;
            const apiKey = 'sk-abcdefghijklmnopqrstuvwxyz';
            const leaky = {
                ...questionResult,
                question: {
                    ...question,
                    text: `Should I keep using ${pat} for the deploy?`,
                    context: `The workflow sets TOKEN=${apiKey} and I am not sure it is the right one.`,
                },
                git: {
                    ...successResult.git!,
                    pushed: false,
                    error: `push rejected: https://x-access-token:${pat}@github.com/acme/repo.git`,
                },
            };
            await completed(leaky as unknown as Record<string, unknown>);

            const summary: string = runs.tryMarkCompleted.mock.calls[0][1];
            const input = inbox!.questionRaised.mock.calls[0][0];
            const body: string = taskChat.post.mock.calls[0][1].body;
            expect(summary).toBe(
                'Paused with a question for the owner: Should I keep using [redacted secret] for the deploy?',
            );
            expect(input.question).toBe('Should I keep using [redacted secret] for the deploy?');
            expect(input.context).toContain('TOKEN=[redacted secret] and');
            expect(input.context).toContain(
                'push failed: push rejected: https://x-access-token:[redacted secret]@github.com/acme/repo.git',
            );
            for (const text of [summary, input.question, input.context, body]) {
                expect(text).not.toContain(pat);
                expect(text).not.toContain(apiKey);
            }
        });

        it('logs at error level, naming the run, when a parking write fails — and files nothing (review SR-3)', async () => {
            const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
            try {
                // The terminal write failing (a NUL the old normalizer let
                // through, a database outage): the run is left `running`
                // for the sweeper — said so, at error level, with the id.
                runs.tryMarkCompleted.mockRejectedValue(
                    new Error('invalid byte sequence for encoding "UTF8": 0x00'),
                );
                await expect(
                    completed(questionResult as unknown as Record<string, unknown>),
                ).resolves.toBeUndefined();
                expect(error).toHaveBeenCalledWith(
                    expect.stringContaining(`Run ${RUN}: parking on the owner question failed`),
                );
                expect(error).toHaveBeenCalledWith(expect.stringContaining('stays running'));
                expect(runs.setAwaitingInput).not.toHaveBeenCalled();
                expect(inbox!.questionRaised).not.toHaveBeenCalled();
                expect(runs.markFailed).not.toHaveBeenCalled();
                expect(runDenorm.recordTerminal).not.toHaveBeenCalled();

                // The flag write failing AFTER the terminal CAS won: the run
                // is completed but not resumable from the Inbox — said so,
                // and still nothing filed.
                error.mockClear();
                runs.tryMarkCompleted.mockResolvedValue(true);
                runs.setAwaitingInput.mockRejectedValue(new Error('db down'));
                await expect(
                    completed(questionResult as unknown as Record<string, unknown>),
                ).resolves.toBeUndefined();
                expect(error).toHaveBeenCalledWith(expect.stringContaining('NOT resumable'));
                expect(inbox!.questionRaised).not.toHaveBeenCalled();
                expect(runDenorm.recordTerminal).not.toHaveBeenCalled();
            } finally {
                error.mockRestore();
            }
        });
    });
});

describe('parseAgentTaskResult', () => {
    it('accepts the node contract and normalises optional parts', () => {
        expect(
            parseAgentTaskResult(successResult as unknown as Record<string, unknown>),
        ).toMatchObject({
            status: 'succeeded',
            checks: successResult.checks,
            git: successResult.git,
        });
        expect(parseAgentTaskResult({ status: 'failed', taskId: TASK })).toMatchObject({
            status: 'failed',
            checks: null,
            git: null,
            model: null,
        });
    });

    it('normalises the owner question (slice Q): absent or garbage → null, oversize text sliced, unknown keys dropped', () => {
        expect(parseAgentTaskResult({ status: 'succeeded', taskId: TASK })!.question).toBeNull();
        expect(
            parseAgentTaskResult({ status: 'succeeded', taskId: TASK, question: 'Use Postgres?' })!
                .question,
        ).toBeNull();
        expect(
            parseAgentTaskResult({ status: 'succeeded', taskId: TASK, question: { text: '  ' } })!
                .question,
        ).toBeNull();
        const parsed = parseAgentTaskResult({
            status: 'failed',
            taskId: TASK,
            question: {
                text: 'q'.repeat(400),
                context: 'ctx',
                userId: 'someone-else',
                mountDir: '../etc',
            },
        })!.question!;
        expect(parsed.text).toHaveLength(300);
        expect(parsed.truncated).toBe(true);
        expect(parsed.mountDir).toBeNull();
        expect(Object.keys(parsed).sort()).toEqual(['context', 'mountDir', 'text', 'truncated']);
    });

    it('redacts secrets from the question text and context at the boundary (review SR-2)', () => {
        const pat = `ghp_${'B'.repeat(36)}`;
        const parsed = parseAgentTaskResult({
            status: 'succeeded',
            taskId: TASK,
            question: { text: `Use ${pat}?`, context: `token ${pat} again` },
        })!.question!;
        expect(parsed.text).toBe('Use [redacted secret]?');
        expect(parsed.context).toBe('token [redacted secret] again');
    });

    it('rejects anything without a status', () => {
        expect(parseAgentTaskResult(null)).toBeNull();
        expect(parseAgentTaskResult({ ok: true })).toBeNull();
        expect(parseAgentTaskResult({ status: 'weird' })).toBeNull();
    });

    it('keeps well-formed mount verdicts, drops malformed ones, and never trusts a non-array', () => {
        const verdict = {
            repositoryId: 'acme/template',
            mountDir: 'template',
            branch: 'task/tsk-1-task1',
            baseSha: 'c'.repeat(40),
            headSha: 'd'.repeat(40),
            empty: false,
            pushed: true,
        };
        expect(
            parseAgentTaskResult({
                status: 'succeeded',
                taskId: TASK,
                mountGit: [verdict, { repositoryId: 'acme/docs' }, 'nope', null],
            })?.mountGit,
        ).toEqual([verdict]);
        expect(
            parseAgentTaskResult({ status: 'succeeded', taskId: TASK, mountGit: { verdict } })
                ?.mountGit,
        ).toBeNull();
        expect(
            parseAgentTaskResult({ status: 'succeeded', taskId: TASK, mountGit: 'template' })
                ?.mountGit,
        ).toBeNull();
        expect(parseAgentTaskResult({ status: 'succeeded', taskId: TASK })?.mountGit).toBeNull();
    });
});
