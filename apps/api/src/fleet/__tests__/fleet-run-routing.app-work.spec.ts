import type { FleetExecutionPreferenceService, FleetJobService } from '@ever-works/agent/fleet';
import type { WorkRepository } from '@ever-works/agent/database';
import type { AgentTaskExecuteDispatchPayload } from '@ever-works/agent/tasks-domain';
import { NodeDispatcherFactory, NodeJobRuntimePlugin } from '@ever-works/job-runtime-node-plugin';
import { QUEUED_REASON_WAITING_FOR_RUNNER } from '@ever-works/contracts';
import { FleetRunRouterService } from '../fleet-run-router.service';
import type { FleetRunnerStatusService } from '../fleet-runner-status.service';

/**
 * 2026-10-18 (prod, T-45): an App Work's change Task routed `local-fallback` with its pinned
 * node unable to lease (daemon below the minimum version) fell back to a CLOUD run. For App
 * Works cloud push is off (FR-12), so that run could publish nothing and parked asking a human.
 * The router now holds such a run for the fleet instead; an explicit `cloud` choice still wins.
 */

const WORK_ID = '44444444-4444-4444-8444-444444444444';

function payload(): AgentTaskExecuteDispatchPayload {
    return {
        agentId: 'agent-1',
        userId: 'user-1',
        taskId: 'task-1',
        dedupKey: 'task-1:agent-1:1',
        runId: 'run-1',
        tenantId: null,
        organizationId: null,
    };
}

describe('fleet routing — App Work cloud-fallback guard', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv, EVER_WORKS_JOB_RUNTIME: 'node' };
        delete process.env.FLEET_NODE_RUNTIME_ENABLED;
        delete process.env.APP_WORKS_CLOUD_PUSH_ENABLED;
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    function router(mode: string, kind: string | null, free = 0) {
        const store = { enqueue: jest.fn(), findById: jest.fn(async () => null) };
        const factory = new NodeDispatcherFactory({ store });
        const plugin = new NodeJobRuntimePlugin().useDispatcherFactory(factory);
        const works = {
            findById: jest.fn(async () => (kind === null ? null : { id: WORK_ID, kind })),
        };
        return new FleetRunRouterService(
            factory,
            plugin,
            undefined,
            {
                resolveForUser: jest.fn(async () => mode),
            } as unknown as FleetExecutionPreferenceService,
            {
                availability: jest.fn(async () => ({ total: 1, online: 1, free })),
            } as unknown as FleetRunnerStatusService,
            { resolveAgentTaskTarget: jest.fn(async () => 'node-1') } as unknown as FleetJobService,
            undefined,
            works as unknown as WorkRepository,
        );
    }

    it('holds an App Work run for the fleet instead of falling back to the cloud', async () => {
        const decision = await router('local-fallback', 'app').routeAgentTask(payload(), {
            workId: WORK_ID,
        });

        expect(decision).toEqual({
            target: 'fleet-waiting',
            mode: 'local-fallback',
            queuedReason: QUEUED_REASON_WAITING_FOR_RUNNER,
        });
    });

    it('still falls back to the cloud for a non-App Work', async () => {
        const decision = await router('local-fallback', 'repo').routeAgentTask(payload(), {
            workId: WORK_ID,
        });

        expect(decision.target).toBe('cloud');
    });

    it('honours an explicit cloud preference even for an App Work', async () => {
        const decision = await router('cloud', 'app').routeAgentTask(payload(), {
            workId: WORK_ID,
        });

        expect(decision).toEqual({ target: 'cloud', mode: 'cloud' });
    });

    it('leaves a run with a free runner on the fleet', async () => {
        const decision = await router('local-fallback', 'app', 1).routeAgentTask(payload(), {
            workId: WORK_ID,
        });

        expect(decision.target).toBe('fleet');
    });

    it('keeps the old routing when the Work cannot be read', async () => {
        const decision = await router('local-fallback', null).routeAgentTask(payload(), {
            workId: WORK_ID,
        });

        expect(decision.target).toBe('cloud');
    });
});
