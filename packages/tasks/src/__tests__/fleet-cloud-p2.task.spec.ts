import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    FLEET_CLOUD_IDLE_CRON as SHARED_FLEET_CLOUD_IDLE_CRON,
    FLEET_CLOUD_USAGE_CRON as SHARED_FLEET_CLOUD_USAGE_CRON,
} from '@ever-works/contracts';

/**
 * Cloud computers (FL-17 P2, plan §10, T-23, T-24) — pins the two P2 crons
 * and their bodies: `fleet-cloud-usage` every 10 minutes and `fleet-cloud-idle`
 * every 10 minutes offset 5 (the schedules the API fallback shares), each
 * resolving the `FleetCloudSweepService` RPC proxy on `TriggerInternalModule`,
 * calling exactly its sweep, logging counters only (nothing when nothing
 * happened) and returning the summary. What the sweeps decide — the cost
 * model, the compare-and-set, one notice per window, never destroying — is the
 * agent package's (`fleet-cloud-p2.service.spec.ts`).
 */
const {
    schedulesTaskMock,
    createApplicationContextMock,
    createTriggerLoggerMock,
    loggerInfoMock,
    StubInternalModule,
    StubFleetCloudSweepService,
} = vi.hoisted(() => {
    class StubInternalModule {}
    class StubFleetCloudSweepService {}
    return {
        schedulesTaskMock: vi.fn(),
        createApplicationContextMock: vi.fn(),
        createTriggerLoggerMock: vi.fn(),
        loggerInfoMock: vi.fn(),
        StubInternalModule,
        StubFleetCloudSweepService,
    };
});

vi.mock('@trigger.dev/sdk', () => ({
    schedules: { task: schedulesTaskMock },
    task: vi.fn(),
    logger: { info: loggerInfoMock, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@nestjs/core', () => ({
    NestFactory: { createApplicationContext: createApplicationContextMock },
}));

vi.mock('@ever-works/agent/fleet', () => ({
    FleetCloudSweepService: StubFleetCloudSweepService,
}));

vi.mock('../trigger/worker/modules/trigger-internal.module', () => ({
    TriggerInternalModule: StubInternalModule,
}));

vi.mock('../trigger/worker/trigger-logger', () => ({
    createTriggerLogger: createTriggerLoggerMock,
}));

vi.mock('../trigger/worker/utils/worker-context.utils', () => ({
    withWorkerContext: async (loggerName: string, fn: (ctx: unknown) => Promise<unknown>, module: unknown) => {
        const ctx = await createApplicationContextMock(module);
        ctx.useLogger(createTriggerLoggerMock(loggerName));
        try {
            return await fn(ctx);
        } finally {
            await ctx.close();
        }
    },
}));

type ScheduleConfig = { id: string; cron: string; run: () => Promise<unknown> };

const importTask = async (file: 'fleet-cloud-usage' | 'fleet-cloud-idle') => {
    vi.resetModules();
    schedulesTaskMock.mockReset();
    const mod =
        file === 'fleet-cloud-usage'
            ? await import('../tasks/trigger/fleet-cloud-usage.task')
            : await import('../tasks/trigger/fleet-cloud-idle.task');
    const cfg = schedulesTaskMock.mock.calls[schedulesTaskMock.mock.calls.length - 1][0] as ScheduleConfig;
    return { cfg, mod: mod as Record<string, unknown> };
};

describe('FL-17 P2 cloud crons', () => {
    let sweeps: { refreshUsage: ReturnType<typeof vi.fn>; evaluateIdle: ReturnType<typeof vi.fn>; reconcile: ReturnType<typeof vi.fn> };
    let appContext: { useLogger: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        vi.clearAllMocks();
        sweeps = {
            refreshUsage: vi.fn().mockResolvedValue({ machines: 3, changed: 2 }),
            evaluateIdle: vi.fn().mockResolvedValue({ machines: 3, acted: 1 }),
            reconcile: vi.fn(),
        };
        appContext = {
            useLogger: vi.fn(),
            get: vi.fn((token: unknown) => (token === StubFleetCloudSweepService ? sweeps : undefined)),
            close: vi.fn().mockResolvedValue(undefined),
        };
        createApplicationContextMock.mockResolvedValue(appContext);
    });

    it('registers fleet-cloud-usage every 10 minutes and fleet-cloud-idle offset by 5, as the API fallback does', async () => {
        const usage = await importTask('fleet-cloud-usage');
        expect(usage.cfg.id).toBe('fleet-cloud-usage');
        expect(usage.cfg.cron).toBe('*/10 * * * *');
        expect(usage.cfg.cron).toBe(SHARED_FLEET_CLOUD_USAGE_CRON);
        expect(usage.mod.FLEET_CLOUD_USAGE_CRON).toBe(SHARED_FLEET_CLOUD_USAGE_CRON);

        const idle = await importTask('fleet-cloud-idle');
        expect(idle.cfg.id).toBe('fleet-cloud-idle');
        expect(idle.cfg.cron).toBe('5-55/10 * * * *');
        expect(idle.cfg.cron).toBe(SHARED_FLEET_CLOUD_IDLE_CRON);
        expect(idle.mod.FLEET_CLOUD_IDLE_CRON).toBe(SHARED_FLEET_CLOUD_IDLE_CRON);
    });

    it('fleet-cloud-usage calls refreshUsage only, through the proxy on TriggerInternalModule', async () => {
        const { cfg } = await importTask('fleet-cloud-usage');
        const result = await cfg.run();
        expect(createApplicationContextMock).toHaveBeenCalledWith(StubInternalModule);
        expect(createTriggerLoggerMock).toHaveBeenCalledWith('FleetCloudUsage');
        expect(sweeps.refreshUsage).toHaveBeenCalledTimes(1);
        expect(sweeps.evaluateIdle).not.toHaveBeenCalled();
        expect(result).toEqual({ status: 'completed', machines: 3, changed: 2 });
        expect(loggerInfoMock).toHaveBeenCalledWith('fleet.cloud.usage.completed', { machines: 3, changed: 2 });
        expect(appContext.close).toHaveBeenCalled();
    });

    it('fleet-cloud-idle calls evaluateIdle only, and stays quiet when it acted on nothing', async () => {
        const { cfg } = await importTask('fleet-cloud-idle');
        await expect(cfg.run()).resolves.toEqual({ status: 'completed', machines: 3, acted: 1 });
        expect(sweeps.evaluateIdle).toHaveBeenCalledTimes(1);
        expect(sweeps.refreshUsage).not.toHaveBeenCalled();
        expect(loggerInfoMock).toHaveBeenCalledWith('fleet.cloud.idle.completed', { machines: 3, acted: 1 });

        loggerInfoMock.mockClear();
        sweeps.evaluateIdle.mockResolvedValueOnce({ machines: 0, acted: 0 });
        await cfg.run();
        expect(loggerInfoMock).not.toHaveBeenCalled();
    });
});
