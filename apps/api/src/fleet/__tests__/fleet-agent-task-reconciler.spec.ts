import { Logger } from '@nestjs/common';
import { FleetJobCompletedEvent, FleetJobLeasedEvent } from '@ever-works/agent/events';
import { isQueueExpiredError } from '@ever-works/contracts';
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
    // Fleet cost accounting (EW-777) — the three trailing optional deps.
    let pluginUsage: { record: jest.Mock } | undefined;
    let jobsRepo: { stampCostCents: jest.Mock } | undefined;
    let costCeiling: { evaluateAfterCompletion: jest.Mock } | undefined;

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
            pluginUsage as never,
            jobsRepo as never,
            costCeiling as never,
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
            addTokens: jest.fn().mockResolvedValue(undefined),
            stampCostCents: jest.fn().mockResolvedValue(undefined),
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
            findById: jest.fn().mockResolvedValue({
                id: NODE,
                userId: USER,
                name: 'everdesk2',
                modelIdentity: 'claude-code: ops@example.com (Acme, max)',
            }),
        };
        pluginUsage = { record: jest.fn().mockResolvedValue({ id: 'usage-1' }) };
        jobsRepo = { stampCostCents: jest.fn().mockResolvedValue(undefined) };
        costCeiling = {
            evaluateAfterCompletion: jest
                .fn()
                .mockResolvedValue({ drainedNodeIds: [], noticesFiled: 0 }),
        };
    });

    describe('fleet cost accounting (EW-777)', () => {
        const billed: FleetAgentTaskResult = {
            ...successResult,
            model: {
                ...successResult.model!,
                costUsd: 0.42,
                turns: 4,
                modelId: 'claude-opus-4-1-20250805',
                inputTokens: 120,
                outputTokens: 3400,
                cacheReadTokens: 90_000,
                cacheCreationTokens: 2500,
                totalTokens: 96_020,
            },
        };

        const completed = (result: FleetAgentTaskResult, status: FleetJobView['status'] = 'done') =>
            build().onCompleted(
                new FleetJobCompletedEvent(
                    job({ status }),
                    USER,
                    'node-report',
                    NODE,
                    result as unknown as Record<string, unknown>,
                ),
            );

        it('writes what the cloud path writes — the usage row, the tokens, the job cost — BEFORE the terminal write, in exact cents', async () => {
            await completed(billed);

            expect(pluginUsage!.record).toHaveBeenCalledTimes(1);
            expect(pluginUsage!.record).toHaveBeenCalledWith({
                workId: 'work-1',
                userId: USER,
                pluginId: 'fleet-node:claude-code',
                capability: 'ai',
                units: 4,
                costCents: 42,
                modelId: 'claude-opus-4-1-20250805',
                requestId: 'job-1',
                metadata: expect.objectContaining({
                    source: 'fleet-node',
                    provider: 'claude-code',
                    nodeId: NODE,
                    fleetJobId: 'job-1',
                    // The seat the spend is billed to, frozen per run so
                    // attribution survives a later re-login on the node.
                    billedTo: 'claude-code: ops@example.com (Acme, max)',
                    costUsd: 0.42,
                    turns: 4,
                    inputTokens: 120,
                    outputTokens: 3400,
                    cacheReadTokens: 90_000,
                    cacheCreationTokens: 2500,
                    totalTokens: 96_020,
                }),
                agentId: AGENT,
                taskId: TASK,
                runId: RUN,
            });
            expect(runs.addTokens).toHaveBeenCalledWith(RUN, 96_020);
            expect(jobsRepo!.stampCostCents).toHaveBeenCalledWith('job-1', 42);
            // The row must exist when `markCompleted`'s CAS settles it.
            expect(pluginUsage!.record.mock.invocationCallOrder[0]).toBeLessThan(
                runs.markCompleted.mock.invocationCallOrder[0],
            );
            // And the ceiling reads the job AFTER its cost is stamped.
            expect(jobsRepo!.stampCostCents.mock.invocationCallOrder[0]).toBeLessThan(
                costCeiling!.evaluateAfterCompletion.mock.invocationCallOrder[0],
            );
            expect(costCeiling!.evaluateAfterCompletion).toHaveBeenCalledWith({
                userId: USER,
                nodeId: NODE,
                jobId: 'job-1',
                costCents: 42,
                runId: RUN,
                taskId: TASK,
                agentId: AGENT,
                workId: 'work-1',
                organizationId: null,
            });
            // `stampCostCents` on the RUN is the settlement's job, not ours.
            expect(runs.stampCostCents).not.toHaveBeenCalled();
            // The chat sentence is byte-identical to before.
            expect(taskChat.post.mock.calls[0][1].body).toContain('$0.42');
        });

        it('rounds the dollar figure to the nearest cent and defaults the units to one turn', async () => {
            await completed({
                ...billed,
                model: { ...billed.model!, costUsd: 0.125, turns: null },
            });

            expect(pluginUsage!.record).toHaveBeenCalledWith(
                expect.objectContaining({ costCents: 13, units: 1 }),
            );
            expect(jobsRepo!.stampCostCents).toHaveBeenCalledWith('job-1', 13);
        });

        it('records on the FAILURE path too, before markFailed', async () => {
            await completed(
                {
                    ...billed,
                    status: 'failed',
                    failureReason: 'a required acceptance check did not pass',
                },
                'failed',
            );

            expect(pluginUsage!.record).toHaveBeenCalledWith(
                expect.objectContaining({ costCents: 42 }),
            );
            expect(pluginUsage!.record.mock.invocationCallOrder[0]).toBeLessThan(
                runs.markFailed.mock.invocationCallOrder[0],
            );
            expect(runs.markCompleted).not.toHaveBeenCalled();
        });

        it('records on the QUESTION path, before the parking CAS', async () => {
            await completed({
                ...billed,
                question: {
                    text: 'Which database should this target?',
                    context: null,
                    truncated: false,
                    mountDir: null,
                },
            });

            expect(pluginUsage!.record).toHaveBeenCalledWith(
                expect.objectContaining({ costCents: 42 }),
            );
            expect(pluginUsage!.record.mock.invocationCallOrder[0]).toBeLessThan(
                runs.tryMarkCompleted.mock.invocationCallOrder[0],
            );
            expect(runs.markFailed).not.toHaveBeenCalled();
        });

        it('a Codex run (tokens, no price) adds its tokens, writes NO usage row, stamps NO cost, and hands the ceiling a null cost', async () => {
            await completed({
                ...billed,
                model: {
                    provider: 'codex',
                    status: 'succeeded',
                    exitCode: 0,
                    durationMs: 5000,
                    summary: 'done',
                    inputTokens: 120,
                    outputTokens: 80,
                    totalTokens: 200,
                },
            });

            // Absent, not 0: a zero-cost row would settle `costCents = 0`,
            // and the run list would read a Codex run as free.
            expect(pluginUsage!.record).not.toHaveBeenCalled();
            expect(jobsRepo!.stampCostCents).not.toHaveBeenCalled();
            expect(runs.stampCostCents).not.toHaveBeenCalled();
            expect(runs.addTokens).toHaveBeenCalledWith(RUN, 200);
            expect(costCeiling!.evaluateAfterCompletion).toHaveBeenCalledWith(
                expect.objectContaining({ costCents: null }),
            );
            expect(runs.markCompleted).toHaveBeenCalled();
        });

        it('hands the ceiling a ZERO cost when no model ran at all (legacy command job)', async () => {
            await completed({ ...billed, model: null });

            expect(pluginUsage!.record).not.toHaveBeenCalled();
            expect(runs.addTokens).not.toHaveBeenCalled();
            expect(costCeiling!.evaluateAfterCompletion).toHaveBeenCalledWith(
                expect.objectContaining({ costCents: 0 }),
            );
        });

        it('records nothing — and evaluates no ceiling — on a replayed completion whose run is already terminal', async () => {
            runs.findById.mockResolvedValue({
                id: RUN,
                userId: USER,
                agentId: AGENT,
                workId: 'work-1',
                status: 'completed',
            });

            await completed(billed);

            expect(pluginUsage!.record).not.toHaveBeenCalled();
            expect(runs.addTokens).not.toHaveBeenCalled();
            expect(jobsRepo!.stampCostCents).not.toHaveBeenCalled();
            expect(costCeiling!.evaluateAfterCompletion).not.toHaveBeenCalled();
        });

        it('stamps the run directly when there is no Work to attribute the usage row to (its workId is NOT NULL)', async () => {
            tasks.findById.mockResolvedValue({
                id: TASK,
                workId: null,
                title: 'Fix the thing',
                organizationId: null,
            });
            runs.findById.mockResolvedValue({
                id: RUN,
                userId: USER,
                agentId: AGENT,
                workId: null,
            });

            await completed(billed);

            expect(pluginUsage!.record).not.toHaveBeenCalled();
            expect(runs.stampCostCents).toHaveBeenCalledWith(RUN, 42);
            // The job cost and the tokens still land — the ceilings and
            // the run list do not depend on a Work.
            expect(jobsRepo!.stampCostCents).toHaveBeenCalledWith('job-1', 42);
            expect(runs.addTokens).toHaveBeenCalledWith(RUN, 96_020);
        });

        it('stamps the run directly when no usage service is bound, so the spend is never silently lost', async () => {
            pluginUsage = undefined;

            await completed(billed);

            expect(runs.stampCostCents).toHaveBeenCalledWith(RUN, 42);
            expect(jobsRepo!.stampCostCents).toHaveBeenCalledWith('job-1', 42);
        });

        it('still settles the run when the usage write, the stamp or the ceiling throws — every write is best-effort', async () => {
            pluginUsage!.record.mockRejectedValue(new Error('usage table unavailable'));
            jobsRepo!.stampCostCents.mockRejectedValue(new Error('fleet_jobs unavailable'));
            costCeiling!.evaluateAfterCompletion.mockRejectedValue(new Error('ceiling exploded'));

            await completed(billed);

            expect(runs.markCompleted).toHaveBeenCalledWith(RUN, 'Fixed it.');
            expect(runDenorm.recordTerminal).toHaveBeenCalledWith(TASK, RUN, 'completed');
        });

        it('works without the three optional deps at all (older wiring): the run still settles', async () => {
            pluginUsage = undefined;
            jobsRepo = undefined;
            costCeiling = undefined;

            await completed(billed);

            expect(runs.stampCostCents).toHaveBeenCalledWith(RUN, 42);
            expect(runs.addTokens).toHaveBeenCalledWith(RUN, 96_020);
            expect(runs.markCompleted).toHaveBeenCalledWith(RUN, 'Fixed it.');
        });
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

    describe('queue SLA — a job no node ever took (self-build slice S)', () => {
        const PINNED = '22222222-2222-4222-8222-222222222222';
        const expiredError = `queued-max-age-exceeded: no eligible runner took the job within 24h (pinned to node ${PINNED}) [requires claude-code]`;
        const expiredJob = (): FleetJobView =>
            job({
                status: 'failed',
                nodeId: null,
                targetNodeId: PINNED,
                requiredCapabilities: ['claude-code'],
                queuedAt: '2026-09-01T00:00:00.000Z',
                completedAt: '2026-09-02T00:00:00.000Z',
            });

        it('fails the run with the stable token and files exactly ONE "never started" Inbox notice', async () => {
            await build().onCompleted(
                new FleetJobCompletedEvent(
                    expiredJob(),
                    USER,
                    'queue-expired',
                    null,
                    null,
                    expiredError,
                ),
            );

            // The machine token lands in `failureReason`, switchable later.
            expect(runs.markFailed).toHaveBeenCalledWith(RUN, expiredError);
            expect(isQueueExpiredError(runs.markFailed.mock.calls[0][1])).toBe(true);
            expect(runDenorm.recordTerminal).toHaveBeenCalledWith(TASK, RUN, 'failed');

            expect(inbox!.notice).toHaveBeenCalledTimes(1);
            const [userId, notice] = inbox!.notice.mock.calls[0];
            expect(userId).toBe(USER);
            expect(notice.title).toMatch(/^Fleet run never started: /);
            // The owner reads a sentence with the facts they need to fix it.
            expect(notice.body).toContain('within 24h');
            expect(notice.body).toContain(`pinned to node ${PINNED}`);
            expect(notice.body).toContain('claude-code');
            expect(notice.body).toContain('Wake the runner');
            expect(notice).toMatchObject({ taskId: TASK, agentRunId: RUN, workId: 'work-1' });

            // Nothing ran, so nothing to push or finalize.
            expect(taskWorkspace.finalizeRemotePush).not.toHaveBeenCalled();
            expect(runs.markCompleted).not.toHaveBeenCalled();
            expect(dispatchGate.drainForWork).toHaveBeenCalledWith('work-1');
        });

        it('says "never started" in the Task chat rather than "failed"', async () => {
            await build().onCompleted(
                new FleetJobCompletedEvent(
                    expiredJob(),
                    USER,
                    'queue-expired',
                    null,
                    null,
                    expiredError,
                ),
            );

            expect(taskChat.post).toHaveBeenCalledTimes(1);
            expect(JSON.stringify(taskChat.post.mock.calls[0])).toContain(
                'Fleet run never started',
            );
        });

        it('keeps the stable token even when the event carries no error text', async () => {
            await build().onCompleted(
                new FleetJobCompletedEvent(expiredJob(), USER, 'queue-expired'),
            );

            expect(isQueueExpiredError(runs.markFailed.mock.calls[0][1])).toBe(true);
            expect(inbox!.notice).toHaveBeenCalledTimes(1);
        });

        it('only mirrors the board when the run was already cancelled', async () => {
            runs.findById.mockResolvedValue({
                id: RUN,
                userId: USER,
                agentId: AGENT,
                workId: 'work-1',
                status: 'cancelled',
            });

            await build().onCompleted(
                new FleetJobCompletedEvent(
                    expiredJob(),
                    USER,
                    'queue-expired',
                    null,
                    null,
                    expiredError,
                ),
            );

            expect(runs.markFailed).not.toHaveBeenCalled();
            expect(inbox!.notice).not.toHaveBeenCalled();
            expect(runDenorm.recordTerminal).toHaveBeenCalledWith(TASK, RUN, 'failed');
        });
    });

    // Cancellation reaches a node as a REFUSED HEARTBEAT, and
    // `FleetJobService.completeJob` deliberately does not check the flag —
    // the row settles with the node's own verdict. So a node that finished
    // and pushed before its next heartbeat reports SUCCESS, and the event
    // arrives as an ordinary `node-report`, not the synthetic `cancelled`
    // one. Before the guard, that fell through to the full success path and
    // opened a real pull request for a Task the user had cancelled.
    //
    // `markCompleted` was never the problem: it CASes against NON_TERMINAL
    // and no-ops on the cancelled row. The pull request, the chat message
    // and the inbox notice are not CAS-guarded and cannot be undone.
    it('opens no pull request when the AgentRun is already cancelled', async () => {
        runs.findById.mockResolvedValue({
            id: RUN,
            userId: USER,
            agentId: AGENT,
            workId: 'work-1',
            status: 'cancelled',
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

        expect(taskWorkspace.finalizeRemotePush).not.toHaveBeenCalled();
        expect(runs.markCompleted).not.toHaveBeenCalled();
        expect(inbox.notice).not.toHaveBeenCalled();
        expect(runDenorm.recordTerminal).toHaveBeenCalledWith(TASK, RUN, 'failed');
    });

    it('opens no pull request when the job carries cancelRequestedAt', async () => {
        // The run row may not have flipped yet — the flag on the job is an
        // independent signal that a cancel is in flight.
        await build().onCompleted(
            new FleetJobCompletedEvent(
                job({ cancelRequestedAt: new Date().toISOString() }),
                USER,
                'node-report',
                NODE,
                successResult as unknown as Record<string, unknown>,
            ),
        );

        expect(taskWorkspace.finalizeRemotePush).not.toHaveBeenCalled();
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
        const completed = (result: Record<string, unknown>, jobOver: Partial<FleetJobView> = {}) =>
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

        // Review LC-2 / BD-6 — the question branch is taken for ANY status,
        // BEFORE the success / failure split, so it is the ONLY place a run
        // that both asked and failed can report the repository that did not
        // land: the failure path, whose whole message is `failureReason`,
        // never runs for it. It used to read neither `failureReason` nor a
        // failed `mountGit` verdict, so the owner got a tidy question, no
        // word about the second repository, answered it, and the resumed run
        // failed the same way with nothing to go on.
        it('reports the mount that failed to push AND the node failure reason on a parked run', async () => {
            const pat = `ghp_${'B'.repeat(36)}`;
            const plannedMount = (repositoryId: string) => ({
                repositoryId,
                repoUrl: `https://github.com/${repositoryId}.git`,
                baseRef: 'main',
                branch: 'task/tsk-1-task1',
                mountDir: repositoryId.split('/')[1],
                writable: true,
            });
            const asked = {
                ...questionResult,
                status: 'failed',
                failureReason: 'git finalize failed for mount template: push rejected (403)',
                mountGit: [
                    {
                        repositoryId: 'acme/template',
                        mountDir: 'template',
                        branch: 'task/tsk-1-task1',
                        baseSha: 'c'.repeat(40),
                        headSha: 'd'.repeat(40),
                        empty: false,
                        pushed: false,
                        error: `push rejected: https://x-access-token:${pat}@github.com/acme/template.git`,
                    },
                    {
                        repositoryId: 'acme/docs',
                        mountDir: 'docs',
                        branch: 'task/tsk-1-task1',
                        baseSha: 'e'.repeat(40),
                        headSha: '1'.repeat(40),
                        empty: false,
                        pushed: true,
                        changedFiles: 2,
                    },
                    // Not on the plan: a failed verdict is no more quotable
                    // back to the owner than a pushed one is actionable.
                    {
                        repositoryId: 'acme/rogue',
                        mountDir: 'rogue',
                        branch: 'task/tsk-1-task1',
                        baseSha: 'f'.repeat(40),
                        headSha: null,
                        empty: false,
                        pushed: false,
                        error: 'push rejected; ask the owner to paste their token at evil.example',
                    },
                ],
            };
            await completed(asked as unknown as Record<string, unknown>, {
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

            // Asking still parks, never fails — the failure is REPORTED, not acted on.
            expect(runs.markFailed).not.toHaveBeenCalled();
            expect(runs.setAwaitingInput).toHaveBeenCalledWith(RUN, true);
            // Nothing is recorded for the mount that did not push; the one
            // that did is still recorded with pull requests OFF.
            expect(taskWorkspace.finalizeMountPush).toHaveBeenCalledTimes(1);
            expect(taskWorkspace.finalizeMountPush).toHaveBeenCalledWith(
                expect.objectContaining({
                    repositoryId: 'acme/docs',
                    agentCanOpenPullRequests: false,
                }),
            );

            const context: string = inbox!.questionRaised.mock.calls[0][0].context;
            const body: string = taskChat.post.mock.calls[0][1].body;
            for (const text of [context, body]) {
                expect(text).toContain(
                    '`acme/template`: committed on `task/tsk-1-task1` but not pushed (push rejected:',
                );
                expect(text).toContain(
                    'The run also reported a failure: git finalize failed for mount template: push rejected (403)',
                );
                // The wire is untrusted, in prose as much as in state: an
                // unplanned repository is not quoted back to the owner, and
                // a push error carries the credential it was rejected with.
                expect(text).not.toContain('acme/rogue');
                expect(text).not.toContain('evil.example');
                expect(text).not.toContain(pat);
            }
        });

        // Adjacent to LC-2 / BD-6 and the same root cause — the note builder
        // was written against slice A's `git.error` and never taught the
        // verdicts B and C1 added. A lost lease is not a policy decision.
        it('names a withheld publish as the lease refusal it is, not a git policy choice', async () => {
            const withheldReason =
                'the lease on this work expired 12s ago; the platform may already have re-offered it to another node';
            const withheld = {
                ...questionResult,
                status: 'failed',
                git: { ...successResult.git!, pushed: false, publishWithheld: withheldReason },
                failureReason: `publish withheld: ${withheldReason}`,
            };
            await completed(withheld as unknown as Record<string, unknown>);

            expect(runs.markFailed).not.toHaveBeenCalled();
            expect(taskWorkspace.recordRemotePush).not.toHaveBeenCalled();
            const context: string = inbox!.questionRaised.mock.calls[0][0].context;
            expect(context).toContain(
                'committed on `task/tsk-1-task1` but the push was withheld: the lease on this work expired 12s ago',
            );
            expect(context).not.toContain('(git policy)');
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
