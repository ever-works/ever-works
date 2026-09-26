import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * APW-06 T32 (`tasks.md:556-573`) — **`app-deploy`**, its `onFailure` recovery, and the
 * `app-runtime:local-worker` entry point's production refusal.
 *
 * Four things are pinned here, and none of them is visible to `tsc`:
 *
 * 1. **The registration** — the id, the two-hour budget, `retry.maxAttempts: 1` and the
 *    `app-cluster-io` queue at concurrency 20 (plan §6.2:942, §9.2:1245). The registered params are
 *    captured through the SDK's own `task()` call, so the object under test is the one Trigger.dev
 *    would index — not a copy of it.
 * 2. **The composition** — every run boots `TriggerAppRuntimeModule` (T71), which is what arms
 *    T20's worker-context flag. Asserted by identity of the module handed to the context factory,
 *    because "it imports the module" and "it boots the module" are different claims.
 * 3. **`onFailure`'s two halves** — `ERROR (worker_failed)` on the row, and the deploy lock
 *    released **when the store is bound**; when it is not (T17 has not landed) the hook says
 *    `unbound` rather than implying a release that never happened.
 * 4. **The entry point's hard rule** — `NODE_ENV=production` exits non-zero **without** booting a
 *    context or binding a port.
 *
 * ## Why the modules are imported once, at the top
 *
 * `task()` registers when the module is evaluated, so `recorded` is the registration. A
 * `vi.resetModules()` would re-evaluate the task file — and hand it a **different**
 * `TriggerAppRuntimeModule` class than this file imported, which would make the identity assertion
 * in (2) compare two objects that were never meant to be equal. One import, one registration.
 */

