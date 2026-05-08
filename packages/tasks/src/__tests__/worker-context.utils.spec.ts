import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
    createApplicationContextMock,
    triggerLoggerInstance,
    createTriggerLoggerMock,
    StubModule,
    CustomModule,
} = vi.hoisted(() => {
    class StubModule {}
    class CustomModule {}
    return {
        createApplicationContextMock: vi.fn(),
        triggerLoggerInstance: { __kind: 'trigger-logger' },
        createTriggerLoggerMock: vi.fn(),
        StubModule,
        CustomModule,
    };
});

vi.mock('@nestjs/core', () => ({
    NestFactory: { createApplicationContext: createApplicationContextMock },
}));

vi.mock('../trigger/worker/trigger-logger', () => ({
    createTriggerLogger: createTriggerLoggerMock,
}));

vi.mock('../trigger/worker/modules/trigger-worker.module', () => ({
    TriggerWorkerModule: StubModule,
}));

import { withWorkerContext } from '../trigger/worker/utils/worker-context.utils';
import { TriggerWorkerModule } from '../trigger/worker/modules/trigger-worker.module';

describe('withWorkerContext', () => {
    let appContext: { useLogger: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        vi.clearAllMocks();
        appContext = {
            useLogger: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        createApplicationContextMock.mockResolvedValue(appContext);
        createTriggerLoggerMock.mockReturnValue(triggerLoggerInstance);
    });

    it('bootstraps using the default TriggerWorkerModule when no module is supplied', async () => {
        await withWorkerContext('Boot', async () => 'value');

        expect(createApplicationContextMock).toHaveBeenCalledTimes(1);
        expect(createApplicationContextMock).toHaveBeenCalledWith(TriggerWorkerModule);
    });

    it('bootstraps using a caller-supplied module token when provided', async () => {
        await withWorkerContext('Boot', async () => 'value', CustomModule);

        expect(createApplicationContextMock).toHaveBeenCalledWith(CustomModule);
    });

    it('installs the trigger logger with the supplied loggerName before invoking fn', async () => {
        const seen: string[] = [];
        appContext.useLogger.mockImplementation((logger) => {
            seen.push(`useLogger:${logger.__kind}`);
        });

        await withWorkerContext('GenerationWorker', async () => {
            seen.push('fn');
        });

        expect(createTriggerLoggerMock).toHaveBeenCalledWith('GenerationWorker');
        expect(seen).toEqual(['useLogger:trigger-logger', 'fn']);
    });

    it('returns the value resolved by fn', async () => {
        const result = await withWorkerContext('X', async () => 42);
        expect(result).toBe(42);
    });

    it('passes the booted appContext to fn', async () => {
        const fn = vi.fn().mockResolvedValue('ok');
        await withWorkerContext('X', fn);

        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith(appContext);
    });

    it('always closes the appContext on success', async () => {
        await withWorkerContext('X', async () => 'ok');
        expect(appContext.close).toHaveBeenCalledTimes(1);
    });

    it('always closes the appContext when fn throws — and re-throws the original error', async () => {
        const err = new Error('boom');
        await expect(
            withWorkerContext('X', async () => {
                throw err;
            }),
        ).rejects.toBe(err);

        expect(appContext.close).toHaveBeenCalledTimes(1);
    });

    it('does NOT swallow close() failures (close throws → caller sees that error)', async () => {
        appContext.close.mockRejectedValueOnce(new Error('close-failed'));
        await expect(withWorkerContext('X', async () => 'ok')).rejects.toThrow('close-failed');
    });

    it('propagates close() errors over body errors when both fire (try/finally semantics)', async () => {
        // try/finally: a throw inside `finally` overrides any pending error from
        // the try-block. Pin that observable behaviour so a future refactor that
        // wraps close() in a swallowing try/catch surfaces in CI.
        const bodyErr = new Error('body-failed');
        const closeErr = new Error('close-failed');
        appContext.close.mockRejectedValueOnce(closeErr);

        await expect(
            withWorkerContext('X', async () => {
                throw bodyErr;
            }),
        ).rejects.toBe(closeErr);

        expect(appContext.close).toHaveBeenCalledTimes(1);
    });

    it('does not call useLogger or fn if NestFactory.createApplicationContext rejects', async () => {
        const fn = vi.fn();
        createApplicationContextMock.mockRejectedValueOnce(new Error('boot-failed'));

        await expect(withWorkerContext('X', fn)).rejects.toThrow('boot-failed');
        expect(appContext.useLogger).not.toHaveBeenCalled();
        expect(fn).not.toHaveBeenCalled();
        expect(appContext.close).not.toHaveBeenCalled();
    });
});
