import type { SubAgentDelegationRequest, SubAgentScope } from '@ever-works/contracts';
import { QUEUED_REASON_CONCURRENCY, RunDispatchGateService } from '@ever-works/agent/agents';
import type {
    AgentTaskExecuteDispatcher,
    AgentTaskExecuteDispatchPayload,
} from '@ever-works/agent/tasks-domain';
import {
    agentReviewRunScope,
    Task,
    TaskAgentReviewService,
    TaskStatus,
    TaskTransitionService,
} from '@ever-works/agent/tasks-domain';
import { NodeDispatcherFactory, NodeJobRuntimePlugin } from '@ever-works/job-runtime-node-plugin';
import { SubAgentDelegationRunnerService } from '../../agents/sub-agent-delegation.runner';
import {
    FleetAgentTaskPlanError,
    FleetAgentTaskPlannerService,
    FleetDelegationScopeRefusedError,
} from '../fleet-agent-task-planner.service';
import {
    createFleetAwareAgentTaskExecuteDispatcher,
    type FleetAgentTaskPlan,
    type FleetAgentTaskPlanner,
    type FleetAwareDispatcherDeps,
} from '../fleet-agent-task.dispatcher';
import {
    FLEET_DELEGATION_SCOPE_UNENFORCEABLE,
    FLEET_DELEGATION_SCOPE_UNVERIFIABLE,
} from '../fleet-delegation-scope';
import { FleetRunRouterService } from '../fleet-run-router.service';

/**
 * Judgment layer G9 on the fleet — the DISPATCHER side of the delegation
 * scope refusal.
 *
 * A child admitted under a narrowed scope (e.g. `allowedTools ['readFile']`)
 * is enforced only by the platform's in-process tool loop. A fleet node runs
 * a model CLI with shell and git access and pushes itself, so such a run must
 * never become a fleet job. What this suite proves, end to end where it
 * matters:
 *
 *   - the refusal happens BEFORE `plan()` and BEFORE the job row, in both the
 *     `model-cli` and the legacy `command` mode, and is never a cloud
 *     fallback;
 *   - through the real `TaskTransitionService`, the refused child's run row is
 *     marked failed with a reason naming the rule;
 *   - the delegating PARENT sees that failure on its first poll instead of
 *     waiting out its budget;
 *   - a non-delegated run still routes to the fleet exactly as before, and a
 *     cloud-routed delegated run is untouched;
 *   - the control fails closed on WIRING too: a dispatcher with no guard
 *     refuses fleet-bound runs, and the router's job writer refuses any
 *     payload the dispatcher did not clear (a direct caller).
 *
 * A sibling of `fleet-agent-task-model-cli-dispatch.spec.ts` rather than an
 * addition to it, so the reviewer-run refusal (slice AD) and this one land in
 * different files.
 */

const USER = 'user-1';

const NARROWED: SubAgentScope = { allowedTools: ['readFile'], networkAccess: false };

function payload(
    over: Partial<AgentTaskExecuteDispatchPayload> = {},
): AgentTaskExecuteDispatchPayload {
    return {
        agentId: 'agent-1',
        userId: USER,
        taskId: 'task-1',
        dedupKey: 'task-1:agent-1:1',
        runId: 'run-1',
        tenantId: null,
        organizationId: null,
        ...over,
    };
}

const plan: FleetAgentTaskPlan = {
    execution: {
        provider: 'claude-code',
        instructions: '# IDENTITY\n…\n# TASK\nFix it.',
        permissionMode: 'acceptEdits',
        timeoutSec: 1200,
        envPassthrough: ['CLAUDE_CODE_OAUTH_TOKEN'],
    },
    workspace: {
        repositoryId: 'ever-works/ever-works',
        repoUrl: 'https://github.com/ever-works/ever-works.git',
        baseRef: 'develop',
        branch: 'task/task-1',
    },
    acceptanceChecks: [
        { id: 'unit', name: 'Unit', kind: 'test', command: 'pnpm test', required: true },
    ],
    git: { commit: true, push: true, commitMessage: 'feat(task): TSK-1 agent run output' },
};

function buildTask(over: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        userId: USER,
        slug: 'TSK-1',
        title: 'Read the release notes',
        status: TaskStatus.IN_PROGRESS,
        workId: null,
        tenantId: null,
        organizationId: null,
        recurrenceOccurredCount: 0,
        ...over,
    } as unknown as Task;
}

interface RunRow {
    id: string;
    userId: string;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    delegationScope: SubAgentScope | null;
    errorMessage: string | null;
    summary: string | null;
    // What the dispatch-gate drain and the review-run variants read back.
    agentId?: string;
    taskId?: string | null;
    workId?: string | null;
    tenantId?: string | null;
    organizationId?: string | null;
    triggerKind?: string;
    queuedReason?: string | null;
    pendingInput?: string[] | null;
}

