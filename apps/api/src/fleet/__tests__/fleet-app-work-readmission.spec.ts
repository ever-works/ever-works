import { ConflictException } from '@nestjs/common';
import type { FleetExecutionPreferenceService, FleetJobService } from '@ever-works/agent/fleet';
import type { AgentTaskExecuteDispatchPayload } from '@ever-works/agent/tasks-domain';
import { RunDispatchGateService, RunSteeringService } from '@ever-works/agent/agents';
import {
    IsolatedRunAdmissionService,
    type IsolatedRunAdmissionReads,
} from '@ever-works/agent/app-works';
import { NodeDispatcherFactory, NodeJobRuntimePlugin } from '@ever-works/job-runtime-node-plugin';
import { createFleetAwareAgentTaskExecuteDispatcher } from '../fleet-agent-task.dispatcher';
import { FleetRunRouterService } from '../fleet-run-router.service';
import type { FleetRunnerStatusService } from '../fleet-runner-status.service';

/**
 * APW-08 T12 / T48 — review of #3040, MAJOR 1: drained, promoted and resumed runs are
 * RE-ADMITTED.
 *
 * `dispatchAgentRun` is not the only way a run reaches the Fleet: the dispatch gate's drain of a
 * concurrency park, its promotion of a `kill-switch` park once the stop flag clears, and every
 * resume (the CI fix loop's `resumeRun`, an answered question's `resume`) call
 * `dispatcher.enqueue` directly. So the Fleet half of isolated-run admission lives in the
 * fleet-aware dispatcher's `enqueue`, and these specs drive each of those callers — the REAL
 * `RunDispatchGateService` and `RunSteeringService` — through the REAL dispatcher and the REAL
 * router, over the REAL admission service:
 *
 *   - an App Work run that is not admissible (a node downgrade the owner never allowed, or
 *     withdrew) is refused at the enqueue, recorded on the run row
 *     (`dispatch-failed: containmentDowngrade: …`), and no fleet job is written;
 *   - an admissible one is written with the `appWorkId` marker the lease and the reconciler read;
 *   - a run on any other kind drains and resumes exactly as before (no marker).
 */

const WORK_APP = '44444444-4444-4444-8444-444444444444';
const WORK_SITE = '55555555-5555-4555-8555-555555555555';
const NODE = '11111111-1111-4111-8111-111111111111';
const OWNER = 'user-1';
const DOWNGRADE =
    /^dispatch-failed: containmentDowngrade: This machine runs app changes without an isolated home\./;

const declined = {
    executionPath: 'ordinary',
    isolatedHome: false,
    downgrades: [{ control: 'isolated-home', reason: 'modelHomeIsolation=inherit' }],
};
const isolated = { executionPath: 'ordinary', isolatedHome: true, downgrades: [] };