const {
    taskMock,
    schedulesTaskMock,
    createApplicationContextMock,
    createTriggerLoggerMock,
    loggerErrorMock,
    loggerInfoMock,
    loggerWarnMock,
    recorded,
} = vi.hoisted(() => ({
    taskMock: vi.fn((params: unknown) => params),
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
    task: (params: Record<string, unknown>) => {
        recorded.push(params);
        return taskMock(params);
    },
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

// The real helper default-imports the whole worker module graph; its contract (boot the given
// module, name the logger, always close) is reproduced here against the mocked NestFactory — the
// same shape `skill-readiness-sweep.task.spec.ts` uses.
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

import { AppDeployOrchestrator } from '@ever-works/agent/app-runtime';
import { WorkDeploymentRepository } from '@ever-works/agent/database';
import { WORK_APP_RUNTIME_STATES } from '@ever-works/agent/app-launcher';
import {
    APP_DEPLOY_TASK_ID,
    appDeployTask,
    recoverFailedAppDeploy,
} from '../tasks/trigger/app-deploy.task';
// Importing the entry point also evaluates the four task files, which is what makes `recorded`
// hold all four registrations below.
import { APP_RUNTIME_LOCAL_TASK_IDS, main } from '../tasks/trigger/app-runtime-local-worker';
import { TriggerAppRuntimeModule } from '../trigger/worker/modules/trigger-app-runtime.module';

/** The params the SDK was handed for one task id. */
function registered(id: string): Record<string, any> {
    const params = recorded.find((entry) => entry.id === id);
    expect(params, `no task was registered with id "${id}"`).toBeDefined();
    return params as Record<string, any>;
}

describe('app-deploy (APW-06 T32)', () => {
    let runOrchestrator: ReturnType<typeof vi.fn>;
    let markTerminal: ReturnType<typeof vi.fn>;
    let releaseDeployLock: ReturnType<typeof vi.fn>;
    let appContext: {
        useLogger: ReturnType<typeof vi.fn>;
        get: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
    };
    let bound: {
        orchestrator: unknown;
        deployments: unknown;
        states: unknown;
    };

    const originalNodeEnv = process.env.NODE_ENV;
    const originalIsolated = process.env.EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED;

    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.NODE_ENV;
        delete process.env.EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED;

        // The real tokens, imported through their own barrels: a renamed token would make the task
        // ask the container for something this fake does not answer — which is the failure these
        // tests are supposed to catch, not hide.
        bound = {
            orchestrator: AppDeployOrchestrator,
            deployments: WorkDeploymentRepository,
            states: WORK_APP_RUNTIME_STATES,
        };

        runOrchestrator = vi.fn(async () => ({
            state: 'READY',
            outcome: 'succeeded',
            code: null,
            reason: null,
            deploymentId: 'deployment-1',
            warnings: [],
            lockReleased: true,
            queuedDeploymentId: null,
            queuedBuildId: null,
            upstreamVerdict: null,
            emitted: ['app.deploy.started', 'app.deploy.succeeded'],
        }));
        markTerminal = vi.fn(async () => undefined);
        releaseDeployLock = vi.fn(async () => true);

        const answers = new Map<unknown, unknown>([
            [bound.orchestrator, { run: runOrchestrator }],
            [bound.deployments, { markTerminal }],
            [bound.states, { releaseDeployLock }],
        ]);

        appContext = {
            useLogger: vi.fn(),
            get: vi.fn((token: unknown) => answers.get(token)),
            close: vi.fn(async () => undefined),
        };
        createApplicationContextMock.mockResolvedValue(appContext);
    });

    afterEach(() => {
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;
        if (originalIsolated === undefined)
            delete process.env.EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED;
        else process.env.EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED = originalIsolated;
    });

    it('declares the id, the two-hour budget and `retry.maxAttempts: 1`', () => {
        const cfg = registered('app-deploy');

        expect(cfg.id).toBe('app-deploy');
        expect(cfg.maxDuration).toBe(7200);
        expect(cfg.retry).toEqual({ maxAttempts: 1 });
        expect(APP_DEPLOY_TASK_ID).toBe('app-deploy');
        expect(appDeployTask.id).toBe('app-deploy');
    });

    it('declares the `app-cluster-io` queue at concurrency 20 (plan §6.2:942)', () => {
        expect(registered('app-deploy').queue).toEqual({
            name: 'app-cluster-io',
            concurrencyLimit: 20,
        });
    });

    it('boots TriggerAppRuntimeModule — which is what arms the worker-context flag', async () => {
        await registered('app-deploy').run({
            workId: 'work-1',
            deploymentId: 'deployment-1',
        });

        expect(createApplicationContextMock).toHaveBeenCalledWith(TriggerAppRuntimeModule);
        expect(createTriggerLoggerMock).toHaveBeenCalledWith('AppDeploy');
        expect(appContext.close).toHaveBeenCalled();
    });

    it('hands the orchestrator the whole payload and reports its outcome', async () => {
        const result = await registered('app-deploy').run({
            workId: 'work-1',
            deploymentId: 'deployment-1',
            trigger: 'manual',
            buildId: 'build-1',
            userId: 'user-1',
            headCommitSha: 'sha-1',
            skipPreDeployJobs: false,
            isRollback: false,
        });

        expect(runOrchestrator).toHaveBeenCalledWith({
            workId: 'work-1',
            deploymentId: 'deployment-1',
            trigger: 'manual',
            buildId: 'build-1',
            specCommitSha: null,
            userId: 'user-1',
            headCommitSha: 'sha-1',
            skipPreDeployJobs: false,
            isRollback: false,
            preview: null,
        });
        expect(result).toMatchObject({
            status: 'ran',
            workId: 'work-1',
            deploymentId: 'deployment-1',
            state: 'READY',
        });
    });

    it('refuses in production unless the worker isolation is attested, and boots nothing', async () => {
        process.env.NODE_ENV = 'production';

        const result = await registered('app-deploy').run({
            workId: 'work-1',
            deploymentId: 'deployment-1',
        });

        expect(result).toMatchObject({ status: 'skipped', reason: 'worker_not_isolated' });
        expect(createApplicationContextMock).not.toHaveBeenCalled();
        expect(runOrchestrator).not.toHaveBeenCalled();
    });

    it('runs in production once the attestation is set', async () => {
        process.env.NODE_ENV = 'production';
        process.env.EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED = 'true';

        const result = await registered('app-deploy').run({
            workId: 'work-1',
            deploymentId: 'deployment-1',
        });

        expect(result.status).toBe('ran');
        expect(createApplicationContextMock).toHaveBeenCalledWith(TriggerAppRuntimeModule);
    });

    it('reports `orchestratorUnavailable` rather than deploying nothing quietly', async () => {
        appContext.get.mockReturnValue(undefined);

        const result = await registered('app-deploy').run({
            workId: 'work-1',
            deploymentId: 'deployment-1',
        });

        expect(result).toMatchObject({ status: 'skipped', reason: 'orchestratorUnavailable' });
        expect(loggerErrorMock).toHaveBeenCalled();
    });

    it('reports `orchestratorUnavailable` when Nest THROWS for the absent provider — its real behaviour', async () => {
        // The case above mocks `get` returning `undefined`, which Nest never
        // does: `appContext.get(Token, { strict: false })` throws
        // `UnknownElementException` for a provider it does not have. That is
        // why this branch looked tested while being unreachable — the job
        // failed with Nest's generic "does not exist" instead of `skipped`.
        appContext.get.mockImplementation(() => {
            throw new UnknownElementException('AppDeployOrchestrator');
        });

        const result = await registered('app-deploy').run({
            workId: 'work-1',
            deploymentId: 'deployment-1',
        });

        expect(result).toMatchObject({ status: 'skipped', reason: 'orchestratorUnavailable' });
        expect(loggerErrorMock).toHaveBeenCalled();
    });

    it('onFailure marks ERROR (worker_failed) and releases the deploy lock', async () => {
        const onFailure = registered('app-deploy').onFailure;
        expect(typeof onFailure).toBe('function');

        await onFailure({
            payload: { workId: 'work-1', deploymentId: 'deployment-1' },
            error: new Error('the machine ran out of memory'),
        });

        expect(markTerminal).toHaveBeenCalledWith('deployment-1', 'ERROR', {
            lastError: 'worker_failed: the machine ran out of memory',
        });
        expect(releaseDeployLock).toHaveBeenCalledWith('work-1', 'deployment-1');
    });

    it('reports `unbound` for the lock when T17’s store is not bound', async () => {
        appContext.get.mockImplementation((token: unknown) =>
            token === bound.deployments ? { markTerminal } : undefined,
        );

        const recovered = await recoverFailedAppDeploy(
            { workId: 'work-1', deploymentId: 'deployment-1' },
            new Error('boom'),
        );

        // The row is still landed; the lock release is reported as the gap it is, never faked.
        expect(recovered).toEqual({ rowMarked: true, lockRelease: 'unbound' });
    });

    it('is best-effort: a payload without ids touches nothing', async () => {
        const recovered = await recoverFailedAppDeploy(undefined, new Error('boom'));

        expect(recovered).toEqual({ rowMarked: false, lockRelease: 'skipped' });
        expect(markTerminal).not.toHaveBeenCalled();
        expect(createApplicationContextMock).not.toHaveBeenCalled();
    });

    it('never throws out of onFailure, even when the row write rejects', async () => {
        markTerminal.mockRejectedValueOnce(new Error('the API is gone'));

        await expect(
            registered('app-deploy').onFailure({
                payload: { workId: 'work-1', deploymentId: 'deployment-1' },
                error: new Error('boom'),
            }),
        ).resolves.toBeUndefined();
    });

    /**
     * T32's last sentence: "the local-worker entry exits non-zero under `NODE_ENV=production`".
     *
     * `main()` returns the exit code instead of calling `process.exit`, so this spec can drive the
     * branch without killing the runner; the CLI shim at the bottom of the entry file is what turns
     * that code into the process's own exit status (verified by running the built script).
     */
    describe('app-runtime:local-worker', () => {
        it('exits non-zero under NODE_ENV=production, booting nothing and binding no port', async () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            process.env.NODE_ENV = 'production';

            const code = await main();

            expect(code).toBe(1);
            expect(createApplicationContextMock).not.toHaveBeenCalled();
            expect(String(errorSpy.mock.calls[0]?.[0])).toContain('refusing to start');
            expect(String(errorSpy.mock.calls[0]?.[0])).toContain('NODE_ENV=production');

            errorSpy.mockRestore();
        });

        it('exposes the four ids it drains, and they are the four registered tasks', () => {
            const registeredIds = recorded
                .map((entry) => entry.id)
                .filter((id): id is string => typeof id === 'string')
                .sort();

            expect([...APP_RUNTIME_LOCAL_TASK_IDS].sort()).toEqual([
                'app-cluster-op',
                'app-deploy',
                'app-health-poll',
                'app-smoke',
            ]);
            expect([...APP_RUNTIME_LOCAL_TASK_IDS].sort()).toEqual(registeredIds);
        });
    });
});