describe('fleet agent-task dispatch — delegated runs with a narrowed scope (G9)', () => {
    const originalEnv = process.env;
    let store: { enqueue: jest.Mock; findById: jest.Mock };
    let delegate: AgentTaskExecuteDispatcher & { enqueue: jest.Mock };

    const buildRouter = (): FleetRunRouterService => {
        const factory = new NodeDispatcherFactory({ store });
        const plugin = new NodeJobRuntimePlugin().useDispatcherFactory(factory);
        return new FleetRunRouterService(factory, plugin, undefined);
    };

    beforeEach(() => {
        process.env = {
            ...originalEnv,
            EVER_WORKS_JOB_RUNTIME: 'node',
            FLEET_NODE_RUNTIME_ENABLED: 'true',
        };
        process.env.FLEET_NODE_AGENT_TASK_COMMAND = 'ever-works run {taskId}';
        process.env.FLEET_NODE_REQUIRED_CAPABILITIES = 'workspace';
        delete process.env.FLEET_NODE_AGENT_TASK_WORKSPACE;
        for (const key of Object.keys(process.env)) {
            if (key.startsWith('FLEET_NODE_AGENT_EXECUTION_')) delete process.env[key];
        }
        store = {
            enqueue: jest.fn().mockImplementation(async (request) => ({
                id: 'fleet-job-1',
                kind: request.kind,
                status: 'queued',
                nodeId: null,
                requiredCapabilities: request.requiredCapabilities ?? [],
                payload: request.payload ?? null,
                leaseExpiresAt: null,
                attempts: 0,
                maxAttempts: 3,
                createdAt: null,
                startedAt: null,
                completedAt: null,
            })),
            findById: jest.fn().mockResolvedValue(null),
        };
        delegate = { enqueue: jest.fn().mockResolvedValue({ runId: 'trigger-run' }) };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    /**
     * The wiring, with a planner double: when the refusal is asked, what it
     * gates, and what it never touches.
     */
    describe('dispatcher wiring', () => {
        type PlannerDouble = FleetAgentTaskPlanner & {
            plan: jest.Mock;
            refuseUnenforceableDelegationScope: jest.Mock;
        };

        const buildDispatcher = (planner: PlannerDouble): AgentTaskExecuteDispatcher =>
            createFleetAwareAgentTaskExecuteDispatcher(delegate, buildRouter(), { planner });

        const refusal = () =>
            new FleetDelegationScopeRefusedError(
                FLEET_DELEGATION_SCOPE_UNENFORCEABLE,
                'run run-1 is a delegated sub-agent run whose scope narrows what it may do (allowedTools [readFile])',
            );

        it('refuses before plan(), writes no job and never falls back to the cloud (model-cli)', async () => {
            const planner: PlannerDouble = {
                plan: jest.fn().mockResolvedValue(plan),
                refuseUnenforceableDelegationScope: jest.fn().mockRejectedValue(refusal()),
            };

            await expect(buildDispatcher(planner).enqueue(payload())).rejects.toThrow(
                FLEET_DELEGATION_SCOPE_UNENFORCEABLE,
            );
            // Asked with the dispatch payload exactly — it reads the run row
            // by `runId`, the payload carries no scope of its own.
            expect(planner.refuseUnenforceableDelegationScope).toHaveBeenCalledWith(payload());
            expect(planner.plan).not.toHaveBeenCalled();
            expect(store.enqueue).not.toHaveBeenCalled();
            expect(delegate.enqueue).not.toHaveBeenCalled();
        });

        it('refuses in the legacy command mode too, where plan() would return null', async () => {
            const planner: PlannerDouble = {
                plan: jest.fn().mockResolvedValue(null),
                refuseUnenforceableDelegationScope: jest.fn().mockRejectedValue(refusal()),
            };

            await expect(buildDispatcher(planner).enqueue(payload())).rejects.toBeInstanceOf(
                FleetDelegationScopeRefusedError,
            );
            expect(planner.plan).not.toHaveBeenCalled();
            // A null plan is exactly what would have written the legacy steps.
            expect(store.enqueue).not.toHaveBeenCalled();
            expect(delegate.enqueue).not.toHaveBeenCalled();
        });

        it('asks first, then plans and enqueues an unrestricted run exactly as before', async () => {
            const planner: PlannerDouble = {
                plan: jest.fn().mockResolvedValue(plan),
                refuseUnenforceableDelegationScope: jest.fn().mockResolvedValue(undefined),
            };

            const out = await buildDispatcher(planner).enqueue(payload());

            expect(out).toEqual({ runId: 'fleet-job-1' });
            expect(
                planner.refuseUnenforceableDelegationScope.mock.invocationCallOrder[0],
            ).toBeLessThan(planner.plan.mock.invocationCallOrder[0]);
            expect(planner.plan).toHaveBeenCalledWith(payload());
            expect(store.enqueue).toHaveBeenCalledTimes(1);
            // The same job the model-cli wiring spec pins, byte for byte.
            const request = store.enqueue.mock.calls[0][0];
            expect(request.requiredCapabilities).toEqual(['workspace', 'git-push', 'claude-code']);
            expect(request.payload).toEqual({
                taskId: 'task-1',
                agentId: 'agent-1',
                userId: USER,
                runId: 'run-1',
                execution: plan.execution,
                workspace: plan.workspace,
                acceptanceChecks: plan.acceptanceChecks,
                git: plan.git,
            });
            expect(delegate.enqueue).not.toHaveBeenCalled();
        });

        it('never asks about a run routed to the cloud — the in-process loop enforces the scope there', async () => {
            process.env.EVER_WORKS_JOB_RUNTIME = 'trigger';
            const planner: PlannerDouble = {
                plan: jest.fn().mockResolvedValue(plan),
                refuseUnenforceableDelegationScope: jest.fn().mockRejectedValue(refusal()),
            };

            await expect(buildDispatcher(planner).enqueue(payload())).resolves.toEqual({
                runId: 'trigger-run',
            });
            expect(planner.refuseUnenforceableDelegationScope).not.toHaveBeenCalled();
            expect(planner.plan).not.toHaveBeenCalled();
            expect(delegate.enqueue).toHaveBeenCalledTimes(1);
            expect(store.enqueue).not.toHaveBeenCalled();
        });

        /**
         * The control must not be switchable off by leaving it out of the
         * graph. Revert-check: restore `if (deps.planner?.refuse…)` (skip when
         * absent) and the first two of these go RED.
         */
        describe('fails closed when no guard is wired', () => {
            const expectUnverifiableRefusal = async (
                dispatcher: AgentTaskExecuteDispatcher,
                why: string,
            ) => {
                const refusal = await dispatcher.enqueue(payload()).then(
                    () => null,
                    (err: unknown) => err,
                );
                expect(refusal).toBeInstanceOf(FleetDelegationScopeRefusedError);
                const error = refusal as FleetDelegationScopeRefusedError;
                expect(error.code).toBe(FLEET_DELEGATION_SCOPE_UNVERIFIABLE);
                expect(error.message).toContain('run run-1');
                expect(error.message).toContain(why);
                expect(error.message).toContain('never assumed to be unrestricted');
                // No job row, and never the cloud instead.
                expect(store.enqueue).not.toHaveBeenCalled();
                expect(delegate.enqueue).not.toHaveBeenCalled();
            };

            it('refuses a fleet-bound run when no planner and no guard are wired (legacy command mode)', async () => {
                await expectUnverifiableRefusal(
                    createFleetAwareAgentTaskExecuteDispatcher(delegate, buildRouter()),
                    'no guard and no planner',
                );
            });

            it('refuses a fleet-bound run when the planner does not implement the guard, before planning', async () => {
                const planner = { plan: jest.fn().mockResolvedValue(plan) };

                await expectUnverifiableRefusal(
                    createFleetAwareAgentTaskExecuteDispatcher(delegate, buildRouter(), {
                        planner,
                    }),
                    'the planner does not implement refuseUnenforceableDelegationScope',
                );
                expect(planner.plan).not.toHaveBeenCalled();
            });

            it('still sends a cloud-routed run to the cloud with no guard wired', async () => {
                process.env.EVER_WORKS_JOB_RUNTIME = 'trigger';

                await expect(
                    createFleetAwareAgentTaskExecuteDispatcher(delegate, buildRouter()).enqueue(
                        payload(),
                    ),
                ).resolves.toEqual({ runId: 'trigger-run' });
                expect(store.enqueue).not.toHaveBeenCalled();
            });
        });

        describe('an explicit delegationScopeGuard', () => {
            it('is asked instead of the planner, and its refusal stops the dispatch', async () => {
                const planner: PlannerDouble = {
                    plan: jest.fn().mockResolvedValue(plan),
                    refuseUnenforceableDelegationScope: jest.fn().mockResolvedValue(undefined),
                };
                const delegationScopeGuard = {
                    refuseUnenforceableDelegationScope: jest.fn().mockRejectedValue(refusal()),
                };

                await expect(
                    createFleetAwareAgentTaskExecuteDispatcher(delegate, buildRouter(), {
                        planner,
                        delegationScopeGuard,
                    }).enqueue(payload()),
                ).rejects.toThrow(FLEET_DELEGATION_SCOPE_UNENFORCEABLE);
                expect(
                    delegationScopeGuard.refuseUnenforceableDelegationScope,
                ).toHaveBeenCalledWith(payload());
                expect(planner.refuseUnenforceableDelegationScope).not.toHaveBeenCalled();
                expect(planner.plan).not.toHaveBeenCalled();
                expect(store.enqueue).not.toHaveBeenCalled();
                expect(delegate.enqueue).not.toHaveBeenCalled();
            });

            it('lets a planner-less dispatcher write the legacy command job once it admits the run', async () => {
                const delegationScopeGuard = {
                    refuseUnenforceableDelegationScope: jest.fn().mockResolvedValue(undefined),
                };

                await expect(
                    createFleetAwareAgentTaskExecuteDispatcher(delegate, buildRouter(), {
                        delegationScopeGuard,
                    }).enqueue(payload()),
                ).resolves.toEqual({ runId: 'fleet-job-1' });
                expect(store.enqueue).toHaveBeenCalledTimes(1);
                expect(store.enqueue.mock.calls[0][0].payload.steps).toEqual([
                    expect.objectContaining({ id: 'agent-task', command: 'ever-works run task-1' }),
                ]);
            });
        });
    });

    /**
     * `FleetRunRouterService.enqueueAgentTask` is the one writer of
     * `agent-task` fleet rows. A caller that goes straight to it — skipping
     * the dispatcher and so the guard — must be refused there, the same
     * posture the global stop flag takes for direct callers.
     */
    describe('job writer chokepoint (the router)', () => {
        const admittingGuard = () => ({
            refuseUnenforceableDelegationScope: jest.fn().mockResolvedValue(undefined),
        });

        it('refuses a direct enqueue that never went through the guard, writing no job', async () => {
            const refusal = await buildRouter()
                .enqueueAgentTask(payload(), null, plan)
                .then(
                    () => null,
                    (err: unknown) => err,
                );

            expect(refusal).toBeInstanceOf(FleetDelegationScopeRefusedError);
            const error = refusal as FleetDelegationScopeRefusedError;
            expect(error.code).toBe(FLEET_DELEGATION_SCOPE_UNVERIFIABLE);
            expect(error.message).toContain('run run-1');
            expect(error.message).toContain(
                "did not come through the fleet-aware dispatcher's delegation-scope guard",
            );
            expect(store.enqueue).not.toHaveBeenCalled();
        });

        it('refuses a direct legacy command enqueue the same way', async () => {
            await expect(buildRouter().enqueueAgentTask(payload())).rejects.toMatchObject({
                code: FLEET_DELEGATION_SCOPE_UNVERIFIABLE,
            });
            expect(store.enqueue).not.toHaveBeenCalled();
        });

        it('accepts the payload the dispatcher cleared, exactly once', async () => {
            const router = buildRouter();
            const cleared = payload();

            await expect(
                createFleetAwareAgentTaskExecuteDispatcher(delegate, router, {
                    delegationScopeGuard: admittingGuard(),
                }).enqueue(cleared),
            ).resolves.toEqual({ runId: 'fleet-job-1' });
            expect(store.enqueue).toHaveBeenCalledTimes(1);

            // The clearance was spent on that write: replaying the same object
            // straight into the router is a direct enqueue like any other.
            await expect(router.enqueueAgentTask(cleared)).rejects.toMatchObject({
                code: FLEET_DELEGATION_SCOPE_UNVERIFIABLE,
            });
            expect(store.enqueue).toHaveBeenCalledTimes(1);
        });

        it('leaves no usable clearance behind when planning fails after the guard admitted', async () => {
            const router = buildRouter();
            const attempted = payload();
            const planner = { plan: jest.fn().mockRejectedValue(new Error('no repository')) };

            await expect(
                createFleetAwareAgentTaskExecuteDispatcher(delegate, router, {
                    planner,
                    delegationScopeGuard: admittingGuard(),
                }).enqueue(attempted),
            ).rejects.toThrow('no repository');

            // Neither the very object the dispatcher handled nor a copy of it
            // can now be written straight through the router.
            await expect(router.enqueueAgentTask(attempted)).rejects.toMatchObject({
                code: FLEET_DELEGATION_SCOPE_UNVERIFIABLE,
            });
            await expect(router.enqueueAgentTask({ ...attempted })).rejects.toMatchObject({
                code: FLEET_DELEGATION_SCOPE_UNVERIFIABLE,
            });
            expect(store.enqueue).not.toHaveBeenCalled();
        });
    });

    /**
     * End to end with the REAL planner, router and transition service — only
     * the database and the node job store are in memory.
     */
    describe('through the production dispatch path', () => {
        let rows: Map<string, RunRow>;
        let runs: {
            createQueued: jest.Mock;
            findById: jest.Mock;
            markDispatchFailed: jest.Mock;
            setTriggerRunId: jest.Mock;
            seedResumeContext: jest.Mock;
            findOldestQueuedForConcurrency: jest.Mock;
            claimQueuedForDispatch: jest.Mock;
        };
        let plannerTasks: { findById: jest.Mock };
        /** The real planner the last {@link buildDispatcher} call wired in. */
        let planner: FleetAgentTaskPlannerService;

        const buildRuns = () => {
            rows = new Map();
            let next = 0;
            runs = {
                createQueued: jest.fn(
                    async (input: {
                        userId: string;
                        delegationScope?: SubAgentScope | null;
                        agentId?: string;
                        taskId?: string | null;
                        workId?: string | null;
                        tenantId?: string | null;
                        organizationId?: string | null;
                        triggerKind?: string;
                        queuedReason?: string | null;
                    }) => {
                        next += 1;
                        const row: RunRow = {
                            id: `run-${next}`,
                            userId: input.userId,
                            status: 'queued',
                            delegationScope: input.delegationScope ?? null,
                            errorMessage: null,
                            summary: null,
                            agentId: input.agentId,
                            taskId: input.taskId ?? null,
                            workId: input.workId ?? null,
                            tenantId: input.tenantId ?? null,
                            organizationId: input.organizationId ?? null,
                            triggerKind: input.triggerKind,
                            queuedReason: input.queuedReason ?? null,
                            pendingInput: null,
                        };
                        rows.set(row.id, row);
                        return row;
                    },
                ),
                findById: jest.fn(async (id: string) => rows.get(id) ?? null),
                // Same CAS as the repository: only a still-queued row moves.
                markDispatchFailed: jest.fn(async (id: string, errorMessage: string) => {
                    const row = rows.get(id);
                    if (row && row.status === 'queued') {
                        row.status = 'failed';
                        row.errorMessage = errorMessage;
                    }
                }),
                setTriggerRunId: jest.fn().mockResolvedValue(undefined),
                // The review brief lands here, BEFORE the enqueue.
                seedResumeContext: jest.fn(
                    async (id: string, context: { pendingInput?: string[] }) => {
                        const row = rows.get(id);
                        if (row) row.pendingInput = context.pendingInput ?? null;
                    },
                ),
                // The dispatch-gate drain's two reads/writes, with the
                // repository's semantics: FIFO over still-parked rows, and a
                // claim that only a still-queued, still-parked row accepts.
                findOldestQueuedForConcurrency: jest.fn(
                    async (workId: string, queuedReason: string) =>
                        [...rows.values()].find(
                            (row) =>
                                row.workId === workId &&
                                row.status === 'queued' &&
                                row.queuedReason === queuedReason,
                        ) ?? null,
                ),
                claimQueuedForDispatch: jest.fn(async (id: string, queuedReason: string) => {
                    const row = rows.get(id);
                    if (!row || row.status !== 'queued' || row.queuedReason !== queuedReason) {
                        return false;
                    }
                    row.queuedReason = null;
                    return true;
                }),
            };
        };

        const buildDispatcher = (
            extra: Pick<FleetAwareDispatcherDeps, 'delegationScopeGuard'> = {},
        ): AgentTaskExecuteDispatcher => {
            plannerTasks = { findById: jest.fn().mockResolvedValue(buildTask()) };
            planner = new FleetAgentTaskPlannerService(
                plannerTasks as never,
                { findByIdAndUser: jest.fn() } as never,
                { findById: jest.fn() } as never,
                {
                    describeFleetWorkspace: jest.fn(),
                    resolveFleetRunEnvGrants: jest.fn(),
                    readFleetRepoDeclaredCommands: jest.fn(),
                } as never,
                undefined,
                undefined,
                undefined,
                runs as never,
            );
            return createFleetAwareAgentTaskExecuteDispatcher(delegate, buildRouter(), {
                planner,
                ...extra,
            });
        };

        const buildTransition = (
            dispatcher: AgentTaskExecuteDispatcher,
            extra: {
                dispatchGate?: RunDispatchGateService;
                agentReviews?: TaskAgentReviewService;
            } = {},
        ): TaskTransitionService =>
            new TaskTransitionService(
                { findById: jest.fn() } as never,
                { findByTaskId: jest.fn().mockResolvedValue([]) } as never,
                { allApproved: jest.fn().mockResolvedValue(true) } as never,
                undefined,
                runs as never,
                dispatcher,
                undefined,
                undefined,
                extra.dispatchGate,
                undefined,
                undefined,
                {
                    findByIdAndUser: jest
                        .fn()
                        .mockImplementation((id, userId) =>
                            Promise.resolve({ id, userId, tenantId: null, organizationId: null }),
                        ),
                } as never,
                extra.agentReviews,
            );

        beforeEach(() => {
            buildRuns();
        });

        it.each(['command', 'model-cli'])(
            'refuses a narrowed delegated child in %s mode and fails its run with the reason',
            async (mode) => {
                process.env.FLEET_NODE_AGENT_EXECUTION_MODE = mode;

                const result = await buildTransition(buildDispatcher()).dispatchAgentRun(
                    buildTask(),
                    'agent-1',
                    { delegationScope: NARROWED },
                );

                expect(result.runId).toBe('run-1');
                expect(result.dispatched).toBe(false);
                expect(result.error).toContain(
                    `dispatch-failed: ${FLEET_DELEGATION_SCOPE_UNENFORCEABLE}:`,
                );
                // No job row, no cloud run — and the planner never started.
                expect(store.enqueue).not.toHaveBeenCalled();
                expect(delegate.enqueue).not.toHaveBeenCalled();
                expect(plannerTasks.findById).not.toHaveBeenCalled();
                // Visible where a human (and the parent) reads it.
                const row = rows.get('run-1')!;
                expect(row.status).toBe('failed');
                expect(row.errorMessage).toContain(FLEET_DELEGATION_SCOPE_UNENFORCEABLE);
                expect(row.errorMessage).toContain('allowedTools [readFile]; networkAccess off');
                expect(row.errorMessage).toContain('no fleet node can enforce a delegation scope');
            },
        );

        it('routes a non-delegated run to the fleet exactly as before (legacy command job)', async () => {
            const result = await buildTransition(buildDispatcher()).dispatchAgentRun(
                buildTask(),
                'agent-1',
            );

            expect(result).toEqual({ runId: 'run-1', dispatched: true, parked: false });
            // The guard read the row it was handed, and nothing else changed.
            expect(runs.findById).toHaveBeenCalledWith('run-1');
            expect(runs.markDispatchFailed).not.toHaveBeenCalled();
            expect(delegate.enqueue).not.toHaveBeenCalled();
            expect(store.enqueue).toHaveBeenCalledTimes(1);
            const request = store.enqueue.mock.calls[0][0];
            expect(request.kind).toBe('agent-task');
            expect(request.requiredCapabilities).toEqual(['workspace', 'git-push']);
            expect(request.payload).toMatchObject({
                taskId: 'task-1',
                agentId: 'agent-1',
                userId: USER,
                runId: 'run-1',
                steps: [
                    expect.objectContaining({ id: 'agent-task', command: 'ever-works run task-1' }),
                ],
            });
            expect(runs.setTriggerRunId).toHaveBeenCalledWith('run-1', 'fleet-job-1');
            expect(rows.get('run-1')!.status).toBe('queued');
        });

        it('routes a delegated run with an unrestricted scope to the fleet as before', async () => {
            const result = await buildTransition(buildDispatcher()).dispatchAgentRun(
                buildTask(),
                'agent-1',
                { delegationScope: { allowedTools: ['*'], networkAccess: true } },
            );

            expect(result.dispatched).toBe(true);
            expect(store.enqueue).toHaveBeenCalledTimes(1);
            expect(runs.markDispatchFailed).not.toHaveBeenCalled();
        });

        it('fails a run dispatched through a dispatcher with no guard wired, and never moves it to the cloud', async () => {
            // A mis-wired graph: the fleet dispatcher without its planner.
            const dispatcher = createFleetAwareAgentTaskExecuteDispatcher(delegate, buildRouter());

            const result = await buildTransition(dispatcher).dispatchAgentRun(
                buildTask(),
                'agent-1',
                { delegationScope: NARROWED },
            );

            expect(result.dispatched).toBe(false);
            expect(result.error).toContain(
                `dispatch-failed: ${FLEET_DELEGATION_SCOPE_UNVERIFIABLE}:`,
            );
            expect(store.enqueue).not.toHaveBeenCalled();
            expect(delegate.enqueue).not.toHaveBeenCalled();
            const row = rows.get('run-1')!;
            expect(row.status).toBe('failed');
            expect(row.errorMessage).toContain('no delegation-scope guard is wired');
        });

        it('fails closed when the run row cannot be read, and still never moves the run to the cloud', async () => {
            const dispatcher = buildDispatcher();
            runs.findById.mockRejectedValueOnce(new Error('connection reset'));

            const result = await buildTransition(dispatcher).dispatchAgentRun(
                buildTask(),
                'agent-1',
            );

            expect(result.dispatched).toBe(false);
            expect(result.error).toContain(FLEET_DELEGATION_SCOPE_UNVERIFIABLE);
            expect(result.error).toContain('connection reset');
            expect(store.enqueue).not.toHaveBeenCalled();
            expect(delegate.enqueue).not.toHaveBeenCalled();
            expect(rows.get('run-1')!.status).toBe('failed');
        });

        it('leaves a cloud-routed delegated run alone — its scope stays on the row for the worker', async () => {
            process.env.EVER_WORKS_JOB_RUNTIME = 'trigger';

            const result = await buildTransition(buildDispatcher()).dispatchAgentRun(
                buildTask(),
                'agent-1',
                { delegationScope: NARROWED },
            );

            expect(result).toEqual({ runId: 'run-1', dispatched: true, parked: false });
            expect(delegate.enqueue).toHaveBeenCalledTimes(1);
            expect(store.enqueue).not.toHaveBeenCalled();
            // The fleet guard never ran; the Trigger worker applies the scope
            // it reads off this row (agent-task-execute.task.ts).
            expect(runs.findById).not.toHaveBeenCalled();
            expect(rows.get('run-1')!.delegationScope).toEqual(NARROWED);
        });

        /**
         * What the delegating PARENT sees. `SubAgentDelegationRunnerService`
         * ignores `dispatch.error` once a run id exists and polls that run;
         * its first read happens before any sleep, so a child the fleet
         * refused comes back `failed` with the refusal as its summary at
         * once, rather than after the delegation budget runs out.
         */
        it('reports the refused child to the delegating parent on its first poll', async () => {
            const dispatcher = buildDispatcher();
            // A parent that has to sleep has NOT observed the failure on its
            // first poll. Rejecting (instead of resolving instantly) makes
            // that a fast, named failure rather than a hot poll loop that
            // runs until the 10-minute delegation budget is spent.
            const clock = {
                sleep: jest
                    .fn()
                    .mockRejectedValue(
                        new Error('the parent had to wait: the child was not failed on first poll'),
                    ),
            };
            const parentAgent = {
                id: 'agent-1',
                userId: USER,
                tenantId: null,
                organizationId: null,
            };
            const runner = new SubAgentDelegationRunnerService(
                {
                    findById: jest.fn().mockResolvedValue(parentAgent),
                    findByIdAndUser: jest.fn().mockResolvedValue(parentAgent),
                } as never,
                runs as never,
                {
                    create: jest.fn().mockResolvedValue(buildTask({ id: 'task-1' })),
                    getOne: jest.fn(),
                } as never,
                buildTransition(dispatcher),
                { listForAgent: jest.fn().mockResolvedValue([]) } as never,
                clock,
            );
            const request: SubAgentDelegationRequest = {
                delegationId: 'del-1',
                parentAgentId: 'agent-1',
                depth: 0,
                objective: 'Summarise the release notes',
                scope: { ...NARROWED, workId: null, organizationId: null },
            };

            const result = await runner.run(request);

            expect(result.status).toBe('failed');
            expect(result.childRunId).toBe('run-1');
            expect(result.summary).toContain(
                `dispatch-failed: ${FLEET_DELEGATION_SCOPE_UNENFORCEABLE}:`,
            );
            expect(result.summary).toContain('no fleet node can enforce a delegation scope');
            // Observed promptly: no poll interval was ever slept.
            expect(clock.sleep).not.toHaveBeenCalled();
            expect(store.enqueue).not.toHaveBeenCalled();
            expect(delegate.enqueue).not.toHaveBeenCalled();
        });

        /**
         * Reviewer agent stage (slice AD, EW-811) meets this rule.
         *
         * A review run is admitted under the review-only scope
         * (`agentReviewRunScope()`, i.e. `allowedTools ['submitTaskReview']`),
         * and that scope NARROWS. So on a Work whose runs route to the fleet,
         * the G9 guard refuses a review run FIRST, and slice AD's own
         * `refuseAgentReviewRun` is never asked. Nothing else exercised the
         * two together: AD's dispatcher specs use an admitting guard double,
         * and the cases above never carry a review ledger. These pin, through
         * the REAL dispatcher, planner, router, transition service and review
         * service (only the rows, the ledger and the job store are in memory),
         * that the combination still fails closed and adds up:
         *
         *   - the run row is failed with the G9 reason, and there is no job,
         *     no cloud run and no plan;
         *   - the review ledger row settles `failed` with the start of that
         *     reason as its `refusalCode`, and no approver row is written, so
         *     the approver stays pending and the done gate stays shut.
         *
         * Two variants pin the edges: an explicit guard that ADMITS the run,
         * where `refuseAgentReviewRun` becomes the refusal (the rule that
         * still matters if G9 is ever relaxed for nodes that can enforce a
         * scope, because a verdict cannot be recorded on a node); and a run
         * the dispatch gate parked, promoted later by the drain.
         */
        describe('an agent review run (slice AD) routed to the fleet', () => {
            const REVIEWER = 'reviewer-1';
            /**
             * `recordDispatchResult` stores the first 64 characters of the
             * dispatch error as the ledger's `refusalCode`. For a G9 refusal
             * of run `run-1` that is exactly this, whatever the wording
             * after it.
             */
            const G9_REFUSAL_CODE = `dispatch-failed: ${FLEET_DELEGATION_SCOPE_UNENFORCEABLE}: run run-1`;

            interface ReviewRow {
                id: string;
                state: string;
                runId: string | null;
                refusalCode: string | null;
            }

            let reviewRows: Map<string, ReviewRow>;
            let ledger: {
                bindRun: jest.Mock;
                stampRunId: jest.Mock;
                casSettle: jest.Mock;
                recordVerdict: jest.Mock;
            };
            /** Every read and write of `TaskApproverRepository`; none may be called. */
            let reviewApprovers: Record<string, jest.Mock>;
            let reviews: TaskAgentReviewService;

            beforeEach(() => {
                reviewRows = new Map([
                    ['rev-1', { id: 'rev-1', state: 'dispatched', runId: null, refusalCode: null }],
                ]);
                // Same compare-and-set semantics as `TaskAgentReviewRepository`.
                ledger = {
                    bindRun: jest.fn(async (id: string, runId: string) => {
                        const row = reviewRows.get(id);
                        if (
                            row &&
                            row.state === 'dispatched' &&
                            (row.runId === null || row.runId === runId)
                        ) {
                            row.runId = runId;
                            return;
                        }
                        throw new Error(`agent-review-binding-refused: review ${id}`);
                    }),
                    stampRunId: jest.fn(async (id: string, runId: string) => {
                        const row = reviewRows.get(id);
                        if (row) row.runId = runId;
                    }),
                    casSettle: jest.fn(
                        async (id: string, state: string, patch: { refusalCode?: string } = {}) => {
                            const row = reviewRows.get(id);
                            if (!row || row.state !== 'dispatched') return false;
                            row.state = state;
                            row.refusalCode = patch.refusalCode ?? null;
                            return true;
                        },
                    ),
                    // The ONLY ledger method that writes an approver row.
                    recordVerdict: jest.fn(),
                };
                reviewApprovers = {
                    findByTaskId: jest.fn().mockResolvedValue([]),
                    findByTaskIds: jest.fn().mockResolvedValue([]),
                    allApproved: jest.fn(),
                    add: jest.fn(),
                    setState: jest.fn(),
                    remove: jest.fn(),
                    removeForTask: jest.fn(),
                    resetAgentDecisionToPending: jest.fn(),
                    restoreAgentDecisionFromReview: jest.fn(),
                };
                // The REAL review service. It is also what the transition
                // service binds the run through, so `bindRun` resolves by
                // landing on the in-memory ledger row.
                reviews = new TaskAgentReviewService(
                    { findById: jest.fn() } as never,
                    ledger as never,
                    reviewApprovers as never,
                );
            });

            /** What `fanOutAgentReviews` hands `dispatchAgentRun` for one review. */
            const reviewDispatch = () => ({
                delegationScope: agentReviewRunScope(),
                reviewId: 'rev-1',
                seedPendingInput: ['brief'],
            });

            const expectNoApproverWrite = () => {
                expect(ledger.recordVerdict).not.toHaveBeenCalled();
                const touched = Object.entries(reviewApprovers)
                    .filter(([, fn]) => fn.mock.calls.length > 0)
                    .map(([name]) => name);
                expect(touched).toEqual([]);
            };

            it.each(['command', 'model-cli'])(
                'is refused by the G9 guard first in %s mode: the run fails, the review settles failed, no approver is written',
                async (mode) => {
                    process.env.FLEET_NODE_AGENT_EXECUTION_MODE = mode;
                    // Production wiring: no explicit guard, so the planner IS
                    // the guard (TasksModule wires exactly this).
                    const dispatcher = buildDispatcher();
                    const refuseAgentReviewRun = jest.spyOn(planner, 'refuseAgentReviewRun');

                    const result = await buildTransition(dispatcher, {
                        agentReviews: reviews,
                    }).dispatchAgentRun(buildTask(), REVIEWER, reviewDispatch());

                    expect(result.runId).toBe('run-1');
                    expect(result.dispatched).toBe(false);
                    expect(result.parked).toBe(false);
                    expect(
                        result.error!.startsWith(
                            `dispatch-failed: ${FLEET_DELEGATION_SCOPE_UNENFORCEABLE}:`,
                        ),
                    ).toBe(true);
                    // Bound and briefed before the enqueue, like any review run.
                    expect(ledger.bindRun).toHaveBeenCalledWith('rev-1', 'run-1');
                    const row = rows.get('run-1')!;
                    expect(row.pendingInput).toEqual(['brief']);
                    // Failed with the reason, where a human reads it.
                    expect(row.status).toBe('failed');
                    expect(row.errorMessage).toBe(result.error);
                    expect(row.errorMessage).toContain('allowedTools [submitTaskReview]');
                    expect(row.errorMessage).toContain('is an agent review run');
                    expect(row.errorMessage).toContain('review runs cannot run on the fleet');
                    // No job row, no cloud run, no planning, and AD's own
                    // refusal never asked: G9 got there first.
                    expect(store.enqueue).not.toHaveBeenCalled();
                    expect(delegate.enqueue).not.toHaveBeenCalled();
                    expect(plannerTasks.findById).not.toHaveBeenCalled();
                    expect(refuseAgentReviewRun).not.toHaveBeenCalled();

                    // What `fanOutAgentReviews` does next with that result.
                    await reviews.recordDispatchResult('rev-1', result);

                    expect(G9_REFUSAL_CODE).toHaveLength(64);
                    expect(result.error!.slice(0, 64)).toBe(G9_REFUSAL_CODE);
                    expect(ledger.casSettle).toHaveBeenCalledTimes(1);
                    expect(ledger.casSettle).toHaveBeenCalledWith('rev-1', 'failed', {
                        refusalCode: G9_REFUSAL_CODE,
                    });
                    expect(reviewRows.get('rev-1')).toEqual({
                        id: 'rev-1',
                        state: 'failed',
                        runId: 'run-1',
                        refusalCode: G9_REFUSAL_CODE,
                    });
                    expectNoApproverWrite();
                },
            );

            it.each(['command', 'model-cli'])(
                'is refused by refuseAgentReviewRun behind an explicit guard that admits it (%s mode), and still settles failed',
                async (mode) => {
                    process.env.FLEET_NODE_AGENT_EXECUTION_MODE = mode;
                    const delegationScopeGuard = {
                        refuseUnenforceableDelegationScope: jest.fn().mockResolvedValue(undefined),
                    };
                    const dispatcher = buildDispatcher({ delegationScopeGuard });
                    const refuseAgentReviewRun = jest.spyOn(planner, 'refuseAgentReviewRun');
                    const plannerGuard = jest.spyOn(planner, 'refuseUnenforceableDelegationScope');
                    const planSpy = jest.spyOn(planner, 'plan');

                    const result = await buildTransition(dispatcher, {
                        agentReviews: reviews,
                    }).dispatchAgentRun(buildTask(), REVIEWER, reviewDispatch());

                    // The explicit guard was asked and admitted; the planner
                    // was not asked as the guard.
                    expect(
                        delegationScopeGuard.refuseUnenforceableDelegationScope,
                    ).toHaveBeenCalledTimes(1);
                    expect(plannerGuard).not.toHaveBeenCalled();
                    // So AD's rule is the refusal, read off the run row.
                    expect(refuseAgentReviewRun).toHaveBeenCalledTimes(1);
                    expect(refuseAgentReviewRun).toHaveBeenCalledWith(
                        expect.objectContaining({ runId: 'run-1', agentId: REVIEWER }),
                    );
                    const refusal = await refuseAgentReviewRun.mock.results[0].value.then(
                        () => null,
                        (err: unknown) => err,
                    );
                    expect(refusal).toBeInstanceOf(FleetAgentTaskPlanError);
                    expect(refusal).not.toBeInstanceOf(FleetDelegationScopeRefusedError);
                    expect((refusal as Error).message).toContain(
                        'Run run-1 is an agent code-review run, and review runs cannot execute on the fleet',
                    );

                    expect(result).toMatchObject({
                        runId: 'run-1',
                        dispatched: false,
                        parked: false,
                    });
                    expect(result.error).toBe(`dispatch-failed: ${(refusal as Error).message}`);
                    expect(result.error).not.toContain('fleet-delegation-scope-');
                    expect(rows.get('run-1')).toMatchObject({
                        status: 'failed',
                        errorMessage: result.error,
                    });
                    expect(planSpy).not.toHaveBeenCalled();
                    expect(plannerTasks.findById).not.toHaveBeenCalled();
                    expect(store.enqueue).not.toHaveBeenCalled();
                    expect(delegate.enqueue).not.toHaveBeenCalled();

                    await reviews.recordDispatchResult('rev-1', result);

                    const refusalCode = result.error!.slice(0, 64);
                    expect(
                        refusalCode.startsWith(
                            'dispatch-failed: Run run-1 is an agent code-review run',
                        ),
                    ).toBe(true);
                    expect(ledger.casSettle).toHaveBeenCalledTimes(1);
                    expect(ledger.casSettle).toHaveBeenCalledWith('rev-1', 'failed', {
                        refusalCode,
                    });
                    expect(reviewRows.get('rev-1')).toMatchObject({
                        state: 'failed',
                        runId: 'run-1',
                        refusalCode,
                    });
                    expectNoApproverWrite();
                },
            );

            /**
             * CodeRabbit CR-1 (CWE-863), through the REAL dispatcher and
             * planner: behind an explicit guard that ADMITS the payload, a
             * run id whose row does not exist used to pass
             * `refuseAgentReviewRun` (only a found review row refused), so
             * a run whose scope nothing could verify reached `plan()` and
             * the job writer. It now stops at `refuseAgentReviewRun`, with
             * that rule's reason rather than a G9 code.
             */
            it.each(['command', 'model-cli'])(
                'refuses a run whose row is missing behind an explicit guard that admits it (%s mode): no plan, no job',
                async (mode) => {
                    process.env.FLEET_NODE_AGENT_EXECUTION_MODE = mode;
                    const delegationScopeGuard = {
                        refuseUnenforceableDelegationScope: jest.fn().mockResolvedValue(undefined),
                    };
                    const dispatcher = buildDispatcher({ delegationScopeGuard });
                    const planSpy = jest.spyOn(planner, 'plan');

                    const refusal = await dispatcher
                        .enqueue(payload({ runId: 'run-gone', agentId: REVIEWER }))
                        .then(
                            () => null,
                            (err: unknown) => err,
                        );

                    expect(
                        delegationScopeGuard.refuseUnenforceableDelegationScope,
                    ).toHaveBeenCalledTimes(1);
                    expect(runs.findById).toHaveBeenCalledWith('run-gone');
                    expect(refusal).toBeInstanceOf(FleetAgentTaskPlanError);
                    expect(refusal).not.toBeInstanceOf(FleetDelegationScopeRefusedError);
                    expect((refusal as Error).message).toContain('Run run-gone was not found');
                    expect((refusal as Error).message).not.toContain('fleet-delegation-scope-');
                    expect(planSpy).not.toHaveBeenCalled();
                    expect(plannerTasks.findById).not.toHaveBeenCalled();
                    expect(store.enqueue).not.toHaveBeenCalled();
                    expect(delegate.enqueue).not.toHaveBeenCalled();
                },
            );

            /**
             * CURRENT, DOCUMENTED BEHAVIOUR — pinned so a change to it is a
             * decision, not an accident.
             *
             * A review run the dispatch gate PARKS returns `parked: true`, so
             * `recordDispatchResult` rightly leaves its ledger row open. When
             * the drain promotes it later, G9 refuses it exactly as above, but
             * `RunDispatchGateService.drainForWork` marks only the RUN failed:
             * nothing on that path knows about the review ledger, so the review
             * row stays `dispatched`, bound to a dead run.
             *
             * Harmless, and not a regression:
             *   - no approver row is written, so the approver stays pending and
             *     the done gate stays shut;
             *   - the `(reviewer, head)` claim key stays taken, so that head is
             *     not reviewed again by a re-plan;
             *   - the budget slot was spent when the row was claimed ("a slot,
             *     once taken, is spent forever", `TaskAgentReview` entity), so
             *     settling the row would give nothing back;
             *   - the dead run cannot record a verdict, and the ledger already
             *     documents open rows whose run has died
             *     (`TaskAgentReviewRepository.findOpenForReviewer`);
             *   - the drain left the row open in exactly the same way before
             *     G9 existed, when `refuseAgentReviewRun` refused the promoted
             *     run; G9 only changed the reason on the run row.
             */
            it.each(['command', 'model-cli'])(
                'parked, then drained (%s mode): the run fails on the G9 refusal and the review row stays dispatched',
                async (mode) => {
                    process.env.FLEET_NODE_AGENT_EXECUTION_MODE = mode;
                    // The real gate and its default admission chain: a Work
                    // valve of 1 with one run in flight parks the review run.
                    process.env.AGENT_MAX_CONCURRENT_RUNS_PER_WORK = '1';
                    delete process.env.PLAN_CONCURRENCY_ENFORCEMENT;
                    let workInFlight = 1;
                    const dispatcher = buildDispatcher();
                    const refuseAgentReviewRun = jest.spyOn(planner, 'refuseAgentReviewRun');
                    const g9 = jest.spyOn(planner, 'refuseUnenforceableDelegationScope');
                    const gate = new RunDispatchGateService(
                        {
                            ...runs,
                            countInFlightForWork: jest.fn(async () => workInFlight),
                            countInFlightForOrganization: jest.fn().mockResolvedValue(0),
                            countInFlightForUser: jest.fn().mockResolvedValue(0),
                        } as never,
                        dispatcher,
                    );

                    const result = await buildTransition(dispatcher, {
                        agentReviews: reviews,
                        dispatchGate: gate,
                    }).dispatchAgentRun(
                        buildTask({ workId: 'work-1' }),
                        REVIEWER,
                        reviewDispatch(),
                    );

                    expect(result).toEqual({
                        runId: 'run-1',
                        dispatched: false,
                        parked: true,
                        queuedReason: QUEUED_REASON_CONCURRENCY,
                    });
                    await reviews.recordDispatchResult('rev-1', result);
                    // Parked is not a failure: the row stays open, bound and
                    // briefed, and nothing has asked the fleet anything yet.
                    expect(ledger.casSettle).not.toHaveBeenCalled();
                    expect(reviewRows.get('rev-1')).toMatchObject({
                        state: 'dispatched',
                        runId: 'run-1',
                    });
                    expect(rows.get('run-1')).toMatchObject({
                        status: 'queued',
                        queuedReason: QUEUED_REASON_CONCURRENCY,
                        pendingInput: ['brief'],
                    });
                    expect(g9).not.toHaveBeenCalled();

                    // A slot frees and the terminal-transition drain promotes it.
                    workInFlight = 0;
                    const drained = await gate.drainForWork('work-1');

                    expect(drained).toEqual({ dispatched: false, reason: 'dispatch-failed' });
                    expect(g9).toHaveBeenCalledTimes(1);
                    expect(g9).toHaveBeenCalledWith(
                        expect.objectContaining({
                            runId: 'run-1',
                            agentId: REVIEWER,
                            dedupKey: `task-1:${REVIEWER}:drain:run-1`,
                        }),
                    );
                    expect(refuseAgentReviewRun).not.toHaveBeenCalled();
                    const row = rows.get('run-1')!;
                    expect(row.status).toBe('failed');
                    expect(row.errorMessage!.slice(0, 64)).toBe(G9_REFUSAL_CODE);
                    expect(row.errorMessage).toContain('allowedTools [submitTaskReview]');
                    expect(row.errorMessage).toContain('is an agent review run');
                    expect(store.enqueue).not.toHaveBeenCalled();
                    expect(delegate.enqueue).not.toHaveBeenCalled();
                    expect(plannerTasks.findById).not.toHaveBeenCalled();

                    // The pinned part: the review row is NOT settled.
                    expect(ledger.casSettle).not.toHaveBeenCalled();
                    expect(reviewRows.get('rev-1')).toEqual({
                        id: 'rev-1',
                        state: 'dispatched',
                        runId: 'run-1',
                        refusalCode: null,
                    });
                    expectNoApproverWrite();
                },
            );
        });
    });
});
