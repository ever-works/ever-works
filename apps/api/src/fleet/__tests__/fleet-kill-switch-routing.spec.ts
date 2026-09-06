import type {
    AgentTaskExecuteDispatcher,
    AgentTaskExecuteDispatchPayload,
} from '@ever-works/agent/tasks-domain';
import { FleetKillSwitchService } from '@ever-works/agent/fleet';
import { NodeDispatcherFactory, NodeJobRuntimePlugin } from '@ever-works/job-runtime-node-plugin';
import { createFleetAwareAgentTaskExecuteDispatcher } from '../fleet-agent-task.dispatcher';
import { FleetKillSwitchActiveError } from '../fleet-kill-switch.error';
import { FleetRunRouterService } from '../fleet-run-router.service';

/**
 * Panic controls (EW-778) — the GLOBAL STOP FLAG on the routing seam.
 *
 * The routing wrapper has a documented fallback: a routing decision that
 * THROWS is sent to the platform (cloud) dispatcher. That is exactly
 * what a stop must never become. So the load-bearing assertions here
 * are the negative ones — `delegate.enqueue` and the fleet store are
 * NEVER called while the flag is set, whether the flag was read by the
 * wrapper, by the router, or could not be read at all.
 *
 * The end-to-end half (through `TaskTransitionService.dispatchAgentRun`,
 * the run row ends `dispatch-failed`) lives in
 * `fleet-kill-switch-transition.spec.ts`, which loads the tasks domain.
 */

function payload(
    overrides: Partial<AgentTaskExecuteDispatchPayload> = {},
): AgentTaskExecuteDispatchPayload {
    return {
        agentId: 'agent-1',
        userId: 'user-1',
        taskId: 'task-1',
        dedupKey: 'task-1:agent-1:1',
        runId: 'run-1',
        tenantId: null,
        organizationId: null,
        ...overrides,
    };
}

