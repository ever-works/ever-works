import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * APW-06 T32 + T70 — **`app-cluster-op`**, the one-shot that carries §9.2's ops.
 *
 * T71's landing wrote this task to *refuse by name* (`op_router_unavailable`) because T70's router
 * was not in the tree. T70 landed, so the task now **delegates**: this spec pins the delegation, the
 * registration §9.2 fixes, and the three refusals the task still owns — an unrecognised op id, a
 * payload with no Work, and the isolation gate. The `op_router_unavailable` path is pinned too, as
 * what it now is: a fallback for a worker context that boots without the router.
 *
 * The `verification-deploy` override is asserted as the **exported constant** the dispatcher reads
 * (`3 600`), because the override is a trigger-time option (§9.2) — T31's dispatcher passes it — and
 * a task that quietly registered 900 instead would leave a verification killed at fifteen minutes.
 */

const {
    taskMock,
    createApplicationContextMock,
    createTriggerLoggerMock,
    loggerErrorMock,
    loggerInfoMock,
    loggerWarnMock,
    recorded,
} = vi.hoisted(() => ({
    taskMock: vi.fn((params: unknown) => params),
    createApplicationContextMock: vi.fn(),
    createTriggerLoggerMock: vi.fn(),
    loggerErrorMock: vi.fn(),
    loggerInfoMock: vi.fn(),
    loggerWarnMock: vi.fn(),
    recorded: [] as Array<Record<string, unknown>>,
}));

import { UnknownElementException } from '@nestjs/core/errors/exceptions/unknown-element.exception';

