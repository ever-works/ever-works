import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * APW-05 T20 — **`app-build-watch`**, until now without a spec.
 *
 * Thin like its sibling `app-build-prepare`: every observation step is
 * `AppBuildWatchRunner.run`'s. Pinned is what the thin layer owns — the
 * registration (id, the 120 s budget that is §7.3's lease, 2 attempts), the RPC
 * name the API's `remoteMap` must publish, and what each kind of run reports.
 *
 * Not pinned: the `runnerUnavailable` branch, which the real composition cannot
 * reach (the seam is always bound to a remote proxy); a missing API-side
 * registration is a REJECTED call. Runner failures are reported, not retried;
 * the planned §7.4 sweep (not landed as of 2026-09-24) is the intended backstop.
 */

const {
    taskMock,
    createRemoteProxyMock,
    loggerErrorMock,
    loggerInfoMock,
    recorded,
    contextHolder,
} = vi.hoisted(() => ({
    taskMock: vi.fn((params: unknown) => params),
    createRemoteProxyMock: vi.fn(() => ({ run: vi.fn() })),
    loggerErrorMock: vi.fn(),
    loggerInfoMock: vi.fn(),
    recorded: [] as Array<Record<string, unknown>>,
    contextHolder: { current: undefined as unknown },
}));

vi.mock('@trigger.dev/sdk', () => ({
    task: (params: Record<string, unknown>) => {
        recorded.push(params);
        return taskMock(params);
    },
    logger: {
        info: loggerInfoMock,
        warn: vi.fn(),
        error: loggerErrorMock,
        debug: vi.fn(),
        log: vi.fn(),
    },
}));

vi.mock('../trigger/worker/remote-proxy', () => ({
    createRemoteProxy: createRemoteProxyMock,
}));

vi.mock('../trigger/worker/utils/worker-context.utils', () => ({
    withWorkerContext: async (loggerName: string, fn: (ctx: unknown) => Promise<unknown>) => {
        loggerInfoMock(`context:${loggerName}`);
        return fn(contextHolder.current);
    },
}));

import {
    APP_BUILD_WATCH_RUNNER_SEAM,
    APP_BUILD_WATCH_TASK_ID,
    AppBuildWatchWorkerModule,
    appBuildWatchTask,
    runAppBuildWatchTask,
} from '../tasks/trigger/app-build-watch.task';

const registered = recorded.find((entry) => entry.id === APP_BUILD_WATCH_TASK_ID) as Record<
    string,
    any
>;

const BUILD_ID = '9a8b7c6d-1111-4222-8333-444455556666';

/** The runner's real result shape (`AppBuildWatchRunResult`), an observation. */
const OBSERVED_RESULT = {
    status: 'observed',
    jobId: 'app-build-watch',
    buildId: BUILD_ID,
    reason: null,
    observedStatus: 'running',
    started: false,
    restamped: false,
    finalised: false,
    error: null,
};

describe('app-build-watch (APW-05 T20)', () => {
    let run: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        // The runner's real result shape (`AppBuildWatchRunResult`).
        run = vi.fn(async () => OBSERVED_RESULT);
        contextHolder.current = {
            useLogger: vi.fn(),
            get: vi.fn((token: unknown) =>
                token === APP_BUILD_WATCH_RUNNER_SEAM ? { run } : undefined,
            ),
        };
    });

    it('registers its id, the lease-length budget and 2 attempts', () => {
        expect(registered).toBeDefined();
        expect(appBuildWatchTask.id).toBe('app-build-watch');
        // §7.3's lease is two minutes; a run may not outlive the lease it holds.
        expect(registered.maxDuration).toBe(120);
        expect(registered.retry).toEqual({ maxAttempts: 2 });
    });

    it('proxies AppBuildWatchRunner — the name the API’s remoteMap must publish', () => {
        const providers =
            (Reflect.getMetadata('providers', AppBuildWatchWorkerModule) as Array<{
                provide?: unknown;
                useFactory?: (client: unknown) => unknown;
            }>) ?? [];
        const seam = providers.find((provider) => provider.provide === APP_BUILD_WATCH_RUNNER_SEAM);

        expect(seam).toBeDefined();
        const client = { callRemote: vi.fn() };
        seam?.useFactory?.(client);
        expect(createRemoteProxyMock).toHaveBeenCalledWith(client, 'AppBuildWatchRunner');
    });

    it('forwards the Build and reason to the runner and reports the observation', async () => {
        const result = await registered.run({ buildId: BUILD_ID, reason: 'sweep' });

        expect(run).toHaveBeenCalledWith({ buildId: BUILD_ID, reason: 'sweep' });
        expect(result).toEqual({
            status: 'observed',
            jobId: 'app-build-watch',
            buildId: BUILD_ID,
            reason: 'sweep',
            error: null,
            result: OBSERVED_RESULT,
        });
    });

    it('defaults a missing reason to event', async () => {
        await registered.run({ buildId: BUILD_ID });

        expect(run).toHaveBeenCalledWith({ buildId: BUILD_ID, reason: 'event' });
    });

    it('refuses a payload with no Build, before the context is even booted', async () => {
        const result = await runAppBuildWatchTask({ buildId: '', reason: 'event' });

        expect(result).toMatchObject({
            status: 'skipped',
            buildId: null,
            reason: 'invalid_payload',
        });
        expect(run).not.toHaveBeenCalled();
        expect(loggerInfoMock).not.toHaveBeenCalledWith('context:AppBuildWatch');
    });

    it('reports a rejected RPC as failed with the transport’s own message', async () => {
        run.mockRejectedValue(new Error('Unknown remote target: AppBuildWatchRunner'));

        const result = await registered.run({ buildId: BUILD_ID, reason: 'dispatched' });

        expect(result).toEqual({
            status: 'failed',
            jobId: 'app-build-watch',
            buildId: BUILD_ID,
            reason: 'watchFailed',
            error: 'Unknown remote target: AppBuildWatchRunner',
            result: null,
        });
        expect(loggerErrorMock).toHaveBeenCalled();
    });

    /**
     * The watch runner names its own outcome too. The task used to report every
     * answer as `observed`, so a `leaseHeld` or `concurrencyLimited` pass — one
     * that observed nothing — read as green.
     */
    it.each(['leaseHeld', 'concurrencyLimited'])(
        'reports a runner skip (%s) as a skipped run with the runner’s reason',
        async (skip) => {
            const skipped = {
                ...OBSERVED_RESULT,
                status: 'skipped',
                reason: skip,
                observedStatus: null,
            };
            run.mockResolvedValue(skipped);

            const result = await registered.run({ buildId: BUILD_ID, reason: 'sweep' });

            expect(result).toEqual({
                status: 'skipped',
                jobId: 'app-build-watch',
                buildId: BUILD_ID,
                reason: skip,
                error: null,
                result: skipped,
            });
        },
    );

    it('fails CLOSED on a runner answer with no recognised status', async () => {
        run.mockResolvedValue({ buildId: BUILD_ID, status: 'running' });

        const result = await registered.run({ buildId: BUILD_ID, reason: 'event' });

        expect(result).toMatchObject({ status: 'failed', reason: 'unrecognisedRunnerResult' });
        expect(loggerErrorMock).toHaveBeenCalled();
    });
});
