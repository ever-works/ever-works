import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * APW-06 T32 (`tasks.md:556-573`) — **`app-health-poll`**, the every-minute tick.
 *
 * T32's own list for this file is short and precise: "the poll task exits when the lock is held",
 * plus "every task declares queue `app-cluster-io` and boots `TriggerAppRuntimeModule`". Both are
 * pinned here against the SDK's own registration and against the module the context factory is
 * handed.
 *
 * The third thing this spec pins is the **guard's failure mode**, because it is the one that can
 * silently double a notification: a tick that cannot reach the lock service must poll nothing
 * (`lock_service_unavailable`), while a tick that finds the lock *held* must simply wait for the
 * next minute (`lock_held`).
 *
 * The cache sweep is asserted through an injected `CACHE_MANAGER`, including its refusal path: the
 * plan's `cleanExpired()` may be refused by the API's published surface, and a refusal must be a
 * reported `unavailable` rather than a lost tick. The health sweep itself is T27's
 * (`packages/agent/src/app-runtime/app-health.service.ts`) and is not in this tree; the tick says
 * so by name (`health_service_unavailable`) instead of pretending to have polled.
 */

const {
    schedulesTaskMock,
    createApplicationContextMock,
    createTriggerLoggerMock,
    loggerErrorMock,
    loggerInfoMock,
    loggerWarnMock,
    recorded,
} = vi.hoisted(() => ({
    schedulesTaskMock: vi.fn((params: unknown) => params),
    createApplicationContextMock: vi.fn(),
    createTriggerLoggerMock: vi.fn(),
    loggerErrorMock: vi.fn(),
    loggerInfoMock: vi.fn(),
    loggerWarnMock: vi.fn(),
    recorded: [] as Array<Record<string, unknown>>,
}));

import { UnknownElementException } from '@nestjs/core/errors/exceptions/unknown-element.exception';

vi.mock('@trigger.dev/sdk', () => ({
    task: vi.fn((params: unknown) => params),
    schedules: {
        task: (params: Record<string, unknown>) => {
            recorded.push(params);
            return schedulesTaskMock(params);
        },
    },
    logger: {
        info: loggerInfoMock,
        warn: loggerWarnMock,
        error: loggerErrorMock,
        debug: vi.fn(),
        log: vi.fn(),
    },
}));

vi.mock('@nestjs/core', () => ({
    NestFactory: { createApplicationContext: createApplicationContextMock },
}));

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

import { CACHE_MANAGER, DistributedTaskLockService } from '@ever-works/agent/cache';
import { AppHealthService } from '@ever-works/agent/app-runtime';
import {
    APP_HEALTH_POLL_CRON,
    APP_HEALTH_POLL_LOCK_KEY,
    APP_HEALTH_POLL_TASK_ID,
    appHealthPollTask,
} from '../tasks/trigger/app-health-poll.task';
import {
    APP_RUNTIME_TASK_QUEUE,
    TriggerAppRuntimeModule,
} from '../trigger/worker/modules/trigger-app-runtime.module';

const registered = recorded.find((entry) => entry.id === APP_HEALTH_POLL_TASK_ID) as Record<
    string,
    any
>;