vi.mock('@trigger.dev/sdk', () => ({
    task: (params: Record<string, unknown>) => {
        recorded.push(params);
        return taskMock(params);
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

import { AppClusterOpRouter } from '@ever-works/agent/app-runtime';
import {
    APP_CLUSTER_OP_MAX_DURATION_SECONDS,
    APP_CLUSTER_OP_TASK_ID,
    APP_CLUSTER_OP_VERIFICATION_MAX_DURATION,
    APP_CLUSTER_OPS,
    appClusterOpTask,
} from '../tasks/trigger/app-cluster-op.task';
import {
    APP_RUNTIME_TASK_QUEUE,
    TriggerAppRuntimeModule,
} from '../trigger/worker/modules/trigger-app-runtime.module';

const registered = recorded.find((entry) => entry.id === APP_CLUSTER_OP_TASK_ID) as Record<
    string,
    any
>;

const WORK_ID = '0f8e2c1a-1111-4a2b-9c3d-4e5f60718293';

describe('app-cluster-op (APW-06 T32 + T70)', () => {
    let handle: ReturnType<typeof vi.fn>;
    let appContext: {
        useLogger: ReturnType<typeof vi.fn>;
        get: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        vi.clearAllMocks();

        handle = vi.fn(async () => ({
            op: 'pause',
            workId: WORK_ID,
            requestId: 'req-1',
            state: 'done',
            code: null,
            route: 'lifecycle-ops',
            missing: null,
            result: { state: 'done' },
            cache: 'written',
        }));

        appContext = {
            useLogger: vi.fn(),
            get: vi.fn((token: unknown) => (token === AppClusterOpRouter ? { handle } : undefined)),
            close: vi.fn(async () => undefined),
        };
        createApplicationContextMock.mockResolvedValue(appContext);
    });

    it('registers the task on §9.2’s id, queue and budget', () => {
        expect(registered).toBeDefined();
        expect(appClusterOpTask.id).toBe(APP_CLUSTER_OP_TASK_ID);
        expect(registered.queue).toEqual({ name: 'app-cluster-io', concurrencyLimit: 20 });
        expect(registered.queue).toEqual(APP_RUNTIME_TASK_QUEUE);
        expect(registered.maxDuration).toBe(900);
        expect(APP_CLUSTER_OP_MAX_DURATION_SECONDS).toBe(900);
    });

    it('keeps §9.2’s 3 600 s override for verification-deploy', () => {
        // The dispatcher passes this at trigger time; registering 900 here would silently kill a
        // verification at fifteen minutes.
        expect(APP_CLUSTER_OP_VERIFICATION_MAX_DURATION).toBe(3600);
    });

    it('carries §9.2’s fifteen op ids, in the dispatcher’s order', () => {
        expect([...APP_CLUSTER_OPS]).toEqual([
            'status-refresh',
            'logs',
            'pause',
            'resume',
            'remove',
            'cancel-deploy',
            'job-run',
            'cluster-check',
            'prepare-namespace',
            'ingress-reconcile',
            'dns-reconcile',
            'delete-app-work',
            'verification-deploy',
            'verification-status',
            'verification-destroy',
        ]);
    });

    it('boots TriggerAppRuntimeModule and delegates to the router it resolves', async () => {
        const result = await registered.run({
            op: 'pause',
            workId: WORK_ID,
            requestId: 'req-1',
            userId: 'user-1',
        });

        expect(createApplicationContextMock).toHaveBeenCalledWith(TriggerAppRuntimeModule);
        expect(createTriggerLoggerMock).toHaveBeenCalledWith('AppClusterOp');
        expect(handle).toHaveBeenCalledWith({
            op: 'pause',
            workId: WORK_ID,
            requestId: 'req-1',
            userId: 'user-1',
        });
        expect(result).toMatchObject({
            status: 'ran',
            op: 'pause',
            workId: WORK_ID,
            requestId: 'req-1',
            reason: null,
            missing: null,
            error: null,
            route: 'lifecycle-ops',
            state: 'done',
        });
        expect(appContext.close).toHaveBeenCalled();
    });

    it('reports a routed refusal as `skipped` with the handler’s own code', async () => {
        handle.mockResolvedValue({
            op: 'remove',
            workId: WORK_ID,
            requestId: null,
            state: 'refused',
            code: 'deploy_in_progress',
            route: 'lifecycle-ops',
            missing: null,
            result: { detail: { deployLockId: 'dep-1' } },
            cache: 'skipped',
        });

        const result = await registered.run({ op: 'remove', workId: WORK_ID });

        expect(result).toMatchObject({
            status: 'skipped',
            reason: 'deploy_in_progress',
            missing: null,
            error: null,
            state: 'refused',
        });
    });

    it('reports an unowned op’s file through the router, not as a missing router', async () => {
        handle.mockResolvedValue({
            op: 'prepare-namespace',
            workId: WORK_ID,
            requestId: null,
            state: 'refused',
            code: 'op_handler_unavailable',
            route: 'unowned',
            missing: 'packages/agent/src/app-runtime/app-runtime-target.resolver.ts',
            result: { detail: { owner: 'APW-06 T69' } },
            cache: 'skipped',
        });

        const result = await registered.run({ op: 'prepare-namespace', workId: WORK_ID });

        expect(result).toMatchObject({
            status: 'skipped',
            reason: 'op_handler_unavailable',
            missing: 'packages/agent/src/app-runtime/app-runtime-target.resolver.ts',
        });
    });

    it('refuses an op outside §9.2 before the router is even resolved', async () => {
        const result = await registered.run({ op: 'not-an-op', workId: WORK_ID });

        expect(result).toMatchObject({ status: 'skipped', reason: 'unknown_op' });
        expect(createApplicationContextMock).not.toHaveBeenCalled();
        expect(handle).not.toHaveBeenCalled();
    });

    it('refuses a payload with no Work', async () => {
        const result = await registered.run({ op: 'pause', workId: '' });

        expect(result).toMatchObject({ status: 'skipped', reason: 'invalid_payload' });
        expect(handle).not.toHaveBeenCalled();
    });

    it('still names the router file when the context boots without it', async () => {
        appContext.get.mockReturnValue(undefined);

        const result = await registered.run({ op: 'pause', workId: WORK_ID });

        expect(result).toMatchObject({
            status: 'skipped',
            reason: 'op_router_unavailable',
            missing: 'packages/agent/src/app-runtime/app-cluster-op.router.ts',
        });
        expect(loggerErrorMock).toHaveBeenCalled();
    });

    it('still names the router file when the context boots without it — when Nest THROWS for it, its real behaviour', async () => {
        appContext.get.mockImplementation(() => {
            // What Nest actually does for an absent provider; the case above
            // fakes `undefined`, which Nest never returns.
            throw new UnknownElementException('absent provider');
        });

        const result = await registered.run({ op: 'pause', workId: WORK_ID });

        expect(result).toMatchObject({
            status: 'skipped',
            reason: 'op_router_unavailable',
            missing: 'packages/agent/src/app-runtime/app-cluster-op.router.ts',
        });
        expect(loggerErrorMock).toHaveBeenCalled();
    });

    it('refuses in production when the worker is not attested isolated', async () => {
        const previous = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
            const result = await registered.run({ op: 'pause', workId: WORK_ID });

            expect(result).toMatchObject({ status: 'skipped', reason: 'worker_not_isolated' });
            expect(createApplicationContextMock).not.toHaveBeenCalled();
        } finally {
            process.env.NODE_ENV = previous;
        }
    });
});
