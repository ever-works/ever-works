import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import superjson from 'superjson';

/**
 * Workspace backup (AW-22) — the archive task against the RPC deadline it
 * actually runs under.
 *
 * The task reaches the runner, the repository and the service over the
 * worker's internal RPC channel, and that channel abandons any request after
 * `getInternalRequestTimeoutMs()` (45 s by default). The task used to call
 * `runFromPayload`, which holds one request open for the WHOLE archive, so
 * every backup longer than the deadline failed the task — and the fallback
 * meant to still notify the owner read a row that was still `running` and
 * sent nothing. The archive then finished on the API side in silence.
 *
 * Nothing here mocks the deadline away. The REAL `TriggerInternalApiClient`
 * and the REAL remote proxy carry every call, over a `fetch` that dispatches
 * to API-side doubles and honours the client's abort signal the way a
 * network does: the client gives up, the server keeps going. The service is
 * the REAL `WorkspaceBackupService`, so "a notification was raised" means
 * its notifier was called. Time is fake, so a three-minute archive takes
 * milliseconds.
 */

const DEADLINE_MS = 45_000;
const ARCHIVE_MS = 3 * 60_000;

const { triggerConfig, appContext, StubHydrator, StubBindingResolver } = vi.hoisted(() => {
    class StubHydrator {}
    class StubBindingResolver {}
    return {
        triggerConfig: {
            getInternalBaseUrl: vi.fn(() => 'http://api.test.svc.cluster.local/internal/trigger'),
            getInternalSecret: vi.fn(() => 'test-secret'),
            getInternalRequestTimeoutMs: vi.fn(() => 45_000),
        },
        appContext: { get: (_token: unknown): unknown => undefined },
        StubHydrator,
        StubBindingResolver,
    };
});

vi.mock('@trigger.dev/sdk', () => ({
    task: vi.fn((config: unknown) => config),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), log: vi.fn() },
}));

vi.mock('@ever-works/agent/config', () => ({
    config: { trigger: triggerConfig },
}));

vi.mock('../trigger/worker/utils/worker-context.utils', () => ({
    withWorkerContext: async (_name: string, fn: (ctx: unknown) => Promise<unknown>) =>
        fn(appContext),
}));

vi.mock('../trigger/worker/services/trigger-plugin-hydrator.service', () => ({
    TriggerPluginHydratorService: StubHydrator,
}));

vi.mock('../trigger/worker/services/tenant-runtime-binding-resolver.service', () => ({
    TenantRuntimeBindingResolverService: StubBindingResolver,
}));

const { WorkspaceBackupRunner, WorkspaceBackupService } =
    await import('@ever-works/agent/account-transfer');
const { WorkspaceBackupRepository } = await import('@ever-works/agent/database');
const { TriggerInternalApiClient } =
    await import('../trigger/worker/services/trigger-internal-api.client');
const { createRemoteProxy } = await import('../trigger/worker/remote-proxy');
const { workspaceBackupTask } = await import('../tasks/trigger/workspace-backup.task');

type Row = {
    id: string;
    userId: string;
    organizationId: string | null;
    status: string;
    requestedAt: Date;
    startedAt: Date | null;
    lastHeartbeatAt: Date | null;
    finishedAt?: Date | null;
    failureReason?: string | null;
    sizeBytes?: number;
    manifestSummary?: unknown;
};

