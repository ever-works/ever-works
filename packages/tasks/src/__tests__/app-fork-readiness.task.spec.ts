import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * C10 — **`app-fork-readiness`**, the readiness run of one App Work (APW-02 plan §6.2,
 * `plan.md:664-670`).
 *
 * Three things are pinned, and they are the three ways this job can be silently
 * useless rather than loudly broken:
 *
 *   1. **the registration** — the id the dispatcher enqueues under, and §6.2's
 *      `maxDuration: 1_200` (twenty minutes against FR-18's fifteen-minute deadline);
 *   2. **the RPC seam** — the worker proxies exactly the name the API's `remoteMap`
 *      publishes (`AppForkReadinessRunner`), because `AppForkReadinessService.run` takes
 *      a `deps.sleep` FUNCTION and functions do not survive SuperJSON
 *      (`remote-proxy.ts:93-96`). The name is read off the worker module's own factory,
 *      so a rename on the worker side reddens here rather than on the run that needed it;
 *   3. **the refusals are named** — a missing seam is `runnerUnavailable`, an unusable
 *      payload is `invalid_payload`, and a rejecting RPC is `readinessFailed` with the
 *      transport's own message. None of them is a green result: a readiness job that
 *      reports success without reading the state row is the silent no-op this
 *      programme forbids.
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
    // The fake worker context, held in a hoisted box: the `vi.mock` factory below is
    // hoisted above every `let` in this file, so the context it hands to the run body
    // has to live in something the factory can reach at call time.
    contextHolder: { current: undefined as unknown },
}));

import { UnknownElementException } from '@nestjs/core/errors/exceptions/unknown-element.exception';

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

// The proxy is mocked for ONE reason: so the worker module's factory can be called with
// a fake client and the provider NAME it forwards to can be read. The real
// `createRemoteProxy` is exercised by `__tests__/remote-proxy.spec.ts`.
vi.mock('../trigger/worker/remote-proxy', () => ({
    createRemoteProxy: createRemoteProxyMock,
}));

vi.mock('../trigger/worker/utils/worker-context.utils', () => ({
    withWorkerContext: async (
        loggerName: string,
        fn: (ctx: unknown) => Promise<unknown>,
        _module: unknown,
    ) => {
        loggerInfoMock(`context:${loggerName}`);
        return fn(contextHolder.current);
    },
}));

import {
    APP_FORK_READINESS_RUNNER_SEAM,
    APP_FORK_READINESS_TASK_ID,
    AppForkReadinessWorkerModule,
    appForkReadinessTask,
    runAppForkReadinessTask,
} from '../tasks/trigger/app-fork-readiness.task';

const registered = recorded.find((entry) => entry.id === APP_FORK_READINESS_TASK_ID) as Record<
    string,
    any
>;

const WORK_ID = '0b1c2d3e-4444-4555-8666-777788889999';

/** The fake worker context: `get` answers the seam the module binds. */
let appContext: { useLogger: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };

