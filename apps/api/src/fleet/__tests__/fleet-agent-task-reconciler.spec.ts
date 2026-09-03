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
 *      re-settled.
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
    let taskWorkspace: { finalizeRemotePush: jest.Mock; finalizeMountPush: jest.Mock };
    let taskChat: { post: jest.Mock };
    let dispatchGate: { drainForWork: jest.Mock };
    let inbox: { notice: jest.Mock };
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
            markFailed: jest.fn().mockResolvedValue(undefined),
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
        };
        taskChat = { post: jest.fn().mockResolvedValue({}) };
        dispatchGate = { drainForWork: jest.fn().mockResolvedValue({ dispatched: false }) };
        inbox = { notice: jest.fn().mockResolvedValue(undefined) };
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
        expect(inbox.notice).toHaveBeenCalledWith(
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
            expect(inbox.notice).toHaveBeenCalledWith(
                USER,
                expect.objectContaining({
                    title: 'Fleet run finished: Fix the thing',
                    body: expect.stringContaining('Pull requests to review (2):'),
                    taskId: TASK,
                    agentRunId: RUN,
                }),
            );
            const noticeBody: string = inbox.notice.mock.calls[0][1].body;
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
            expect(inbox.notice.mock.calls[0][1].body).toContain('Pull requests to review (1):');
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