describe('APW-08 T12 — drained, promoted and resumed runs are re-admitted at the Fleet enqueue', () => {
    const originalEnv = process.env;
    let store: { enqueue: jest.Mock; findById: jest.Mock };
    let delegate: { enqueue: jest.Mock };
    let report: unknown;
    let allowances: unknown[] | null;
    let taskWork: Record<string, string>;

    const admission = () => {
        const reads: IsolatedRunAdmissionReads = {
            works: {
                findById: async (id) =>
                    id === WORK_APP || id === WORK_SITE
                        ? ({
                              id,
                              userId: OWNER,
                              kind: id === WORK_APP ? 'app' : 'directory',
                              appRunContainmentAllowances: allowances,
                              getRepoOwner: () => 'maya',
                              getDataRepo: () => 'bookings-data',
                              getWebsiteRepo: () => 'bookings',
                          } as never)
                        : null,
            },
            tasks: { findById: async (id) => ({ id, workId: taskWork[id] ?? null }) },
            fleet: {
                nodesForUser: async () => [
                    { id: NODE, userId: OWNER, status: 'online', capabilities: [] },
                ],
                latestContainment: async () => report,
            },
            pushCredential: async () => true,
        };
        return new IsolatedRunAdmissionService(reads);
    };

    const buildDispatcher = () => {
        const factory = new NodeDispatcherFactory({ store });
        const plugin = new NodeJobRuntimePlugin().useDispatcherFactory(factory);
        const router = new FleetRunRouterService(
            factory,
            plugin,
            undefined,
            {
                resolveForUser: jest.fn(async () => 'local-wait'),
            } as unknown as FleetExecutionPreferenceService,
            {
                availability: jest.fn(async () => ({ total: 1, online: 1, free: 1 })),
            } as unknown as FleetRunnerStatusService,
            { resolveAgentTaskTarget: jest.fn(async () => null) } as unknown as FleetJobService,
        );
        return createFleetAwareAgentTaskExecuteDispatcher(delegate, router, {
            scopeResolver: {
                resolve: jest.fn(async (taskId: string) => ({
                    workId: taskWork[taskId] ?? null,
                    goalId: null,
                })),
            },
            delegationScopeGuard: {
                refuseUnenforceableDelegationScope: jest.fn(async () => undefined),
            },
            appWorkAdmission: admission(),
        });
    };

    const jobPayloads = () =>
        store.enqueue.mock.calls.map((call) => call[0].payload as Record<string, unknown>);

    beforeEach(() => {
        process.env = { ...originalEnv };
        process.env.EVER_WORKS_JOB_RUNTIME = 'node';
        delete process.env.FLEET_NODE_RUNTIME_ENABLED;
        delete process.env.FLEET_NODE_AGENT_TASK_COMMAND;
        store = {
            enqueue: jest.fn(async () => ({ id: 'fleet-job-1' })),
            findById: jest.fn(async () => null),
        };
        delegate = { enqueue: jest.fn(async () => ({ runId: 'trigger-1' })) };
        report = declined;
        allowances = null;
        taskWork = { 'task-app': WORK_APP, 'task-site': WORK_SITE };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    describe('the enqueue itself', () => {
        const payload = (taskId: string): AgentTaskExecuteDispatchPayload => ({
            agentId: 'agent-1',
            userId: OWNER,
            taskId,
            dedupKey: `${taskId}:agent-1:drain:run-9`,
            runId: 'run-9',
        });

        it('refuses a non-admissible App Work run with the site-1 code, writes no job, never falls back to the cloud', async () => {
            await expect(buildDispatcher().enqueue(payload('task-app'))).rejects.toThrow(
                /^containmentDowngrade: /,
            );
            expect(store.enqueue).not.toHaveBeenCalled();
            expect(delegate.enqueue).not.toHaveBeenCalled();
        });

        it('stamps an admitted App Work job with `appWorkId` (what the lease and the reconciler read)', async () => {
            report = isolated;
            await buildDispatcher().enqueue(payload('task-app'));
            expect(jobPayloads()[0]).toMatchObject({ taskId: 'task-app', appWorkId: WORK_APP });
        });

        it('a run on any other kind is enqueued exactly as before, with no marker', async () => {
            await buildDispatcher().enqueue(payload('task-site'));
            expect(jobPayloads()[0]).not.toHaveProperty('appWorkId');
        });

        it('a Task whose Work the scope lookup missed is read itself; one it cannot read is refused work-unreadable', async () => {
            const dispatcher = createFleetAwareAgentTaskExecuteDispatcher(
                delegate,
                {
                    routeAgentTask: jest.fn(async () => ({ target: 'fleet', mode: 'local-wait' })),
                    enqueueAgentTask: jest.fn(async () => ({ runId: 'job-x' })),
                } as never,
                {
                    scopeResolver: { resolve: jest.fn(async () => ({})) },
                    delegationScopeGuard: {
                        refuseUnenforceableDelegationScope: jest.fn(async () => undefined),
                    },
                    appWorkAdmission: new IsolatedRunAdmissionService({
                        works: { findById: async () => null },
                        tasks: {
                            findById: async () => {
                                throw new Error('db down');
                            },
                        },
                    }),
                },
            );
            await expect(dispatcher.enqueue(payload('task-app'))).rejects.toThrow(
                /^work-unreadable: /,
            );
        });
    });

    describe('the dispatch gate (drain and promotion)', () => {
        let gateRuns: Record<string, jest.Mock>;
        const parked = (taskId: string, workId: string, queuedReason: string) => ({
            id: `run-${taskId}`,
            agentId: 'agent-1',
            userId: OWNER,
            taskId,
            workId,
            organizationId: null,
            tenantId: null,
            triggerKind: 'task',
            chatMessageId: null,
            status: 'queued',
            queuedReason,
        });

        const gate = () =>
            new RunDispatchGateService(gateRuns as never, buildDispatcher() as never);

        beforeEach(() => {
            gateRuns = {
                countInFlightForWork: jest.fn(async () => 0),
                countInFlightForUser: jest.fn(async () => 0),
                countInFlightForOrganization: jest.fn(async () => 0),
                findOldestQueuedForConcurrency: jest.fn(async () => null),
                claimQueuedForDispatch: jest.fn(async () => true),
                setTriggerRunId: jest.fn(async () => undefined),
                markDispatchFailed: jest.fn(async () => undefined),
                restoreQueuedReason: jest.fn(async () => undefined),
                relabelQueuedReason: jest.fn(async () => true),
                findQueuedWorkIdsByReason: jest.fn(async () => []),
            };
        });

        it('a DRAINED App Work run (concurrency park) is re-checked and refused when not admissible', async () => {
            gateRuns.findOldestQueuedForConcurrency.mockResolvedValueOnce(
                parked('task-app', WORK_APP, 'concurrency-limit'),
            );
            const result = await gate().drainForWork(WORK_APP);

            expect(result.dispatched).toBe(false);
            expect(gateRuns.markDispatchFailed).toHaveBeenCalledWith(
                'run-task-app',
                expect.stringMatching(DOWNGRADE),
            );
            expect(store.enqueue).not.toHaveBeenCalled();
        });

        it('a run PROMOTED after a kill-switch park is re-checked — and an allowance the owner WITHDREW no longer admits it', async () => {
            allowances = [
                { nodeId: NODE, allowedAt: 'x', allowedBy: OWNER, acceptedDowngrade: null },
            ];
            gateRuns.findQueuedWorkIdsByReason.mockResolvedValue([WORK_APP]);
            gateRuns.findOldestQueuedForConcurrency
                .mockResolvedValueOnce(parked('task-app', WORK_APP, 'kill-switch'))
                .mockResolvedValueOnce(null);
            expect((await gate().promoteParked('kill-switch')).promoted).toBe(1);
            expect(jobPayloads()[0]).toMatchObject({ appWorkId: WORK_APP });

            allowances = []; // withdrawn
            gateRuns.findOldestQueuedForConcurrency
                .mockResolvedValueOnce(parked('task-app', WORK_APP, 'kill-switch'))
                .mockResolvedValueOnce(null);
            expect((await gate().promoteParked('kill-switch')).promoted).toBe(0);
            expect(gateRuns.markDispatchFailed).toHaveBeenCalledWith(
                'run-task-app',
                expect.stringMatching(DOWNGRADE),
            );
            expect(store.enqueue).toHaveBeenCalledTimes(1);
        });

        it('a non-App drain is unchanged: dispatched, no marker', async () => {
            gateRuns.findOldestQueuedForConcurrency.mockResolvedValueOnce(
                parked('task-site', WORK_SITE, 'concurrency-limit'),
            );
            expect(await gate().drainForWork(WORK_SITE)).toMatchObject({ dispatched: true });
            expect(gateRuns.markDispatchFailed).not.toHaveBeenCalled();
            expect(jobPayloads()[0]).not.toHaveProperty('appWorkId');
        });
    });

    describe('resume (the CI fix loop and an answered question)', () => {
        let steerRuns: Record<string, jest.Mock>;
        const source = (taskId: string, workId: string, over: Record<string, unknown> = {}) => ({
            id: 'run-old',
            agentId: 'agent-1',
            userId: OWNER,
            taskId,
            workId,
            status: 'completed',
            awaitingInput: false,
            terminalEndedReason: null,
            cliSessionId: null,
            organizationId: null,
            tenantId: null,
            persistent: false,
            runnerKind: 'fleet-node:claude-code',
            ...over,
        });

        const steering = () =>
            new RunSteeringService(steerRuns as never, undefined, buildDispatcher() as never);

        beforeEach(() => {
            steerRuns = {
                findByIdAndUser: jest.fn(async () => source('task-app', WORK_APP)),
                createQueued: jest.fn(async () => ({ id: 'run-new' })),
                seedResumeContext: jest.fn(async () => undefined),
                setAwaitingInput: jest.fn(async () => undefined),
                setTriggerRunId: jest.fn(async () => undefined),
                markDispatchFailed: jest.fn(async () => undefined),
                claimResume: jest.fn(async (id: string) => ({
                    runId: id,
                    token: 'claim-1',
                    previousToken: null,
                })),
                releaseResumeClaim: jest.fn(async () => true),
                consumeResumeClaim: jest.fn(async () => true),
                findResumeSuccessor: jest.fn(async () => null),
            };
        });

        it('a CI fix-loop resume (`resumeRun`, allowCompleted) of an App Work run is re-checked and refused', async () => {
            await expect(
                steering().resumeRun({ runId: 'run-old', userId: OWNER, allowCompleted: true }),
            ).rejects.toBeInstanceOf(ConflictException);
            expect(steerRuns.markDispatchFailed).toHaveBeenCalledWith(
                'run-new',
                expect.stringMatching(DOWNGRADE),
            );
            expect(store.enqueue).not.toHaveBeenCalled();
        });

        it('an answered-question resume (`resume` with the answer) of an App Work run is re-checked and refused', async () => {
            steerRuns.findByIdAndUser.mockResolvedValue(
                source('task-app', WORK_APP, { awaitingInput: true }),
            );
            await expect(
                steering().resume('run-old', OWNER, 'Use the staging branch.'),
            ).rejects.toBeInstanceOf(ConflictException);
            expect(steerRuns.markDispatchFailed).toHaveBeenCalledWith(
                'run-new',
                expect.stringMatching(DOWNGRADE),
            );
            expect(store.enqueue).not.toHaveBeenCalled();
        });

        it('an admissible App Work resume goes out with the marker; a non-App resume is unchanged', async () => {
            report = isolated;
            await steering().resumeRun({ runId: 'run-old', userId: OWNER, allowCompleted: true });
            expect(jobPayloads()[0]).toMatchObject({ appWorkId: WORK_APP });

            steerRuns.findByIdAndUser.mockResolvedValue(source('task-site', WORK_SITE));
            await steering().resumeRun({ runId: 'run-old', userId: OWNER, allowCompleted: true });
            expect(jobPayloads()[1]).not.toHaveProperty('appWorkId');
            expect(steerRuns.markDispatchFailed).not.toHaveBeenCalled();
        });
    });
});
