import type { AgentTaskExecuteDispatchPayload } from '@ever-works/agent/tasks-domain';
import { createFleetAwareAgentTaskExecuteDispatcher } from '../fleet-agent-task.dispatcher';
import { FleetKillSwitchActiveError } from '../fleet-kill-switch.error';

/**
 * APW-08 T12 (APW08-G11) — `previewPlacement`: the placement the fleet-aware dispatcher's
 * `enqueue` WOULD choose, from the SAME `routeAgentTask` call with the same scope and
 * requirements, writing nothing. It is what `dispatchAgentRun` hands the isolated-run admission
 * for a Task on an App Work.
 */

const payload: AgentTaskExecuteDispatchPayload = {
    agentId: 'agent-1',
    userId: 'user-1',
    taskId: 'task-1',
    dedupKey: 'task-1:agent-1:1',
    tenantId: 'tenant-1',
    organizationId: null,
};

describe('fleet-aware dispatcher — previewPlacement (APW-08 T12)', () => {
    let router: { routeAgentTask: jest.Mock; enqueueAgentTask: jest.Mock };
    let delegate: { enqueue: jest.Mock };
    let notifications: { notifyFleetRunnerFallback: jest.Mock };
    let runs: { recordDispatchRunner: jest.Mock };
    let scopeResolver: { resolve: jest.Mock };
    let planner: { plan: jest.Mock; requirements: jest.Mock };
    let killSwitch: { isStopped: jest.Mock } | undefined;

    const build = () =>
        createFleetAwareAgentTaskExecuteDispatcher(delegate, router as never, {
            scopeResolver,
            notifications: notifications as never,
            planner: planner as never,
            runs: runs as never,
            ...(killSwitch ? { killSwitch: killSwitch as never } : {}),
        });

    beforeEach(() => {
        router = {
            routeAgentTask: jest.fn().mockResolvedValue({ target: 'fleet', mode: 'local-wait' }),
            enqueueAgentTask: jest.fn(),
        };
        delegate = { enqueue: jest.fn() };
        notifications = { notifyFleetRunnerFallback: jest.fn() };
        runs = { recordDispatchRunner: jest.fn() };
        scopeResolver = { resolve: jest.fn().mockResolvedValue({ workId: 'work-1' }) };
        planner = {
            plan: jest.fn(),
            requirements: jest
                .fn()
                .mockResolvedValue({ requiredCapabilities: ['git-push', 'claude-code'] }),
        };
        killSwitch = undefined;
    });

    const expectNoSideEffects = () => {
        expect(router.enqueueAgentTask).not.toHaveBeenCalled();
        expect(delegate.enqueue).not.toHaveBeenCalled();
        expect(planner.plan).not.toHaveBeenCalled();
        expect(notifications.notifyFleetRunnerFallback).not.toHaveBeenCalled();
        expect(runs.recordDispatchRunner).not.toHaveBeenCalled();
    };

    it("answers 'fleet' with the job's required tags, through the same routing call enqueue makes", async () => {
        const preview = await build().previewPlacement!(payload);

        expect(preview).toEqual({
            placement: 'fleet',
            requiredCapabilities: ['git-push', 'claude-code'],
        });
        expect(router.routeAgentTask).toHaveBeenCalledWith(
            payload,
            { workId: 'work-1' },
            { requiredCapabilities: ['git-push', 'claude-code'] },
        );
        expectNoSideEffects();
    });

    it("answers 'fleet' for a fleet-waiting decision (the run is held for the machine)", async () => {
        router.routeAgentTask.mockResolvedValue({ target: 'fleet-waiting', mode: 'local-wait' });
        expect((await build().previewPlacement!(payload)).placement).toBe('fleet');
    });

    it("answers 'cloud' for a cloud decision — and sends no fallback notice", async () => {
        router.routeAgentTask.mockResolvedValue({
            target: 'cloud',
            mode: 'local-fallback',
            fallbackReason: 'runners-offline',
        });
        expect(await build().previewPlacement!(payload)).toEqual({ placement: 'cloud' });
        expectNoSideEffects();
    });

    it("answers 'unknown' when routing throws (enqueue would fall back to the platform dispatcher)", async () => {
        router.routeAgentTask.mockRejectedValue(new Error('overlay unreadable'));
        expect(await build().previewPlacement!(payload)).toEqual({ placement: 'unknown' });
        expectNoSideEffects();
    });

    it('answers halted while the global stop flag is set, unreadable, or raised by the router', async () => {
        killSwitch = { isStopped: jest.fn().mockResolvedValue(true) };
        expect(await build().previewPlacement!(payload)).toEqual({
            placement: 'unknown',
            halted: true,
        });
        expect(router.routeAgentTask).not.toHaveBeenCalled();

        killSwitch = { isStopped: jest.fn().mockRejectedValue(new Error('db down')) };
        expect(await build().previewPlacement!(payload)).toEqual({
            placement: 'unknown',
            halted: true,
        });

        killSwitch = { isStopped: jest.fn().mockResolvedValue(false) };
        router.routeAgentTask.mockRejectedValue(new FleetKillSwitchActiveError('task-1'));
        expect(await build().previewPlacement!(payload)).toEqual({
            placement: 'unknown',
            halted: true,
        });
        expectNoSideEffects();
    });
});