describe('fleet routing under the global stop flag (EW-778)', () => {
    const originalEnv = process.env;

    let store: { enqueue: jest.Mock; findById: jest.Mock };
    let delegate: AgentTaskExecuteDispatcher & { enqueue: jest.Mock };
    let killSwitch: { isStopped: jest.Mock };

    const buildRouter = (routerSwitch?: unknown): FleetRunRouterService => {
        const factory = new NodeDispatcherFactory({ store });
        const plugin = new NodeJobRuntimePlugin().useDispatcherFactory(factory);
        // The switch is the SEVENTH positional argument (appended LAST, after slice S's `jobs`).
        return new FleetRunRouterService(
            factory,
            plugin,
            undefined,
            undefined,
            undefined,
            undefined,
            routerSwitch as never,
        );
    };

    /** The real kill-switch service over a repository that cannot read the row. */
    const unreadableSwitch = (): FleetKillSwitchService => {
        const service = new FleetKillSwitchService(
            { read: jest.fn(async () => Promise.reject(new Error('db down'))) } as never,
            { record: jest.fn() } as never,
        );
        jest.spyOn(
            (service as never as { logger: { error: () => void } }).logger,
            'error',
        ).mockImplementation(() => undefined);
        return service;
    };

    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.EVER_WORKS_JOB_RUNTIME;
        delete process.env.FLEET_NODE_RUNTIME_ENABLED;
        delete process.env.FLEET_NODE_AGENT_TASK_COMMAND;
        store = {
            enqueue: jest.fn(async () => ({
                id: 'fleet-job-1',
                kind: 'agent-task',
                status: 'queued',
                nodeId: null,
                requiredCapabilities: [],
                payload: null,
                leaseExpiresAt: null,
                attempts: 0,
                maxAttempts: 3,
                createdAt: null,
                startedAt: null,
                completedAt: null,
            })),
            findById: jest.fn(async () => null),
        };
        delegate = { enqueue: jest.fn(async () => ({ runId: 'trigger-run-1' })) };
        killSwitch = { isStopped: jest.fn(async () => false) };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    /**
     * The dispatch gate (packages/agent) cannot import this error class;
     * it recognises a dispatcher that refused on the stop flag by
     * `Error.name` (`KILL_SWITCH_ACTIVE_ERROR_NAME` in
     * `packages/agent/src/agents/run-kill-switch.ts`) and RE-PARKS the run
     * instead of failing it. The literal is pinned on BOTH sides — here and
     * in `run-dispatch-gate.kill-switch.spec.ts` — rather than imported
     * across the agents barrel, which drags the facades chain into this
     * deliberately light suite.
     */
    describe('FleetKillSwitchActiveError', () => {
        it('carries the Error.name the dispatch gate re-parks on', () => {
            const error = new FleetKillSwitchActiveError('task-1');
            expect(error.name).toBe('FleetKillSwitchActiveError');
            expect(error).toBeInstanceOf(Error);
            expect(error.taskId).toBe('task-1');
        });
    });

    describe('FleetRunRouterService', () => {
        it('routes as before while the flag is clear', async () => {
            process.env.EVER_WORKS_JOB_RUNTIME = 'node';
            const decision = await buildRouter(killSwitch).routeAgentTask(payload());
            expect(decision.target).toBe('fleet');
        });

        it('refuses to route with the typed error while the flag is set — even a cloud-bound tenant', async () => {
            killSwitch.isStopped.mockResolvedValue(true);
            // No fleet runtime selected: the ordinary answer would be `cloud`.
            await expect(buildRouter(killSwitch).routeAgentTask(payload())).rejects.toBeInstanceOf(
                FleetKillSwitchActiveError,
            );
        });

        it('refuses to enqueue directly while the flag is set', async () => {
            process.env.EVER_WORKS_JOB_RUNTIME = 'node';
            killSwitch.isStopped.mockResolvedValue(true);
            await expect(
                buildRouter(killSwitch).enqueueAgentTask(payload()),
            ).rejects.toBeInstanceOf(FleetKillSwitchActiveError);
            expect(store.enqueue).not.toHaveBeenCalled();
        });

        it('refuses (fail-closed) when the flag CANNOT be read', async () => {
            process.env.EVER_WORKS_JOB_RUNTIME = 'node';
            await expect(
                buildRouter(unreadableSwitch()).routeAgentTask(payload()),
            ).rejects.toBeInstanceOf(FleetKillSwitchActiveError);
        });

        it('refuses (fail-closed) when the switch itself throws', async () => {
            process.env.EVER_WORKS_JOB_RUNTIME = 'node';
            killSwitch.isStopped.mockRejectedValue(new Error('boom'));
            await expect(buildRouter(killSwitch).routeAgentTask(payload())).rejects.toBeInstanceOf(
                FleetKillSwitchActiveError,
            );
        });

        it('routes as before with no switch bound (positional-arity compatibility)', async () => {
            process.env.EVER_WORKS_JOB_RUNTIME = 'node';
            const decision = await buildRouter(undefined).routeAgentTask(payload());
            expect(decision.target).toBe('fleet');
        });
    });

    describe('fleet-aware dispatcher (the cloud-fallback seam)', () => {
        /**
         * THE load-bearing test. The wrapper's routing catch sends a
         * throwing decision to the cloud. Revert-check: remove either the
         * pre-routing check or the `isFleetKillSwitchActiveError` rethrow
         * and one of these goes RED.
         */
        it('never falls back to the platform dispatcher while the flag is set (read by the wrapper)', async () => {
            killSwitch.isStopped.mockResolvedValue(true);
            const dispatcher = createFleetAwareAgentTaskExecuteDispatcher(
                delegate,
                buildRouter(undefined),
                { killSwitch },
            );
            await expect(dispatcher.enqueue(payload())).rejects.toBeInstanceOf(
                FleetKillSwitchActiveError,
            );
            expect(delegate.enqueue).not.toHaveBeenCalled();
            expect(store.enqueue).not.toHaveBeenCalled();
        });

        it('never falls back to the platform dispatcher while the flag is set (read by the router)', async () => {
            killSwitch.isStopped.mockResolvedValue(true);
            const dispatcher = createFleetAwareAgentTaskExecuteDispatcher(
                delegate,
                buildRouter(killSwitch),
                {},
            );
            await expect(dispatcher.enqueue(payload())).rejects.toBeInstanceOf(
                FleetKillSwitchActiveError,
            );
            expect(delegate.enqueue).not.toHaveBeenCalled();
            expect(store.enqueue).not.toHaveBeenCalled();
        });

        it('refuses (fail-closed) when the flag cannot be read, and still never falls back', async () => {
            const unreadable = unreadableSwitch();
            const dispatcher = createFleetAwareAgentTaskExecuteDispatcher(
                delegate,
                buildRouter(unreadable),
                { killSwitch: unreadable },
            );
            await expect(dispatcher.enqueue(payload())).rejects.toBeInstanceOf(
                FleetKillSwitchActiveError,
            );
            expect(delegate.enqueue).not.toHaveBeenCalled();
        });

        it('refuses (fail-closed) when the wrapper-side switch throws', async () => {
            killSwitch.isStopped.mockRejectedValue(new Error('boom'));
            const dispatcher = createFleetAwareAgentTaskExecuteDispatcher(
                delegate,
                buildRouter(undefined),
                { killSwitch },
            );
            await expect(dispatcher.enqueue(payload())).rejects.toBeInstanceOf(
                FleetKillSwitchActiveError,
            );
            expect(delegate.enqueue).not.toHaveBeenCalled();
        });

        it('dispatches to the cloud as before while the flag is clear', async () => {
            const dispatcher = createFleetAwareAgentTaskExecuteDispatcher(
                delegate,
                buildRouter(killSwitch),
                { killSwitch },
            );
            await expect(dispatcher.enqueue(payload())).resolves.toEqual({
                runId: 'trigger-run-1',
            });
            expect(delegate.enqueue).toHaveBeenCalledTimes(1);
        });

        it('still treats an ORDINARY routing failure as a cloud fallback', async () => {
            const overlay = { findOne: jest.fn().mockRejectedValue(new Error('db down')) };
            const factory = new NodeDispatcherFactory({ store });
            const plugin = new NodeJobRuntimePlugin().useDispatcherFactory(factory);
            const router = new FleetRunRouterService(
                factory,
                plugin,
                overlay as never,
                undefined,
                undefined,
                undefined,
                killSwitch as never,
            );
            const dispatcher = createFleetAwareAgentTaskExecuteDispatcher(delegate, router, {
                killSwitch,
            });
            await dispatcher.enqueue(payload({ tenantId: 'tenant-1' }));
            expect(delegate.enqueue).toHaveBeenCalledTimes(1);
        });
    });
});