describe('app-health-poll (APW-06 T32)', () => {
    let isLocked: ReturnType<typeof vi.fn>;
    let cleanExpired: ReturnType<typeof vi.fn>;
    let appContext: {
        useLogger: ReturnType<typeof vi.fn>;
        get: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        vi.clearAllMocks();

        isLocked = vi.fn(async () => false);
        cleanExpired = vi.fn(async () => 3);

        const answers = new Map<unknown, unknown>([
            [DistributedTaskLockService, { isLocked }],
            [CACHE_MANAGER, { cleanExpired }],
        ]);

        appContext = {
            useLogger: vi.fn(),
            get: vi.fn((token: unknown) => answers.get(token)),
            close: vi.fn(async () => undefined),
        };
        createApplicationContextMock.mockResolvedValue(appContext);
    });

    it('registers the task', () => {
        expect(registered, 'app-health-poll was not registered').toBeDefined();
        expect(appHealthPollTask.id).toBe(APP_HEALTH_POLL_TASK_ID);
    });

    it('runs every minute — §9.2’s cron', () => {
        expect(registered.cron).toBe('* * * * *');
        expect(APP_HEALTH_POLL_CRON).toBe('* * * * *');
    });

    it('declares the `app-cluster-io` queue at concurrency 20 and a fifteen-minute budget', () => {
        expect(registered.queue).toEqual({ name: 'app-cluster-io', concurrencyLimit: 20 });
        expect(registered.queue).toEqual(APP_RUNTIME_TASK_QUEUE);
        expect(registered.maxDuration).toBe(900);
    });

    it('boots TriggerAppRuntimeModule — which is what arms the worker-context flag', async () => {
        await registered.run();

        expect(createApplicationContextMock).toHaveBeenCalledWith(TriggerAppRuntimeModule);
        expect(createTriggerLoggerMock).toHaveBeenCalledWith('AppHealthPoll');
        expect(appContext.close).toHaveBeenCalled();
    });

    it('exits when the lock is held — T32’s own case', async () => {
        isLocked.mockResolvedValue(true);

        const result = await registered.run();

        expect(isLocked).toHaveBeenCalledWith('app-health-poll');
        expect(APP_HEALTH_POLL_LOCK_KEY).toBe('app-health-poll');
        expect(result).toMatchObject({ status: 'skipped', reason: 'lock_held', lockGuard: 'held' });
        // The tick did nothing else: no cache sweep, and no claim to have polled.
        expect(cleanExpired).not.toHaveBeenCalled();
        expect(result.cacheSweep).toBeNull();
    });

    it('polls nothing when the lock service is unbound — a refusal, not a guess', async () => {
        appContext.get.mockReturnValue(undefined);

        const result = await registered.run();

        expect(result).toMatchObject({
            status: 'skipped',
            reason: 'lock_service_unavailable',
            lockGuard: 'unavailable',
        });
        expect(cleanExpired).not.toHaveBeenCalled();
        expect(loggerWarnMock).toHaveBeenCalled();
    });

    it('polls nothing when the lock service is unbound — a refusal, not a guess — when Nest THROWS for it, its real behaviour', async () => {
        appContext.get.mockImplementation(() => {
            // What Nest actually does for an absent provider; the case above
            // fakes `undefined`, which Nest never returns.
            throw new UnknownElementException('absent provider');
        });

        const result = await registered.run();

        expect(result).toMatchObject({
            status: 'skipped',
            reason: 'lock_service_unavailable',
            lockGuard: 'unavailable',
        });
        expect(cleanExpired).not.toHaveBeenCalled();
        expect(loggerWarnMock).toHaveBeenCalled();
    });

    it('polls nothing when the lock service rejects — a second sweep would double a streak', async () => {
        isLocked.mockRejectedValue(new Error('the API is unreachable'));

        const result = await registered.run();

        expect(result).toMatchObject({
            status: 'skipped',
            reason: 'lock_service_unavailable',
            lockGuard: 'unavailable',
            error: 'the API is unreachable',
        });
        expect(cleanExpired).not.toHaveBeenCalled();
    });

    it('sweeps the cache on a free lock and reports the adapter’s own count', async () => {
        const result = await registered.run();

        expect(isLocked).toHaveBeenCalledWith('app-health-poll');
        expect(cleanExpired).toHaveBeenCalledTimes(1);
        expect(result.cacheSweep).toEqual({ status: 'swept', expired: 3, message: null });
    });

    it('reports a refused cache sweep as `unavailable` without losing the tick', async () => {
        cleanExpired.mockRejectedValue(
            new Error('Method not in allow-list for CacheManager: cleanExpired'),
        );

        const result = await registered.run();

        expect(result.cacheSweep).toEqual({
            status: 'unavailable',
            expired: null,
            message: 'Method not in allow-list for CacheManager: cleanExpired',
        });
        expect(loggerWarnMock).toHaveBeenCalled();
        // The tick still reaches its own verdict — a cache refusal is never fatal.
        expect(result.status).toBe('skipped');
    });

    it('names the health service it cannot reach instead of reporting a green sweep', async () => {
        const result = await registered.run();

        expect(result).toMatchObject({
            status: 'skipped',
            reason: 'health_service_unavailable',
            missing: 'packages/agent/src/app-runtime/app-health.service.ts',
        });
        expect(loggerErrorMock).toHaveBeenCalled();
    });

    it('runs T27’s sweep through the service the context resolves, and reports its summary', async () => {
        const summary = {
            ok: true,
            reason: null,
            selected: 4,
            polled: 4,
            skipped: 0,
            notifications: 1,
            verdicts: { healthy: 3, degraded: 0, down: 1, unreachable: 0 },
        };
        const poll = vi.fn(async () => summary);
        appContext.get.mockImplementation((token: unknown) =>
            token === AppHealthService
                ? { poll }
                : new Map<unknown, unknown>([
                      [DistributedTaskLockService, { isLocked }],
                      [CACHE_MANAGER, { cleanExpired }],
                  ]).get(token),
        );

        const result = await registered.run();

        expect(poll).toHaveBeenCalledTimes(1);
        expect(result.status).toBe('ran');
        expect(result.health).toEqual(summary);
        expect(result.cacheSweep).toEqual({ status: 'swept', expired: 3, message: null });
    });

    it('reports T27’s own refusal — the store T17 owes — rather than a zero-work “ran”', async () => {
        const summary = {
            ok: false,
            reason: 'health_store_unavailable',
            selected: 0,
            polled: 0,
            skipped: 0,
            notifications: 0,
            verdicts: { healthy: 0, degraded: 0, down: 0, unreachable: 0 },
        };
        const poll = vi.fn(async () => summary);
        appContext.get.mockImplementation((token: unknown) =>
            token === AppHealthService
                ? { poll }
                : new Map<unknown, unknown>([
                      [DistributedTaskLockService, { isLocked }],
                      [CACHE_MANAGER, { cleanExpired }],
                  ]).get(token),
        );

        const result = await registered.run();

        expect(result).toMatchObject({
            status: 'skipped',
            reason: 'health_store_unavailable',
            lockGuard: 'free',
            health: summary,
        });
    });
});
