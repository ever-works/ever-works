import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * APW-06 T32 + T70 — **`app-smoke`**, the on-demand smoke run (plan §5.7, §9.2:1246).
 *
 * T71's landing wrote this task to refuse by name (`smoke_service_unavailable`) because T70's
 * service was not in the tree. T70 landed, so the task now delegates: this spec pins the
 * delegation, §9.2's registration, and the two refusals the task still owns (no Work, and the
 * isolation gate). The refusal path is pinned as what it now is — a fallback for a context that
 * boots without the service — and the `passed` flag is pinned because a green task result over a red
 * smoke run is exactly the silent no-op this programme forbids.
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

import { AppSmokeService } from '@ever-works/agent/app-runtime';
import { APP_SMOKE_TASK_ID, appSmokeTask } from '../tasks/trigger/app-smoke.task';
import {
    APP_RUNTIME_TASK_QUEUE,
    TriggerAppRuntimeModule,
} from '../trigger/worker/modules/trigger-app-runtime.module';

const registered = recorded.find((entry) => entry.id === APP_SMOKE_TASK_ID) as Record<string, any>;

const WORK_ID = '0f8e2c1a-1111-4a2b-9c3d-4e5f60718293';
const DEPLOYMENT_ID = 'dep-1111';

const RUN_RESULT = {
    state: 'done',
    code: null,
    workId: WORK_ID,
    deploymentId: DEPLOYMENT_ID,
    passed: true,
    record: { inCluster: [], public: [], observedAt: '2026-09-18T10:00:00.000Z' },
    publicOutcome: 'passed',
    healthRelevant: false,
    smokeResultWritten: 'written',
    events: 'emitted',
    detail: { checks: 2 },
};

describe('app-smoke (APW-06 T32 + T70)', () => {
    let run: ReturnType<typeof vi.fn>;
    let appContext: {
        useLogger: ReturnType<typeof vi.fn>;
        get: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        vi.clearAllMocks();

        run = vi.fn(async () => ({ ...RUN_RESULT }));

        appContext = {
            useLogger: vi.fn(),
            get: vi.fn((token: unknown) => (token === AppSmokeService ? { run } : undefined)),
            close: vi.fn(async () => undefined),
        };
        createApplicationContextMock.mockResolvedValue(appContext);
    });

    it('registers the task on §9.2’s id, queue and budget', () => {
        expect(registered).toBeDefined();
        expect(appSmokeTask.id).toBe(APP_SMOKE_TASK_ID);
        expect(registered.queue).toEqual({ name: 'app-cluster-io', concurrencyLimit: 20 });
        expect(registered.queue).toEqual(APP_RUNTIME_TASK_QUEUE);
        expect(registered.maxDuration).toBe(900);
    });

    it('boots TriggerAppRuntimeModule and delegates to the service it resolves', async () => {
        const result = await registered.run({
            workId: WORK_ID,
            deploymentId: DEPLOYMENT_ID,
            trigger: 'manual',
            userId: 'user-1',
        });

        expect(createApplicationContextMock).toHaveBeenCalledWith(TriggerAppRuntimeModule);
        expect(createTriggerLoggerMock).toHaveBeenCalledWith('AppSmoke');
        expect(run).toHaveBeenCalledWith({
            workId: WORK_ID,
            deploymentId: DEPLOYMENT_ID,
            trigger: 'manual',
            userId: 'user-1',
        });
        expect(result).toMatchObject({
            status: 'ran',
            workId: WORK_ID,
            deploymentId: DEPLOYMENT_ID,
            passed: true,
            reason: null,
            missing: null,
        });
        expect(appContext.close).toHaveBeenCalled();
    });

    it('reports a red smoke run as a completed run, with `passed: false`', async () => {
        run.mockResolvedValue({ ...RUN_RESULT, passed: false, code: 'smoke_failed' });

        const result = await registered.run({ workId: WORK_ID });

        expect(result.status).toBe('ran');
        expect(result.passed).toBe(false);
        expect(result.reason).toBeNull();
    });

    it('reports the service’s refusal as `skipped` with its own code', async () => {
        run.mockResolvedValue({
            ...RUN_RESULT,
            state: 'refused',
            code: 'deployment_not_found',
            deploymentId: null,
            passed: false,
        });

        const result = await registered.run({ workId: WORK_ID });

        expect(result).toMatchObject({
            status: 'skipped',
            reason: 'deployment_not_found',
            missing: null,
        });
    });

    it('refuses a payload with no Work', async () => {
        const result = await registered.run({ workId: '' });

        expect(result).toMatchObject({ status: 'skipped', reason: 'invalid_payload' });
        expect(run).not.toHaveBeenCalled();
    });

    it('still names the service file when the context boots without it', async () => {
        appContext.get.mockReturnValue(undefined);

        const result = await registered.run({ workId: WORK_ID });

        expect(result).toMatchObject({
            status: 'skipped',
            reason: 'smoke_service_unavailable',
            missing: 'packages/agent/src/app-runtime/app-smoke.service.ts',
        });
        expect(loggerErrorMock).toHaveBeenCalled();
    });

    it('still names the service file when the context boots without it — when Nest THROWS for it, its real behaviour', async () => {
        appContext.get.mockImplementation(() => {
            // What Nest actually does for an absent provider; the case above
            // fakes `undefined`, which Nest never returns.
            throw new UnknownElementException('absent provider');
        });

        const result = await registered.run({ workId: WORK_ID });

        expect(result).toMatchObject({
            status: 'skipped',
            reason: 'smoke_service_unavailable',
            missing: 'packages/agent/src/app-runtime/app-smoke.service.ts',
        });
        expect(loggerErrorMock).toHaveBeenCalled();
    });

    it('refuses in production when the worker is not attested isolated', async () => {
        const previous = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
            const result = await registered.run({ workId: WORK_ID });

            expect(result).toMatchObject({ status: 'skipped', reason: 'worker_not_isolated' });
            expect(createApplicationContextMock).not.toHaveBeenCalled();
        } finally {
            process.env.NODE_ENV = previous;
        }
    });
});
