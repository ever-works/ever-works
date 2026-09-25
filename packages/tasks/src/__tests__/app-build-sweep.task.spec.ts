import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnknownElementException } from '@nestjs/core/errors/exceptions/unknown-element.exception';
import { APP_BUILD_SWEEP_CRON } from '@ever-works/contracts';

/**
 * APW-05 T21 (first slice) — **`app-build-sweep`**, the two-minute schedule of
 * plan §7.4.
 *
 * The file is deliberately thin — every pass is `AppBuildSweepService.runSweep`'s,
 * API-side, under its own `app-builds:sweep` lock — so what is pinned is what the
 * thin layer owns:
 *
 *   1. **the registration** — the id, the SAME cron the API's fallback uses
 *      (`APP_BUILD_SWEEP_CRON`, so the two schedules can never drift) and a
 *      budget no longer than one tick;
 *   2. **the RPC seam** — the worker proxies exactly the name the API's
 *      `remoteMap` must publish (`AppBuildSweepService`), read off the worker
 *      module's own factory so a rename reddens here;
 *   3. **what a tick reports** — the service's own summary (swept, or skipped
 *      with its reason), a rejected RPC returned rather than thrown (the next
 *      tick is the retry), an unreadable answer failing closed, and a context
 *      without the seam named rather than hidden.
 */

const {
    schedulesTaskMock,
    createRemoteProxyMock,
    loggerErrorMock,
    loggerInfoMock,
    loggerWarnMock,
    recorded,
    contextHolder,
} = vi.hoisted(() => ({
    schedulesTaskMock: vi.fn((params: unknown) => params),
    createRemoteProxyMock: vi.fn(() => ({ runSweep: vi.fn() })),
    loggerErrorMock: vi.fn(),
    loggerInfoMock: vi.fn(),
    loggerWarnMock: vi.fn(),
    recorded: [] as Array<Record<string, unknown>>,
    // The `vi.mock` factories are hoisted above every `let`, so the context
    // they hand to the run body lives in a hoisted box.
    contextHolder: { current: undefined as unknown, module: undefined as unknown },
}));

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

// Mocked only so the worker module's factory can be called with a fake client
// and the provider NAME it forwards to can be read. The real proxy is covered by
// `__tests__/remote-proxy.spec.ts`.
vi.mock('../trigger/worker/remote-proxy', () => ({
    createRemoteProxy: createRemoteProxyMock,
}));

vi.mock('../trigger/worker/utils/worker-context.utils', () => ({
    withWorkerContext: async (
        loggerName: string,
        fn: (ctx: unknown) => Promise<unknown>,
        module: unknown,
    ) => {
        loggerInfoMock(`context:${loggerName}`);
        contextHolder.module = module;
        return fn(contextHolder.current);
    },
}));

import {
    APP_BUILD_SWEEP_SEAM,
    APP_BUILD_SWEEP_TASK_CRON,
    APP_BUILD_SWEEP_TASK_ID,
    AppBuildSweepWorkerModule,
    appBuildSweepTask,
    runAppBuildSweepTask,
} from '../tasks/trigger/app-build-sweep.task';

const registered = recorded.find((entry) => entry.id === APP_BUILD_SWEEP_TASK_ID) as Record<
    string,
    any
>;

/** `AppBuildSweepService.runSweep`'s real summary shape — a tick that re-drove one Work. */
const SWEPT = {
    skipped: null,
    passesFailed: 0,
    redriveBuilds: 1,
    redriveWorks: 1,
    redriveRequested: 1,
    redriveFailed: 0,
    lostCandidates: 0,
    lostMarked: 0,
    lostFinalized: 0,
    lostFailed: 0,
};

