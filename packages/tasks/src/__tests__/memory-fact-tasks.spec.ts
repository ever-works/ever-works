import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AW-07 — the two memory-fact jobs.
 *
 *  - `memory-fact-embed` (one-shot): validates the fact id BEFORE it crosses
 *    the RPC channel, runs on a bounded queue, and forwards `embedFact`.
 *  - `memory-fact-gc` (cron `13 4 * * *`): forwards `sweep()`.
 *
 * Both resolve their service through `TriggerInternalModule` — the real
 * services live in the API, where the AI provider and vector-store plugins
 * are loaded.
 */

const {
    taskMock,
    schedulesTaskMock,
    createApplicationContextMock,
    createTriggerLoggerMock,
    StubInternalModule,
    loggerInfoMock,
} = vi.hoisted(() => {
    class StubInternalModule {}
    return {
        taskMock: vi.fn(),
        schedulesTaskMock: vi.fn(),
        createApplicationContextMock: vi.fn(),
        createTriggerLoggerMock: vi.fn(),
        StubInternalModule,
        loggerInfoMock: vi.fn(),
    };
});

vi.mock('@trigger.dev/sdk', () => ({
    task: taskMock,
    schedules: { task: schedulesTaskMock },
    logger: { info: loggerInfoMock, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@nestjs/core', () => ({
    NestFactory: { createApplicationContext: createApplicationContextMock },
}));

vi.mock('../trigger/worker/modules/trigger-internal.module', () => ({
    TriggerInternalModule: StubInternalModule,
}));

vi.mock('../trigger/worker/trigger-logger', () => ({
    createTriggerLogger: createTriggerLoggerMock,
}));

// The real service classes are the DI tokens the tasks resolve — the worker
// context is stubbed, so they are only ever used as lookup keys here.
import { MemoryFactEmbedService, MemoryFactSweepService } from '@ever-works/agent/services';

type TaskConfig = {
    id: string;
    cron?: string;
    queue?: { name: string; concurrencyLimit: number };
    run: (payload?: unknown) => Promise<unknown>;
};

const FACT_ID = '11111111-1111-4111-8111-111111111111';

let embedFact: ReturnType<typeof vi.fn>;
let sweep: ReturnType<typeof vi.fn>;

async function importEmbedTask(): Promise<TaskConfig> {
    vi.resetModules();
    taskMock.mockReset();
    await import('../tasks/trigger/memory-fact-embed.task');
    return taskMock.mock.calls[taskMock.mock.calls.length - 1][0] as TaskConfig;
}

async function importGcTask(): Promise<TaskConfig> {
    vi.resetModules();
    schedulesTaskMock.mockReset();
    await import('../tasks/trigger/memory-fact-gc.task');
    return schedulesTaskMock.mock.calls[schedulesTaskMock.mock.calls.length - 1][0] as TaskConfig;
}

describe('memory-fact jobs', () => {
    beforeAll(async () => {
        createApplicationContextMock.mockResolvedValue({
            useLogger: vi.fn(),
            get: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        });
        await importEmbedTask();
        await importGcTask();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        embedFact = vi.fn().mockResolvedValue({ status: 'embedded', factId: FACT_ID });
        sweep = vi.fn().mockResolvedValue({
            purged: 0,
            embedded: 0,
            reembedded: 0,
            embedStoppedReason: null,
        });
        createApplicationContextMock.mockResolvedValue({
            useLogger: vi.fn(),
            get: vi.fn().mockImplementation((token: unknown) => {
                if (token === MemoryFactEmbedService) return { embedFact };
                if (token === MemoryFactSweepService) return { sweep };
                return undefined;
            }),
            close: vi.fn().mockResolvedValue(undefined),
        });
        createTriggerLoggerMock.mockReturnValue({});
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('memory-fact-embed', () => {
        it('registers with a bounded queue so a bulk import cannot saturate the runtime', async () => {
            const config = await importEmbedTask();
            expect(config.id).toBe('memory-fact-embed');
            expect(config.queue).toEqual({ name: 'memory-fact-embed', concurrencyLimit: 4 });
        });

        it('forwards embedFact(factId) through TriggerInternalModule', async () => {
            const config = await importEmbedTask();
            const outcome = await config.run({ factId: FACT_ID, userId: FACT_ID });
            expect(createApplicationContextMock).toHaveBeenCalledWith(StubInternalModule);
            expect(embedFact).toHaveBeenCalledWith(FACT_ID);
            expect(outcome).toEqual({ status: 'embedded', factId: FACT_ID });
        });

        it('refuses a non-UUID fact id before any RPC', async () => {
            const config = await importEmbedTask();
            await expect(config.run({ factId: "1' OR 1=1", userId: FACT_ID })).rejects.toThrow(
                /Invalid payload.factId/,
            );
            expect(createApplicationContextMock).not.toHaveBeenCalled();
        });

        it('acks (does not throw) when no provider or store is available yet', async () => {
            embedFact.mockResolvedValue({ status: 'unavailable', factId: FACT_ID, reason: 'none' });
            const config = await importEmbedTask();
            await expect(config.run({ factId: FACT_ID, userId: FACT_ID })).resolves.toMatchObject({
                status: 'unavailable',
            });
        });
    });

    describe('memory-fact-gc', () => {
        it('registers at 04:13 daily, clear of the sibling daily crons', async () => {
            const config = await importGcTask();
            expect(config.id).toBe('memory-fact-gc');
            expect(config.cron).toBe('13 4 * * *');
            for (const taken of [
                '42 3 * * *',
                '23 */2 * * *',
                '37 8 * * *',
                '41 4 * * *',
                '17 3 * * *',
            ]) {
                expect(config.cron).not.toBe(taken);
            }
        });

        it('forwards sweep() and stays quiet when nothing happened', async () => {
            const config = await importGcTask();
            await config.run();
            expect(sweep).toHaveBeenCalledTimes(1);
            expect(loggerInfoMock).not.toHaveBeenCalled();
        });

        it('logs a pass that purged or embedded something', async () => {
            sweep.mockResolvedValue({
                purged: 2,
                embedded: 0,
                reembedded: 0,
                embedStoppedReason: null,
            });
            const config = await importGcTask();
            await config.run();
            expect(loggerInfoMock).toHaveBeenCalledWith(
                'memory-fact-gc pass',
                expect.objectContaining({ purged: 2 }),
            );
        });
    });
});