const PAYLOAD = {
    backupId: 'b1',
    userId: 'u1',
    organizationId: null,
    tenantId: null,
    includeFullHistory: false,
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The API side: one backup row, the repository and runner that act on it,
 * and the real service over them. The runner double models only what the
 * task depends on — the claim, the heartbeat, how long the archive takes and
 * the settle — because the archive itself is the runner spec's subject.
 */
function apiSide(options: { archiveMs?: number; dies?: boolean; startDelayMs?: number } = {}) {
    const archiveMs = options.archiveMs ?? ARCHIVE_MS;
    const row: Row = {
        id: 'b1',
        userId: 'u1',
        organizationId: null,
        status: 'queued',
        requestedAt: new Date(),
        startedAt: null,
        lastHeartbeatAt: null,
    };
    const calls: string[] = [];

    const repository = {
        findInScope: async (_scope: unknown, id: string) => (id === row.id ? { ...row } : null),
        markTerminal: async (
            id: string,
            patch: Partial<Row>,
            from: readonly string[] = ['queued', 'running'],
        ) => {
            if (id !== row.id || !from.includes(row.status)) return false;
            Object.assign(row, patch);
            return true;
        },
    };

    const notifier = { create: vi.fn(async () => undefined) };
    const service = new WorkspaceBackupService(
        repository as never,
        undefined,
        undefined,
        undefined,
        notifier,
    );

    const claim = () => {
        row.status = 'running';
        row.startedAt = new Date();
        row.lastHeartbeatAt = new Date();
    };

    // Heartbeats every 25 s like the real runner, stops when the row leaves
    // `running`, and settles with a compare-and-set out of `running`.
    const archive = async () => {
        for (let elapsed = 0; elapsed < archiveMs; elapsed += 25_000) {
            await sleep(25_000);
            if (row.status !== 'running') return;
            if (options.dies) continue; // the process is gone: no more heartbeats, no settle
            row.lastHeartbeatAt = new Date();
        }
        if (options.dies) return;
        await repository.markTerminal(
            row.id,
            {
                status: 'ready',
                finishedAt: new Date(),
                sizeBytes: 2048,
                manifestSummary: { files: { omitted: 0 }, domains: [] },
            },
            ['running'],
        );
    };

    const runner = {
        runFromPayload: async () => {
            claim();
            await archive();
            return { status: row.status, backupId: row.id };
        },
        startFromPayload: async () => {
            claim();
            void archive();
            if (options.startDelayMs) await sleep(options.startDelayMs);
            return { status: 'started', backupId: row.id };
        },
    };

    const remotes: Record<string, Record<string, (...args: unknown[]) => unknown>> = {
        WorkspaceBackupRunner: runner as never,
        WorkspaceBackupService: service as never,
        WorkspaceBackupRepository: repository as never,
    };

    // The network: the server runs the call to completion whatever the
    // client does; the client's abort rejects only the client's wait.
    const fetchMock = vi.fn(
        async (_url: string, init: { body: string; signal: AbortSignal }) =>
            new Promise((resolve, reject) => {
                const body = JSON.parse(init.body) as {
                    name: string;
                    method: string;
                    args: { json: unknown; meta?: unknown };
                };
                calls.push(`${body.name}.${body.method}`);
                const args = superjson.deserialize(body.args as never) as unknown[];
                const target = remotes[body.name];
                const onAbort = () =>
                    reject(
                        Object.assign(new Error('This operation was aborted'), {
                            name: 'AbortError',
                        }),
                    );
                if (init.signal.aborted) return onAbort();
                init.signal.addEventListener('abort', onAbort, { once: true });
                Promise.resolve()
                    .then(() => target[body.method].call(target, ...args))
                    .then(
                        (result) =>
                            resolve({
                                ok: true,
                                status: 200,
                                text: async () =>
                                    JSON.stringify({ result: superjson.serialize(result) }),
                            }),
                        (error: unknown) =>
                            resolve({
                                ok: false,
                                status: 500,
                                text: async () => String(error),
                            }),
                    );
            }),
    );

    return { row, notifier, calls, fetchMock };
}

function wireWorker(): void {
    const client = new TriggerInternalApiClient();
    const proxies = new Map<unknown, unknown>([
        [WorkspaceBackupRunner, createRemoteProxy(client, 'WorkspaceBackupRunner')],
        [WorkspaceBackupService, createRemoteProxy(client, 'WorkspaceBackupService')],
        [WorkspaceBackupRepository, createRemoteProxy(client, 'WorkspaceBackupRepository')],
        [StubHydrator, { initialize: async () => undefined }],
        [StubBindingResolver, { resolve: async () => ({ status: 'active' }) }],
    ]);
    appContext.get = (token: unknown) => proxies.get(token);
}

/**
 * Run the task to an outcome, advancing fake time a second at a time.
 * `at[second]` runs once when that much time has passed — a cancel, say.
 */
async function runTask(maxSeconds: number, at: Record<number, () => void> = {}) {
    const run = (workspaceBackupTask as unknown as { run: (p: unknown) => Promise<unknown> }).run;
    let outcome: unknown;
    let failure: unknown;
    let done = false;
    run(PAYLOAD).then(
        (value) => {
            outcome = value;
            done = true;
        },
        (error: unknown) => {
            failure = error;
            done = true;
        },
    );
    for (let second = 0; second < maxSeconds && !done; second += 1) {
        at[second]?.();
        await vi.advanceTimersByTimeAsync(1_000);
    }
    return { outcome, failure, done };
}

describe('workspace-backup task — a backup longer than the RPC deadline', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('models the deadline for real: one call held open past it is abandoned', async () => {
        // The premise of every case below. If this stops holding, they stop
        // proving anything about the deadline.
        const api = apiSide();
        globalThis.fetch = api.fetchMock as never;
        wireWorker();

        const proxy = appContext.get(WorkspaceBackupRunner) as {
            runFromPayload: (payload: unknown) => Promise<unknown>;
        };
        const call = proxy.runFromPayload(PAYLOAD);
        const settled = call.then(
            () => 'returned',
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1_000);

        expect(await settled).toBe(`Trigger internal API request timed out after ${DEADLINE_MS}ms`);
        // And the server did not stop: the archive still lands.
        await vi.advanceTimersByTimeAsync(ARCHIVE_MS);
        expect(api.row.status).toBe('ready');
    });

    it('completes and raises exactly one notification for a three-minute archive', async () => {
        const api = apiSide();
        globalThis.fetch = api.fetchMock as never;
        wireWorker();

        const { outcome, failure, done } = await runTask(10 * 60);

        expect(failure).toBeUndefined();
        expect(done).toBe(true);
        expect(outcome).toEqual({ status: 'ready', backupId: 'b1' });
        expect(api.row.status).toBe('ready');

        // Still exactly one after more time passes — nothing notifies twice.
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(api.notifier.create).toHaveBeenCalledTimes(1);
        expect(api.notifier.create).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'u1', title: 'Your workspace backup is ready' }),
        );
    });

    it('never lets an archive that landed go unannounced, whatever became of the task', async () => {
        // The exact loss in the review: the archive settles `ready` on the
        // API side after the task has given up, and nobody tells the owner.
        const api = apiSide();
        globalThis.fetch = api.fetchMock as never;
        wireWorker();

        await runTask(10 * 60);
        await vi.advanceTimersByTimeAsync(10 * 60_000);

        expect(api.row.status).toBe('ready');
        expect(api.notifier.create).toHaveBeenCalledTimes(1);
    });

    it('never holds a single call open for the length of the archive', async () => {
        const api = apiSide();
        globalThis.fetch = api.fetchMock as never;
        wireWorker();

        await runTask(10 * 60);

        expect(api.calls).not.toContain('WorkspaceBackupRunner.runFromPayload');
        expect(api.calls).toContain('WorkspaceBackupRunner.startFromPayload');
    });

    it('stays silent for a backup the owner cancelled while it ran', async () => {
        const api = apiSide();
        globalThis.fetch = api.fetchMock as never;
        wireWorker();

        const { outcome } = await runTask(10 * 60, {
            60: () => {
                // What `requestCancel` does: a compare-and-set to `cancelled`.
                api.row.status = 'cancelled';
                api.row.failureReason = 'cancelled_by_user';
            },
        });

        expect(outcome).toEqual(expect.objectContaining({ status: 'cancelled' }));
        expect(api.notifier.create).not.toHaveBeenCalled();
    });

    it('fails a run whose API process died, and tells the owner once', async () => {
        // No heartbeat after the first beat and no settle. The hourly sweeper
        // would find it eventually and notify nobody; the task watching the
        // row applies the same ten-minute stall rule itself.
        const api = apiSide({ dies: true, archiveMs: 60 * 60_000 });
        globalThis.fetch = api.fetchMock as never;
        wireWorker();

        const { outcome, failure } = await runTask(20 * 60);

        expect(failure).toBeUndefined();
        expect(outcome).toEqual({ status: 'failed', backupId: 'b1', reason: 'stalled' });
        expect(api.notifier.create).toHaveBeenCalledTimes(1);
        expect(api.notifier.create).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'Your workspace backup did not finish' }),
        );
    });

    it('still watches the run when the start call’s own answer is lost after the claim', async () => {
        const api = apiSide({ startDelayMs: DEADLINE_MS + 5_000 });
        globalThis.fetch = api.fetchMock as never;
        wireWorker();

        const { outcome, failure } = await runTask(10 * 60);

        expect(failure).toBeUndefined();
        expect(outcome).toEqual({ status: 'ready', backupId: 'b1' });
        expect(api.notifier.create).toHaveBeenCalledTimes(1);
    });
});
