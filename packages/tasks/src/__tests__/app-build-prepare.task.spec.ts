import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * APW-05 T19 — **`app-build-prepare`**, until now the one App Works job with no
 * spec at all.
 *
 * The file is deliberately thin (every step is `AppBuildPrepareRunner.run`'s), so
 * what is pinned is what the thin layer owns:
 *
 *   1. **the registration** — the id the dispatcher enqueues under, the 300 s
 *      budget (the §7.2 lock's lease) and the retry registration, which only
 *      covers what escapes the run body's catch;
 *   2. **the RPC seam** — the worker proxies exactly the name the API's
 *      `remoteMap` must publish (`AppBuildPrepareRunner`), read off the worker
 *      module's own factory so a rename reddens here;
 *   3. **what a run reports** — the runner's OWN outcome (prepared, skipped,
 *      failed; anything unrecognised fails closed), an unusable payload, and a
 *      rejected RPC, each named.
 *
 * Not pinned: the `runnerUnavailable` branch. The module handed to
 * `withWorkerContext` always binds the seam to a remote proxy, so that branch
 * cannot be reached by the real composition; a missing API-side registration
 * shows up as a REJECTED call instead, which is the last case here.
 */

const {
    taskMock,
    createRemoteProxyMock,
    loggerErrorMock,
    loggerInfoMock,
    loggerWarnMock,
    recorded,
    contextHolder,
} = vi.hoisted(() => ({
    taskMock: vi.fn((params: unknown) => params),
    createRemoteProxyMock: vi.fn(() => ({ run: vi.fn() })),
    loggerErrorMock: vi.fn(),
    loggerInfoMock: vi.fn(),
    loggerWarnMock: vi.fn(),
    recorded: [] as Array<Record<string, unknown>>,
    // The `vi.mock` factories are hoisted above every `let`, so the context
    // they hand to the run body lives in a hoisted box.
    contextHolder: { current: undefined as unknown },
}));

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

// Mocked only so the worker module's factory can be called with a fake client
// and the provider NAME it forwards to can be read. The real proxy is covered by
// `__tests__/remote-proxy.spec.ts`.
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
    APP_BUILD_PREPARE_RUNNER_SEAM,
    APP_BUILD_PREPARE_TASK_ID,
    AppBuildPrepareWorkerModule,
    appBuildPrepareTask,
    runAppBuildPrepareTask,
} from '../tasks/trigger/app-build-prepare.task';

const registered = recorded.find((entry) => entry.id === APP_BUILD_PREPARE_TASK_ID) as Record<
    string,
    any
>;

const WORK_ID = '0b1c2d3e-4444-4555-8666-777788889999';

/** The runner's real result shape (`AppBuildPrepareRunResult`), a prepared pass. */
const PREPARED_RESULT = {
    status: 'prepared',
    jobId: 'app-build-prepare',
    workId: WORK_ID,
    reason: null,
    passes: 1,
    coalesced: false,
    prepared: true,
    workflowState: 'current',
    secretsSynced: true,
    buildsDispatched: 1,
    buildsBlocked: 0,
    error: null,
};

