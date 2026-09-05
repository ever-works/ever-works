import type {
    AgentTaskExecuteDispatcher,
    AgentTaskExecuteDispatchPayload,
} from '@ever-works/agent/tasks-domain';
import type { FleetExecutionPreferenceService, FleetJobService } from '@ever-works/agent/fleet';
import { NodeDispatcherFactory, NodeJobRuntimePlugin } from '@ever-works/job-runtime-node-plugin';
import { QUEUED_REASON_WAITING_FOR_RUNNER } from '@ever-works/contracts';
import type { FleetRunnerAvailability } from '@ever-works/contracts';
import { createFleetAwareAgentTaskExecuteDispatcher } from '../fleet-agent-task.dispatcher';
import { FleetRunRouterService } from '../fleet-run-router.service';
import type { FleetRunnerStatusService } from '../fleet-runner-status.service';

/**
 * The local-runner routing matrix, end to end through the seam the
 * platform actually dispatches on.
 *
 * The pure rule is unit-tested in `@ever-works/contracts`
 * (`decideFleetRouting`). What this suite proves is the WIRING around it,
 * which is where the value is:
 *
 *   - `local-wait` with no free runner still ENQUEUES onto the fleet and
 *     carries `waiting-for-runner` all the way into the job row — a
 *     queued reason that stops at the router is a field nobody ever sees;
 *   - `local-fallback` with no free runner reaches the platform
 *     dispatcher AND emits the inbox notice;
 *   - a tenant that was never on the fleet stays silent, because nothing
 *     was taken away from it;
 *   - a notification outage cannot turn a successful fallback into a
 *     failed dispatch;
 *   - (self-build slice S / EW-775) the availability question is asked
 *     about the runners that could take THIS job — the Agent's pinned
 *     node and the tags the job will require — so a pin to an offline PC
 *     with five idle siblings is a fallback (or a visible wait), never a
 *     silent forever-queue.
 */

const WORK_ID = '44444444-4444-4444-8444-444444444444';

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