describe('app-build-sweep (APW-05 T21)', () => {
    let runSweep: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        runSweep = vi.fn(async () => SWEPT);
        contextHolder.current = {
            useLogger: vi.fn(),
            get: vi.fn((token: unknown) => {
                if (token === APP_BUILD_SWEEP_SEAM) return { runSweep };
                throw new UnknownElementException(String(token));
            }),
        };
    });

    it('registers its id on the shared sweep cron, with a budget of one tick', () => {
        expect(registered).toBeDefined();
        expect(appBuildSweepTask.id).toBe('app-build-sweep');
        // The Trigger.dev schedule and the API's `@Cron` fallback read the same
        // constant, so exactly one of them runs the pass on the same cadence.
        expect(APP_BUILD_SWEEP_CRON).toBe('*/2 * * * *');
        expect(APP_BUILD_SWEEP_TASK_CRON).toBe(APP_BUILD_SWEEP_CRON);
        expect(registered.cron).toBe(APP_BUILD_SWEEP_CRON);
        expect(registered.maxDuration).toBe(120);
    });

    it('proxies AppBuildSweepService — the name the API’s remoteMap must publish', () => {
        const providers =
            (Reflect.getMetadata('providers', AppBuildSweepWorkerModule) as Array<{
                provide?: unknown;
                useFactory?: (client: unknown) => unknown;
            }>) ?? [];
        const seam = providers.find((provider) => provider.provide === APP_BUILD_SWEEP_SEAM);

        expect(seam).toBeDefined();
        const client = { callRemote: vi.fn() };
        seam?.useFactory?.(client);
        expect(createRemoteProxyMock).toHaveBeenCalledWith(client, 'AppBuildSweepService');
    });

    it('calls runSweep once with no argument — the API reads its own clock — and reports the summary', async () => {
        const result = await registered.run({ timestamp: new Date(), scheduleId: 'sched_1' });

        expect(runSweep).toHaveBeenCalledTimes(1);
        expect(runSweep).toHaveBeenCalledWith();
        expect(contextHolder.module).toBe(AppBuildSweepWorkerModule);
        expect(result).toEqual({
            status: 'swept',
            jobId: 'app-build-sweep',
            reason: null,
            error: null,
            summary: SWEPT,
        });
        expect(loggerInfoMock).toHaveBeenCalledWith(
            'app-build-sweep finished',
            expect.objectContaining({ redriveRequested: 1 }),
        );
    });

    it.each(['locked', 'lockUnavailable'])(
        'reports a tick the service skipped (%s) as skipped, with its reason',
        async (skip) => {
            const skipped = {
                ...SWEPT,
                skipped: skip,
                redriveBuilds: 0,
                redriveWorks: 0,
                redriveRequested: 0,
            };
            runSweep.mockResolvedValue(skipped);

            const result = await runAppBuildSweepTask();

            expect(result).toEqual({
                status: 'skipped',
                jobId: 'app-build-sweep',
                reason: skip,
                error: null,
                summary: skipped,
            });
        },
    );

    it('returns a rejected RPC as failed rather than throwing it — the next tick is the retry', async () => {
        runSweep.mockRejectedValue(new Error('Unknown remote target: AppBuildSweepService'));

        const result = await runAppBuildSweepTask();

        expect(result).toEqual({
            status: 'failed',
            jobId: 'app-build-sweep',
            reason: 'sweepFailed',
            error: 'Unknown remote target: AppBuildSweepService',
            summary: null,
        });
        expect(loggerErrorMock).toHaveBeenCalled();
    });

    it('fails CLOSED on an answer that is not a sweep summary', async () => {
        runSweep.mockResolvedValue({ ok: true });

        const result = await runAppBuildSweepTask();

        expect(result).toMatchObject({
            status: 'failed',
            reason: 'unrecognisedSweepResult',
            summary: null,
        });
        expect(loggerErrorMock).toHaveBeenCalled();
    });

    it('names a worker context without the seam instead of pretending a tick ran', async () => {
        contextHolder.current = {
            useLogger: vi.fn(),
            get: vi.fn((token: unknown) => {
                throw new UnknownElementException(String(token));
            }),
        };

        const result = await runAppBuildSweepTask();

        expect(result).toEqual({
            status: 'skipped',
            jobId: 'app-build-sweep',
            reason: 'runnerUnavailable',
            error: null,
            summary: null,
        });
        expect(runSweep).not.toHaveBeenCalled();
        expect(loggerErrorMock).toHaveBeenCalled();
    });
});