describe('app-build-prepare (APW-05 T19)', () => {
    let run: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        // The runner's real result shape (`AppBuildPrepareRunResult`).
        run = vi.fn(async () => PREPARED_RESULT);
        contextHolder.current = {
            useLogger: vi.fn(),
            get: vi.fn((token: unknown) =>
                token === APP_BUILD_PREPARE_RUNNER_SEAM ? { run } : undefined,
            ),
        };
    });

    it('registers its id, the lock-length budget and the retry registration', () => {
        expect(registered).toBeDefined();
        expect(appBuildPrepareTask.id).toBe('app-build-prepare');
        // `maxDuration` is the §7.2 lock's 5-minute lease. `retry` only covers
        // what escapes the run body's catch — see the task header's "Budget".
        expect(registered.maxDuration).toBe(300);
        expect(registered.retry).toEqual({ maxAttempts: 3 });
    });

    it('proxies AppBuildPrepareRunner — the name the API’s remoteMap must publish', () => {
        const providers =
            (Reflect.getMetadata('providers', AppBuildPrepareWorkerModule) as Array<{
                provide?: unknown;
                useFactory?: (client: unknown) => unknown;
            }>) ?? [];
        const seam = providers.find(
            (provider) => provider.provide === APP_BUILD_PREPARE_RUNNER_SEAM,
        );

        expect(seam).toBeDefined();
        const client = { callRemote: vi.fn() };
        seam?.useFactory?.(client);
        expect(createRemoteProxyMock).toHaveBeenCalledWith(client, 'AppBuildPrepareRunner');
    });

    it('forwards the Work and reason to the runner and reports what it prepared', async () => {
        const result = await registered.run({ workId: WORK_ID, reason: 'envChanged' });

        expect(run).toHaveBeenCalledWith({ workId: WORK_ID, reason: 'envChanged' });
        expect(result).toEqual({
            status: 'prepared',
            jobId: 'app-build-prepare',
            workId: WORK_ID,
            reason: 'envChanged',
            error: null,
            result: PREPARED_RESULT,
        });
    });

    it('defaults a missing reason to specApplied', async () => {
        await registered.run({ workId: WORK_ID });

        expect(run).toHaveBeenCalledWith({ workId: WORK_ID, reason: 'specApplied' });
    });

    it('refuses a payload with no Work, before the context is even booted', async () => {
        const result = await runAppBuildPrepareTask({ workId: '', reason: 'rebuild' });

        expect(result).toMatchObject({
            status: 'skipped',
            workId: null,
            reason: 'invalid_payload',
        });
        expect(run).not.toHaveBeenCalled();
        expect(loggerInfoMock).not.toHaveBeenCalledWith('context:AppBuildPrepare');
    });

    it('reports a rejected RPC as failed with the transport’s own message — and does not throw', async () => {
        // The production shape of a missing API-side registration. The run
        // RETURNS the failure rather than throwing it, so the runtime does not
        // retry it — DELIBERATELY (decided 2026-09-24, see the task header's
        // "Budget"): every runner throw arrives as the same detail-less 500, and a
        // blanket rethrow could re-dispatch a Build whose GitHub run already
        // started.
        run.mockRejectedValue(new Error('Unknown remote target: AppBuildPrepareRunner'));

        const result = await registered.run({ workId: WORK_ID, reason: 'rebuild' });

        expect(result).toEqual({
            status: 'failed',
            jobId: 'app-build-prepare',
            workId: WORK_ID,
            reason: 'prepareFailed',
            error: 'Unknown remote target: AppBuildPrepareRunner',
            result: null,
        });
        expect(loggerErrorMock).toHaveBeenCalled();
    });

    /**
     * The runner names its own outcome, and a pass that did nothing is not a
     * prepare. The task used to wrap EVERY runner answer as `status: 'prepared'`,
     * so `skipped: locked` (another pass holds the lock) and `pluginUnavailable`
     * (no binding can prepare the repository — where a pass that gets that far
     * stops today) read as green runs.
     */
    it.each(['locked', 'pluginUnavailable', 'nothingToPrepare'])(
        'reports a runner skip (%s) as a skipped run with the runner’s reason, passing its result through',
        async (skip) => {
            const skipped = { ...PREPARED_RESULT, status: 'skipped', reason: skip, passes: 0 };
            run.mockResolvedValue(skipped);

            const result = await registered.run({ workId: WORK_ID, reason: 'rebuild' });

            expect(result).toEqual({
                status: 'skipped',
                jobId: 'app-build-prepare',
                workId: WORK_ID,
                reason: skip,
                error: null,
                result: skipped,
            });
            expect(loggerWarnMock).toHaveBeenCalled();
        },
    );

    // `failed` is in the runner's result type though it throws today; honoured
    // if it ever arrives, and logged as an error.
    it('reports a runner-reported failure as failed, with its reason and error', async () => {
        run.mockResolvedValue({
            status: 'failed',
            reason: null,
            error: 'db down',
            workId: WORK_ID,
        });

        const result = await registered.run({ workId: WORK_ID, reason: 'rebuild' });

        expect(result).toMatchObject({
            status: 'failed',
            reason: 'prepareFailed',
            error: 'db down',
        });
    });

    it('still reports a runner answer that says it prepared as prepared, with the dispatch reason', async () => {
        run.mockResolvedValue({ status: 'prepared', reason: null, workId: WORK_ID, passes: 1 });

        const result = await registered.run({ workId: WORK_ID, reason: 'envChanged' });

        expect(result).toMatchObject({ status: 'prepared', reason: 'envChanged', error: null });
    });

    it('fails CLOSED on a runner answer with no recognised status', async () => {
        run.mockResolvedValue({ workId: WORK_ID, prepared: true });

        const result = await registered.run({ workId: WORK_ID, reason: 'rebuild' });

        expect(result).toMatchObject({
            status: 'failed',
            reason: 'unrecognisedRunnerResult',
            error: expect.stringContaining('without a recognised status'),
        });
        expect(loggerErrorMock).toHaveBeenCalled();
    });

    it('pins the runner’s swallowed-dispatch answer: prepared, with nothing dispatched', async () => {
        // The runner swallows a failed `startBuild` and reports the pass
        // `prepared` with `buildsDispatched: 0` — so a §9.2 dispatch failure is
        // NOT a failed run. Pinned as it is; the fix belongs in the runner (see
        // the task header's routed finding).
        const swallowed = { ...PREPARED_RESULT, buildsDispatched: 0 };
        run.mockResolvedValue(swallowed);

        const result = await registered.run({ workId: WORK_ID, reason: 'rebuild' });

        expect(result).toMatchObject({ status: 'prepared', result: swallowed });
    });
});