describe('fleet run routing (local-runner preference matrix)', () => {
    const originalEnv = process.env;

    let store: { enqueue: jest.Mock; findById: jest.Mock };
    let delegate: AgentTaskExecuteDispatcher & { enqueue: jest.Mock };
    let preferences: { resolveForUser: jest.Mock };
    let runners: { availability: jest.Mock };
    let notifications: { notifyFleetRunnerFallback: jest.Mock };
    let scopeResolver: { resolve: jest.Mock };
    let jobs: { resolveAgentTaskTarget: jest.Mock };
    let planner: { plan: jest.Mock; requirements?: jest.Mock } | undefined;

    const buildDispatcher = (): AgentTaskExecuteDispatcher => {
        const factory = new NodeDispatcherFactory({ store });
        const plugin = new NodeJobRuntimePlugin().useDispatcherFactory(factory);
        const router = new FleetRunRouterService(
            factory,
            plugin,
            undefined,
            preferences as unknown as FleetExecutionPreferenceService,
            runners as unknown as FleetRunnerStatusService,
            jobs as unknown as FleetJobService,
        );
        return createFleetAwareAgentTaskExecuteDispatcher(delegate, router, {
            scopeResolver,
            notifications,
            ...(planner ? { planner } : {}),
        });
    };

    const availability = (
        over: Partial<FleetRunnerAvailability> = {},
    ): FleetRunnerAvailability => ({
        total: 1,
        online: 1,
        free: 1,
        ...over,
    });

    beforeEach(() => {
        process.env = { ...originalEnv };
        // The fleet must be the resolved runtime for ANY of this to run;
        // the preference layers on top, it never turns the fleet on.
        process.env.EVER_WORKS_JOB_RUNTIME = 'node';
        delete process.env.FLEET_NODE_RUNTIME_ENABLED;
        delete process.env.FLEET_NODE_AGENT_TASK_COMMAND;
        delete process.env.FLEET_NODE_REQUIRED_CAPABILITIES;

        jobs = { resolveAgentTaskTarget: jest.fn(async () => null) };
        planner = undefined;
        store = {
            enqueue: jest.fn(async () => ({ id: 'fleet-job-1' })),
            findById: jest.fn(async () => null),
        };
        delegate = { enqueue: jest.fn(async () => ({ runId: 'trigger-run-1' })) };
        preferences = { resolveForUser: jest.fn(async () => 'local-fallback') };
        runners = { availability: jest.fn(async () => availability()) };
        notifications = { notifyFleetRunnerFallback: jest.fn(async () => undefined) };
        scopeResolver = { resolve: jest.fn(async () => ({ workId: WORK_ID, goalId: null })) };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('resolves the preference against the Task’s Work / Goal scope', async () => {
        await buildDispatcher().enqueue(payload());

        expect(scopeResolver.resolve).toHaveBeenCalledWith('task-1');
        expect(preferences.resolveForUser).toHaveBeenCalledWith('user-1', {
            workId: WORK_ID,
            goalId: null,
        });
    });

    it.each(['local-wait', 'local-fallback'] as const)(
        'enqueues %s onto the fleet with no queued reason when a runner is free',
        async (mode) => {
            preferences.resolveForUser.mockResolvedValue(mode);

            const result = await buildDispatcher().enqueue(payload());

            expect(result).toEqual({ runId: 'fleet-job-1' });
            expect(delegate.enqueue).not.toHaveBeenCalled();
            expect(store.enqueue.mock.calls[0][0].queuedReason).toBeUndefined();
            expect(notifications.notifyFleetRunnerFallback).not.toHaveBeenCalled();
        },
    );

    describe('local-wait', () => {
        beforeEach(() => {
            preferences.resolveForUser.mockResolvedValue('local-wait');
        });

        it.each([
            ['every runner busy', availability({ free: 0 })],
            ['every runner offline', availability({ online: 0, free: 0 })],
            ['no runner enrolled', availability({ total: 0, online: 0, free: 0 })],
        ])('WAITS on the fleet when %s', async (_label, current) => {
            runners.availability.mockResolvedValue(current);

            const result = await buildDispatcher().enqueue(payload());

            // Still the fleet — the fleet queue IS the wait.
            expect(result).toEqual({ runId: 'fleet-job-1' });
            expect(delegate.enqueue).not.toHaveBeenCalled();
            // And the reason reaches the ROW, not just the router: this
            // is the assertion that catches a field wired at one end.
            expect(store.enqueue.mock.calls[0][0].queuedReason).toBe(
                QUEUED_REASON_WAITING_FOR_RUNNER,
            );
            // Never notifies: nothing was relocated.
            expect(notifications.notifyFleetRunnerFallback).not.toHaveBeenCalled();
        });
    });

    describe('local-fallback', () => {
        beforeEach(() => {
            preferences.resolveForUser.mockResolvedValue('local-fallback');
            runners.availability.mockResolvedValue(availability({ free: 0 }));
        });

        it('runs in the cloud and emits the fallback notice naming the reason', async () => {
            const result = await buildDispatcher().enqueue(payload());

            expect(result).toEqual({ runId: 'trigger-run-1' });
            expect(store.enqueue).not.toHaveBeenCalled();
            expect(notifications.notifyFleetRunnerFallback).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'user-1',
                    taskId: 'task-1',
                    reason: 'runners-busy',
                }),
            );
        });

        it('reports the OWNER’S REAL runner count in the notice', async () => {
            // REGRESSION: the count used to be derived from the reason
            // ("not no-runners, so say 1"), which stored a fabricated
            // figure on a durable notification row for every owner with
            // more than one machine.
            runners.availability.mockResolvedValue(availability({ total: 4, online: 4, free: 0 }));

            await buildDispatcher().enqueue(payload());

            expect(notifications.notifyFleetRunnerFallback).toHaveBeenCalledWith(
                expect.objectContaining({ reason: 'runners-busy', runnerCount: 4 }),
            );
        });

        it('distinguishes "no runners enrolled" from "runners busy"', async () => {
            runners.availability.mockResolvedValue(availability({ total: 0, online: 0, free: 0 }));

            await buildDispatcher().enqueue(payload());

            expect(notifications.notifyFleetRunnerFallback).toHaveBeenCalledWith(
                expect.objectContaining({ reason: 'no-runners', runnerCount: 0 }),
            );
        });

        it('still dispatches when the notification itself fails', async () => {
            notifications.notifyFleetRunnerFallback.mockRejectedValue(new Error('inbox down'));

            const result = await buildDispatcher().enqueue(payload());

            // The run is what matters; a notification outage must never
            // turn a successful fallback into a failed dispatch.
            expect(result).toEqual({ runId: 'trigger-run-1' });
            expect(delegate.enqueue).toHaveBeenCalledTimes(1);
        });
    });

    describe('cloud', () => {
        it('uses the platform dispatcher and stays SILENT', async () => {
            preferences.resolveForUser.mockResolvedValue('cloud');

            const result = await buildDispatcher().enqueue(payload());

            expect(result).toEqual({ runId: 'trigger-run-1' });
            expect(store.enqueue).not.toHaveBeenCalled();
            // An explicit opt-out is not a fallback — the owner chose it.
            expect(notifications.notifyFleetRunnerFallback).not.toHaveBeenCalled();
        });
    });

    describe('precedence and degradation', () => {
        it('never notifies for a tenant that was never on the fleet', async () => {
            process.env.EVER_WORKS_JOB_RUNTIME = 'trigger';
            preferences.resolveForUser.mockResolvedValue('local-fallback');

            await buildDispatcher().enqueue(payload());

            expect(delegate.enqueue).toHaveBeenCalledTimes(1);
            expect(notifications.notifyFleetRunnerFallback).not.toHaveBeenCalled();
            // The preference is not even consulted — the runtime gate is
            // settled first, and no preference outranks it.
            expect(preferences.resolveForUser).not.toHaveBeenCalled();
        });

        it('lets the FLEET_NODE_RUNTIME_ENABLED kill switch beat a local preference', async () => {
            process.env.FLEET_NODE_RUNTIME_ENABLED = 'false';
            preferences.resolveForUser.mockResolvedValue('local-wait');

            await buildDispatcher().enqueue(payload());

            expect(store.enqueue).not.toHaveBeenCalled();
            expect(delegate.enqueue).toHaveBeenCalledTimes(1);
        });

        it('dispatches to the fleet when the preference lookup throws', async () => {
            preferences.resolveForUser.mockRejectedValue(new Error('db down'));

            const result = await buildDispatcher().enqueue(payload());

            // Degrades to the pre-preference behaviour rather than
            // costing the user a run.
            expect(result).toEqual({ runId: 'fleet-job-1' });
        });

        it('falls back to the account-wide scope when the Task lookup throws', async () => {
            scopeResolver.resolve.mockRejectedValue(new Error('task table down'));

            await buildDispatcher().enqueue(payload());

            expect(preferences.resolveForUser).toHaveBeenCalledWith('user-1', {});
        });
    });

    describe('eligibility — the job is judged against the runners that could take it (slice S)', () => {
        const NODE_B = '22222222-2222-4222-8222-222222222222';
        const pinnedOffline = (): FleetRunnerAvailability => ({
            total: 1,
            online: 0,
            free: 0,
            fleetTotal: 6,
            pinnedNodeId: NODE_B,
        });

        it('asks the affinity question BEFORE the job exists and counts against the pinned node', async () => {
            jobs.resolveAgentTaskTarget.mockResolvedValue(NODE_B);

            await buildDispatcher().enqueue(payload());

            // The SAME question the enqueue path asks, so the two agree.
            expect(jobs.resolveAgentTaskTarget).toHaveBeenCalledWith('user-1', 'agent-1');
            expect(runners.availability).toHaveBeenCalledWith('user-1', {
                targetNodeId: NODE_B,
                requiredCapabilities: [],
            });
        });

        it('REGRESSION (R5): an Agent pinned to an offline PC with five idle siblings falls back to the cloud, naming the pinned runner', async () => {
            // Before: the router judged the WHOLE fleet — five idle siblings
            // made `free > 0`, the decision was `fleet`, the enqueue pinned
            // the row to the offline node, and the job sat queued forever
            // with `queuedReason` null and no notice.
            jobs.resolveAgentTaskTarget.mockResolvedValue(NODE_B);
            preferences.resolveForUser.mockResolvedValue('local-fallback');
            runners.availability.mockResolvedValue(pinnedOffline());

            const result = await buildDispatcher().enqueue(payload());

            expect(result).toEqual({ runId: 'trigger-run-1' });
            expect(store.enqueue).not.toHaveBeenCalled();
            expect(notifications.notifyFleetRunnerFallback).toHaveBeenCalledWith({
                userId: 'user-1',
                taskId: 'task-1',
                reason: 'pinned-runner-offline',
                // Precise: ONE eligible runner (the pinned one), of six.
                runnerCount: 1,
                fleetRunnerCount: 6,
                pinnedNodeId: NODE_B,
            });
        });

        it('REGRESSION (R5): the same pin under local-wait WAITS with the reason on the row', async () => {
            jobs.resolveAgentTaskTarget.mockResolvedValue(NODE_B);
            preferences.resolveForUser.mockResolvedValue('local-wait');
            runners.availability.mockResolvedValue(pinnedOffline());

            const result = await buildDispatcher().enqueue(payload());

            // Still the fleet — the fleet queue IS the wait — but VISIBLY,
            // and the queue SLA bounds it from here.
            expect(result).toEqual({ runId: 'fleet-job-1' });
            expect(store.enqueue.mock.calls[0][0].queuedReason).toBe(
                QUEUED_REASON_WAITING_FOR_RUNNER,
            );
            expect(notifications.notifyFleetRunnerFallback).not.toHaveBeenCalled();
        });

        it('reports no-eligible-runners with the precise counts when nothing advertises the required tags', async () => {
            runners.availability.mockResolvedValue({
                total: 0,
                online: 0,
                free: 0,
                fleetTotal: 3,
                pinnedNodeId: null,
            });

            await buildDispatcher().enqueue(payload());

            expect(delegate.enqueue).toHaveBeenCalledTimes(1);
            expect(notifications.notifyFleetRunnerFallback).toHaveBeenCalledWith(
                expect.objectContaining({
                    reason: 'no-eligible-runners',
                    runnerCount: 0,
                    fleetRunnerCount: 3,
                }),
            );
            expect(notifications.notifyFleetRunnerFallback.mock.calls[0][0]).not.toHaveProperty(
                'pinnedNodeId',
            );
        });

        it('feeds the planner-resolved tags to the availability check, and the config tags without a planner', async () => {
            process.env.FLEET_NODE_REQUIRED_CAPABILITIES = 'workspace';
            planner = {
                plan: jest.fn(async () => null),
                requirements: jest.fn(async () => ({
                    requiredCapabilities: ['workspace', 'claude-code'],
                })),
            };

            await buildDispatcher().enqueue(payload());

            expect(planner.requirements).toHaveBeenCalledWith(
                expect.objectContaining({ taskId: 'task-1', userId: 'user-1' }),
            );
            expect(runners.availability).toHaveBeenCalledWith('user-1', {
                targetNodeId: null,
                requiredCapabilities: ['workspace', 'claude-code'],
            });
            // The plan is still built AFTER the decision, only for a fleet run.
            expect(planner.plan).toHaveBeenCalledTimes(1);

            runners.availability.mockClear();
            planner = undefined;
            await buildDispatcher().enqueue(payload());
            expect(runners.availability).toHaveBeenCalledWith('user-1', {
                targetNodeId: null,
                requiredCapabilities: ['workspace'],
            });
        });

        it('never plans, and never asks the affinity question, for a tenant not on the fleet', async () => {
            process.env.EVER_WORKS_JOB_RUNTIME = 'trigger';
            planner = {
                plan: jest.fn(async () => null),
                requirements: jest.fn(async () => ({ requiredCapabilities: [] })),
            };

            await buildDispatcher().enqueue(payload());

            // The requirements lookup is settings-only and cheap, but a
            // tenant not on the fleet must still never plan anything.
            expect(planner.plan).not.toHaveBeenCalled();
            expect(jobs.resolveAgentTaskTarget).not.toHaveBeenCalled();
            expect(delegate.enqueue).toHaveBeenCalledTimes(1);
        });

        it('degrades to the config tags when the requirements lookup throws, and still dispatches', async () => {
            process.env.FLEET_NODE_REQUIRED_CAPABILITIES = 'workspace';
            planner = {
                plan: jest.fn(async () => null),
                requirements: jest.fn(async () => {
                    throw new Error('settings down');
                }),
            };

            const result = await buildDispatcher().enqueue(payload());

            expect(result).toEqual({ runId: 'fleet-job-1' });
            expect(runners.availability).toHaveBeenCalledWith('user-1', {
                targetNodeId: null,
                requiredCapabilities: ['workspace'],
            });
        });

        it('judges an affinity lookup that throws as unpinned, and still dispatches', async () => {
            jobs.resolveAgentTaskTarget.mockRejectedValue(new Error('affinity table down'));

            const result = await buildDispatcher().enqueue(payload());

            expect(result).toEqual({ runId: 'fleet-job-1' });
            expect(runners.availability).toHaveBeenCalledWith(
                'user-1',
                expect.objectContaining({ targetNodeId: null }),
            );
        });

        it('stamps the SAME tag set on the row that the decision was counted against', async () => {
            process.env.FLEET_NODE_REQUIRED_CAPABILITIES = 'workspace';

            await buildDispatcher().enqueue(payload());

            const counted = runners.availability.mock.calls[0][1].requiredCapabilities;
            expect(store.enqueue.mock.calls[0][0].requiredCapabilities).toEqual(counted);
            expect(counted).toEqual(['workspace']);
        });
    });
});
