import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Skills shelf — pins the hourly readiness sweep's schedule and its body:
 * the cron resolves the `SkillReadinessService` RPC proxy and calls
 * `sweepStale()`, logs a counters-only summary, and propagates nothing it
 * was not given. The per-Skill failure isolation and both caps live in the
 * service (covered by the agent package's readiness service spec).
 */
const {
    schedulesTaskMock,
    createApplicationContextMock,
    createTriggerLoggerMock,
    loggerInfoMock,
    StubInternalModule,
    StubSkillReadinessService,
} = vi.hoisted(() => {
    class StubInternalModule {}
    class StubSkillReadinessService {}
    return {
        schedulesTaskMock: vi.fn(),
        createApplicationContextMock: vi.fn(),
        createTriggerLoggerMock: vi.fn(),
        loggerInfoMock: vi.fn(),
        StubInternalModule,
        StubSkillReadinessService,
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

vi.mock('@ever-works/agent/skills', () => ({
    SkillReadinessService: StubSkillReadinessService,
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
    const mod = await import('../tasks/trigger/skill-readiness-sweep.task');
    const cfg = schedulesTaskMock.mock.calls[
        schedulesTaskMock.mock.calls.length - 1
    ][0] as ScheduleConfig;
    return { cfg, mod };
};

describe('skillReadinessSweepTask', () => {
    let sweepStale: ReturnType<typeof vi.fn>;
    let appContext: {
        useLogger: ReturnType<typeof vi.fn>;
        get: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        vi.clearAllMocks();
        sweepStale = vi.fn().mockResolvedValue({
            scanned: 3,
            changed: 1,
            failed: 1,
            byState: {
                ready: 1,
                needs_setup: 1,
                missing_requirements: 0,
                blocked_by_access: 0,
                unknown: 0,
            },
            durationMs: 12,
        });
        appContext = {
            useLogger: vi.fn(),
            get: vi.fn((token: unknown) =>
                token === StubSkillReadinessService ? { sweepStale } : undefined,
            ),
            close: vi.fn().mockResolvedValue(undefined),
        };
        createApplicationContextMock.mockResolvedValue(appContext);
    });

    it('registers hourly at :17, clear of the other sweeps', async () => {
        const { cfg, mod } = await importTask();
        expect(cfg.id).toBe('skill-readiness-sweep');
        expect(cfg.cron).toBe('17 * * * *');
        expect(mod.SKILL_READINESS_SWEEP_CRON).toBe('17 * * * *');
        for (const other of ['42 3 * * *', '37 8 * * *', '17 3 * * *']) {
            expect(cfg.cron).not.toBe(other);
        }
    });

    it('boots TriggerInternalModule, calls sweepStale through the proxy and returns its summary', async () => {
        const { cfg } = await importTask();
        const result = await cfg.run();
        expect(createApplicationContextMock).toHaveBeenCalledWith(StubInternalModule);
        expect(createTriggerLoggerMock).toHaveBeenCalledWith('SkillReadinessSweep');
        expect(sweepStale).toHaveBeenCalledTimes(1);
        expect(sweepStale).toHaveBeenCalledWith();
        expect(result).toMatchObject({ scanned: 3, changed: 1, failed: 1 });
        expect(appContext.close).toHaveBeenCalled();
    });

    it('logs counters only', async () => {
        const { cfg } = await importTask();
        await cfg.run();
        const [event, payload] = loggerInfoMock.mock.calls[0];
        expect(event).toBe('skill.readiness.sweep.completed');
        expect(Object.keys(payload).sort()).toEqual([
            'byState',
            'changed',
            'durationMs',
            'failed',
            'scanned',
        ]);
    });

    it('stays quiet when nothing was stale', async () => {
        sweepStale.mockResolvedValueOnce({
            scanned: 0,
            changed: 0,
            failed: 0,
            byState: {
                ready: 0,
                needs_setup: 0,
                missing_requirements: 0,
                blocked_by_access: 0,
                unknown: 0,
            },
            durationMs: 1,
        });
        const { cfg } = await importTask();
        await cfg.run();
        expect(loggerInfoMock).not.toHaveBeenCalled();
    });
});