describe('app-fork-readiness (C10)', () => {
    let run: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();

        run = vi.fn(async () => ({
            workId: WORK_ID,
            attempt: 1,
            outcome: 'ready',
            probes: 1,
            sleeps: [2_000],
            elapsedMs: 2_000,
        }));

        appContext = {
            useLogger: vi.fn(),
            get: vi.fn((token: unknown) =>
                token === APP_FORK_READINESS_RUNNER_SEAM ? { run } : undefined,
            ),
        };
        contextHolder.current = appContext;
    });

    it('registers §6.2’s id and budget', () => {
        expect(registered).toBeDefined();
        expect(appForkReadinessTask.id).toBe(APP_FORK_READINESS_TASK_ID);
        expect(APP_FORK_READINESS_TASK_ID).toBe('app-fork-readiness');
        // `plan.md:666` — 1 200 s (20 min) against FR-18's 15-minute deadline, so the
        // platform never kills a run that is still inside its own timeout.
        expect(registered.maxDuration).toBe(1_200);
    });

    it('proxies AppForkReadinessRunner — the name the API’s remoteMap publishes', () => {
        const providers =
            (Reflect.getMetadata('providers', AppForkReadinessWorkerModule) as Array<{
                provide?: unknown;
                useFactory?: (client: unknown) => unknown;
                inject?: unknown[];
            }>) ?? [];
        const seamBinding = providers.find(
            (provider) => provider.provide === APP_FORK_READINESS_RUNNER_SEAM,
        );

        expect(seamBinding).toBeDefined();
        const client = { callRemote: vi.fn() };
        seamBinding?.useFactory?.(client);
        // A rename here (or in the controller's `remoteMap`) is otherwise discovered by
        // the run that needed the result — `Unknown remote target: …` at 3 a.m.
        expect(createRemoteProxyMock).toHaveBeenCalledWith(client, 'AppForkReadinessRunner');
    });

    it('forwards the plan’s payload to the runner and reports the service’s own outcome', async () => {
        const result = await registered.run({
            workId: WORK_ID,
            attempt: 2,
            reason: 'retry',
            providerId: 'github',
            credentialVersion: 3,
        });

        expect(run).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledWith({
            workId: WORK_ID,
            attempt: 2,
            reason: 'retry',
            providerId: 'github',
            credentialVersion: 3,
        });
        expect(result).toMatchObject({
            status: 'ran',
            jobId: 'app-fork-readiness',
            workId: WORK_ID,
            outcome: 'ready',
            reason: null,
            error: null,
        });
    });

    it('defaults the attempt and omits a reason the plan did not send', async () => {
        await registered.run({ workId: WORK_ID });

        // `reason` is absent, NOT `reason: undefined` — the dispatcher's payload is what
        // the row's `readinessReason` is read back as, and an explicit undefined key is
        // not the same message as no key at all over SuperJSON.
        expect(run).toHaveBeenCalledWith({ workId: WORK_ID, attempt: 1 });
    });

    it('reports a timed-out attempt as a completed RUN, with the service’s reason', async () => {
        // FR-18: the deadline passing is an OUTCOME the row records (`timed_out` plus one
        // Activity entry), not a job failure — a `failed` status here would make the
        // runtime retry a wait the member has already been told about.
        run.mockResolvedValue({
            workId: WORK_ID,
            attempt: 1,
            outcome: 'timed_out',
            reason: 'timed_out',
            probes: 60,
            sleeps: [2_000],
            elapsedMs: 900_000,
        });

        const result = await registered.run({ workId: WORK_ID, attempt: 1 });

        expect(result).toMatchObject({
            status: 'ran',
            outcome: 'timed_out',
            reason: 'timed_out',
            error: null,
        });
    });

    it('names the missing seam instead of reporting a run that readied nothing', async () => {
        appContext.get.mockReturnValue(undefined);

        const result = await registered.run({ workId: WORK_ID });

        expect(result).toMatchObject({
            status: 'skipped',
            jobId: 'app-fork-readiness',
            workId: WORK_ID,
            outcome: null,
            reason: 'runnerUnavailable',
            error: null,
        });
        expect(run).not.toHaveBeenCalled();
        expect(loggerErrorMock).toHaveBeenCalled();
    });

    it('names the missing seam instead of reporting a run that readied nothing — when Nest THROWS for it, its real behaviour', async () => {
        appContext.get.mockImplementation(() => {
            // What Nest actually does for an absent provider; the case above
            // fakes `undefined`, which Nest never returns.
            throw new UnknownElementException('absent provider');
        });

        const result = await registered.run({ workId: WORK_ID });

        expect(result).toMatchObject({
            status: 'skipped',
            jobId: 'app-fork-readiness',
            workId: WORK_ID,
            outcome: null,
            reason: 'runnerUnavailable',
            error: null,
        });
        expect(run).not.toHaveBeenCalled();
        expect(loggerErrorMock).toHaveBeenCalled();
    });

    it('refuses a payload with no Work, before the context is even booted', async () => {
        const result = await runAppForkReadinessTask({ workId: '' });

        expect(result).toMatchObject({
            status: 'skipped',
            workId: null,
            reason: 'invalid_payload',
        });
        expect(run).not.toHaveBeenCalled();
    });

    it('reports a rejecting RPC as failed, carrying the transport’s own message', async () => {
        // The production shape of a missing `remoteMap` entry:
        // `Unknown remote target: AppForkReadinessRunner`.
        run.mockRejectedValue(new Error('Unknown remote target: AppForkReadinessRunner'));

        const result = await registered.run({ workId: WORK_ID });

        expect(result).toMatchObject({
            status: 'failed',
            jobId: 'app-fork-readiness',
            workId: WORK_ID,
            outcome: null,
            reason: 'readinessFailed',
            error: 'Unknown remote target: AppForkReadinessRunner',
        });
        expect(loggerErrorMock).toHaveBeenCalled();
    });
});
