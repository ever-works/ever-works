import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FLEET_HEALTH_ROLLUP_CRON as SHARED_FLEET_HEALTH_ROLLUP_CRON } from '@ever-works/contracts';

/**
 * Computer health (FL-03) — pins the hourly roll-up's schedule and its body:
 * the cron resolves the `FleetNodeHealthService` RPC proxy, calls
 * `rollupAndPrune()`, logs a counters-only summary (and nothing when there
 * was nothing to do), and returns the summary. The roll-up values, the
 * idempotence and the retention boundaries are the agent package's
 * (`fleet-node-health-sample.repository.integration.spec.ts`, on sqlite).
 */
const {
    schedulesTaskMock,
    createApplicationContextMock,
    createTriggerLoggerMock,
    loggerInfoMock,
    StubInternalModule,
    StubFleetNodeHealthService,
} = vi.hoisted(() => {
    class StubInternalModule {}
    class StubFleetNodeHealthService {}
    return {
        schedulesTaskMock: vi.fn(),
        createApplicationContextMock: vi.fn(),
        createTriggerLoggerMock: vi.fn(),
        loggerInfoMock: vi.fn(),
        StubInternalModule,
        StubFleetNodeHealthService,
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
    FleetNodeHealthService: StubFleetNodeHealthService,
}));

vi.mock('../trigger/worker/modules/trigger-internal.module', () => ({
    TriggerInternalModule: StubInternalModule,
}));

vi.mock('../trigger/worker/trigger-logger', () => ({
    createTriggerLogger: createTriggerLoggerMock,
}));

// The real helper default-imports the whole worker module graph; its
// contract (boot the given module, name the logger, always close) is
// reproduced here against the mocked NestFactory.
vi.mock('../trigger/worker/utils/worker-context.utils', () => ({
    withWorkerContext: async (
        loggerName: string,
        fn: (ctx: unknown) => Promise<unknown>,
        module: unknown,
    ) => {
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

const importTask = async () => {
    vi.resetModules();
    schedulesTaskMock.mockReset();
    const mod = await import('../tasks/trigger/fleet-health-rollup.task');
    const cfg = schedulesTaskMock.mock.calls[
        schedulesTaskMock.mock.calls.length - 1
    ][0] as ScheduleConfig;
    return { cfg, mod };
};

describe('fleetHealthRollupTask', () => {
    let rollupAndPrune: ReturnType<typeof vi.fn>;
    let appContext: {
        useLogger: ReturnType<typeof vi.fn>;
        get: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        vi.clearAllMocks();
        rollupAndPrune = vi.fn().mockResolvedValue({
            enabled: true,
            rolledHours: 1,
            hourlyRows: 4,
            prunedRaw: 240,
            prunedHourly: 0,
        });
        appContext = {
            useLogger: vi.fn(),
            get: vi.fn((token: unknown) =>
                token === StubFleetNodeHealthService ? { rollupAndPrune } : undefined,
            ),
            close: vi.fn().mockResolvedValue(undefined),
        };
        createApplicationContextMock.mockResolvedValue(appContext);
    });

    it('registers hourly at :07, the cron the API fallback shares', async () => {
        const { cfg, mod } = await importTask();
        expect(cfg.id).toBe('fleet-health-rollup');
        expect(cfg.cron).toBe('7 * * * *');
        expect(cfg.cron).toBe(SHARED_FLEET_HEALTH_ROLLUP_CRON);
        expect(mod.FLEET_HEALTH_ROLLUP_CRON).toBe(SHARED_FLEET_HEALTH_ROLLUP_CRON);
        // Off the lease sweeper's slot (3/5) and the top of the hour.
        expect(cfg.cron).not.toBe('3/5 * * * *');
        expect(cfg.cron).not.toBe('0 * * * *');
    });

    it('boots TriggerInternalModule, calls rollupAndPrune through the proxy and returns its summary', async () => {
        const { cfg } = await importTask();
        const result = await cfg.run();
        expect(createApplicationContextMock).toHaveBeenCalledWith(StubInternalModule);
        expect(createTriggerLoggerMock).toHaveBeenCalledWith('FleetHealthRollup');
        expect(rollupAndPrune).toHaveBeenCalledTimes(1);
        expect(rollupAndPrune).toHaveBeenCalledWith();
        expect(result).toEqual({
            status: 'completed',
            enabled: true,
            rolledHours: 1,
            hourlyRows: 4,
            prunedRaw: 240,
            prunedHourly: 0,
        });
        expect(appContext.close).toHaveBeenCalled();
    });

    it('logs counters only', async () => {
        const { cfg } = await importTask();
        await cfg.run();
        const [event, payload] = loggerInfoMock.mock.calls[0];
        expect(event).toBe('fleet.health.rollup.completed');
        expect(Object.keys(payload).sort()).toEqual([
            'hourlyRows',
            'prunedHourly',
            'prunedRaw',
            'rolledHours',
        ]);
    });

    it('stays quiet with nothing to do, and with the history switched off', async () => {
        rollupAndPrune.mockResolvedValueOnce({
            enabled: false,
            rolledHours: 0,
            hourlyRows: 0,
            prunedRaw: 0,
            prunedHourly: 0,
        });
        const { cfg } = await importTask();
        await cfg.run();
        expect(loggerInfoMock).not.toHaveBeenCalled();
    });
});
