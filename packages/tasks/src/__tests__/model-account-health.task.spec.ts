import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Model accounts (AW-16) — pins the schedule shape of the credential health
 * check and that its body resolves the API-side service through the internal
 * RPC module (the one that registers the proxy) and returns the sweep.
 */
const { schedulesTaskMock, withWorkerContextMock, StubInternalModule, StubHealthService } =
    vi.hoisted(() => {
        class StubInternalModule {}
        class StubHealthService {}
        return {
            schedulesTaskMock: vi.fn((config: unknown) => config),
            withWorkerContextMock: vi.fn(),
            StubInternalModule,
            StubHealthService,
        };
    });

vi.mock('@trigger.dev/sdk', () => ({
    schedules: { task: schedulesTaskMock },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@ever-works/agent/model-routing', () => ({
    ModelAccountHealthService: StubHealthService,
}));
vi.mock('../trigger/worker/utils/worker-context.utils', () => ({
    withWorkerContext: withWorkerContextMock,
}));
vi.mock('../trigger/worker/modules/trigger-internal.module', () => ({
    TriggerInternalModule: StubInternalModule,
}));

type ScheduleConfig = { id: string; cron: string; run: () => Promise<unknown> };

describe('modelAccountHealthTask', () => {
    let config: ScheduleConfig;

    beforeEach(async () => {
        vi.resetModules();
        schedulesTaskMock.mockClear();
        withWorkerContextMock.mockReset();
        await import('../tasks/trigger/model-account-health.task');
        config = schedulesTaskMock.mock.calls[0][0] as ScheduleConfig;
    });

    it('runs every six hours, off the hour', () => {
        expect(config.id).toBe('model-account-health');
        expect(config.cron).toBe('19 */6 * * *');
    });

    it('probes due accounts through the internal RPC module and returns the sweep', async () => {
        const sweep = { scanned: 3, checked: 2, health: { working: 1, invalid: 1 } };
        const probeDueAccounts = vi.fn().mockResolvedValue(sweep);
        withWorkerContextMock.mockImplementation(async (_name, body, module) => {
            expect(module).toBe(StubInternalModule);
            return body({
                get: (token: unknown) => {
                    expect(token).toBe(StubHealthService);
                    return { probeDueAccounts };
                },
            });
        });

        await expect(config.run()).resolves.toEqual({ status: 'completed', ...sweep });
        expect(probeDueAccounts).toHaveBeenCalledTimes(1);
    });
});
