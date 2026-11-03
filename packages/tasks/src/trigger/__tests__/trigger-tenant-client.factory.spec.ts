import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for {@link createTenantTriggerClient} and
 * {@link dispatchersFromTenantClient} — the default `clientFactory` +
 * `dispatchersFromClient` implementations the apps/api `TriggerModule`
 * passes into `@ever-works/job-runtime-trigger-plugin`'s `bindToTenant`.
 *
 * The Trigger.dev SDK v4 surface (`tasks.trigger`, `runs.cancel`,
 * `runs.retrieve`, `auth.withAuth`) is mocked so the tests never touch
 * the network. Assertions focus on:
 *
 *   - per-tenant `clientConfig` (accessToken + baseURL) reaches the SDK
 *     verbatim on every `tasks.trigger` call;
 *   - the default API URL kicks in when `credentials.apiUrl` is absent
 *     AND the operator override flows through when present;
 *   - two clients built from different credentials don't share state
 *     (per-call construction, no module-global mutation);
 *   - `dispatchersFromTenantClient` routes each call through the right
 *     per-tenant client (not the singleton);
 *   - the factory is offline-safe — no SDK call at construction time;
 *   - SDK construction failures surface as named errors.
 */

const { tasksTriggerMock, runsCancelMock, runsRetrieveMock, withAuthMock } = vi.hoisted(() => ({
    tasksTriggerMock: vi.fn(),
    runsCancelMock: vi.fn(),
    runsRetrieveMock: vi.fn(),
    /**
     * Default `auth.withAuth(config, fn)` implementation that just runs
     * the callback. Individual tests can override to capture the config
     * argument.
     */
    withAuthMock: vi.fn(async (_config: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('@trigger.dev/sdk/v3', () => ({
    tasks: { trigger: tasksTriggerMock },
    runs: { cancel: runsCancelMock, retrieve: runsRetrieveMock },
    auth: { withAuth: withAuthMock },
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    createTenantTriggerClient,
    dispatchersFromTenantClient,
} from '../trigger-tenant-client.factory';
import {
    appBlueprintApplyIdempotencyKey,
    appUpstreamSyncIdempotencyKey,
} from '../app-job-idempotency-keys';
import { DEFAULT_TRIGGER_API_URL } from '@ever-works/job-runtime-trigger-plugin';

const tenantA = {
    accessToken: 'tr_pat_a',
    secretKey: 'tr_dev_a',
    projectRef: 'proj_a',
} as const;

const tenantB = {
    accessToken: 'tr_pat_b',
    secretKey: 'tr_dev_b',
    projectRef: 'proj_b',
    apiUrl: 'https://trigger.tenant-b.internal',
} as const;

describe('createTenantTriggerClient', () => {
    beforeEach(() => {
        tasksTriggerMock.mockReset().mockResolvedValue({ id: 'run_default' });
        runsCancelMock.mockReset().mockResolvedValue(undefined);
        runsRetrieveMock.mockReset().mockResolvedValue({ id: 'r1', status: 'EXECUTING' });
        withAuthMock.mockReset().mockImplementation((_c, fn) => fn());
    });

    it('is offline-safe — construction makes no SDK call', () => {
        createTenantTriggerClient(tenantA);
        expect(tasksTriggerMock).not.toHaveBeenCalled();
        expect(runsCancelMock).not.toHaveBeenCalled();
        expect(runsRetrieveMock).not.toHaveBeenCalled();
        expect(withAuthMock).not.toHaveBeenCalled();
    });

    it('tasks.trigger forwards a per-tenant clientConfig with secretKey + DEFAULT_TRIGGER_API_URL', async () => {
        tasksTriggerMock.mockResolvedValueOnce({ id: 'run_a1' });
        const client = createTenantTriggerClient(tenantA);

        const handle = await client.tasks.trigger(
            'work-generation',
            { foo: 'bar' },
            {
                tags: ['a-tag'],
            },
        );

        expect(handle).toEqual({ id: 'run_a1' });
        expect(tasksTriggerMock).toHaveBeenCalledTimes(1);
        const [taskId, payload, options, requestOptions] = tasksTriggerMock.mock.calls[0];
        expect(taskId).toBe('work-generation');
        expect(payload).toEqual({ foo: 'bar' });
        expect(options).toEqual({ tags: ['a-tag'] });
        expect(requestOptions).toEqual({
            clientConfig: {
                accessToken: tenantA.secretKey,
                baseURL: DEFAULT_TRIGGER_API_URL,
            },
        });
    });

    it('credentials.apiUrl override flows through to clientConfig.baseURL', async () => {
        const client = createTenantTriggerClient(tenantB);
        await client.tasks.trigger('work-generation', {});

        const [, , , requestOptions] = tasksTriggerMock.mock.calls[0];
        expect(requestOptions).toEqual({
            clientConfig: {
                accessToken: tenantB.secretKey,
                baseURL: tenantB.apiUrl,
            },
        });
    });

    it('runs.cancel routes through auth.withAuth with the tenant clientConfig', async () => {
        const client = createTenantTriggerClient(tenantB);
        await client.runs.cancel('run_xyz');

        expect(withAuthMock).toHaveBeenCalledTimes(1);
        const [config] = withAuthMock.mock.calls[0];
        expect(config).toEqual({
            accessToken: tenantB.secretKey,
            baseURL: tenantB.apiUrl,
        });
        expect(runsCancelMock).toHaveBeenCalledWith('run_xyz');
    });

    it('runs.retrieve routes through auth.withAuth and returns the SDK run record', async () => {
        runsRetrieveMock.mockResolvedValueOnce({ id: 'run_ret', status: 'COMPLETED' });
        const client = createTenantTriggerClient(tenantA);
        const record = await client.runs.retrieve('run_ret');

        expect(record).toEqual({ id: 'run_ret', status: 'COMPLETED' });
        expect(withAuthMock).toHaveBeenCalledTimes(1);
        const [config] = withAuthMock.mock.calls[0];
        expect(config).toEqual({
            accessToken: tenantA.secretKey,
            baseURL: DEFAULT_TRIGGER_API_URL,
        });
    });

    it('two clients built from different credentials do not share clientConfig state', async () => {
        const clientA = createTenantTriggerClient(tenantA);
        const clientB = createTenantTriggerClient(tenantB);
        await clientA.tasks.trigger('t', {});
        await clientB.tasks.trigger('t', {});

        const configA = tasksTriggerMock.mock.calls[0][3];
        const configB = tasksTriggerMock.mock.calls[1][3];
        expect(configA.clientConfig.accessToken).toBe(tenantA.secretKey);
        expect(configA.clientConfig.baseURL).toBe(DEFAULT_TRIGGER_API_URL);
        expect(configB.clientConfig.accessToken).toBe(tenantB.secretKey);
        expect(configB.clientConfig.baseURL).toBe(tenantB.apiUrl);
    });

    it('twice-built clients on the same creds are functionally equivalent', async () => {
        // The plugin's TenantCredentialCache memoises on (tenantId,
        // credentialVersion), but the factory itself never has to —
        // calling it twice must produce two clients that route through
        // the same clientConfig values (object identity is allowed to
        // differ).
        const c1 = createTenantTriggerClient(tenantA);
        const c2 = createTenantTriggerClient(tenantA);
        expect(c1).not.toBe(c2);

        await c1.tasks.trigger('t', {});
        await c2.tasks.trigger('t', {});

        expect(tasksTriggerMock.mock.calls[0][3]).toEqual(tasksTriggerMock.mock.calls[1][3]);
    });
});

describe('dispatchersFromTenantClient', () => {
    beforeEach(() => {
        tasksTriggerMock.mockReset().mockResolvedValue({ id: 'run_dispatch' });
        runsCancelMock.mockReset();
        runsRetrieveMock.mockReset();
        withAuthMock.mockReset().mockImplementation((_c, fn) => fn());
    });

    it('routes dispatchKbEmbedDocument through the supplied client, not the singleton', async () => {
        // Build a fake client whose tasks.trigger is a vi.fn — proves
        // the dispatcher uses THIS client, never falling back to the
        // mocked SDK module.
        const fakeTrigger = vi.fn().mockResolvedValue({ id: 'tenant-run' });
        const fakeClient = {
            tasks: { trigger: fakeTrigger },
            runs: { cancel: vi.fn(), retrieve: vi.fn() },
        };
        const dispatchers = dispatchersFromTenantClient(fakeClient) as unknown as {
            dispatchKbEmbedDocument: (p: unknown) => Promise<string | null>;
        };

        const runId = await dispatchers.dispatchKbEmbedDocument({
            workId: 'work-1',
            documentId: 'doc-1',
        });

        expect(runId).toBe('tenant-run');
        expect(fakeTrigger).toHaveBeenCalledTimes(1);
        expect(fakeTrigger).toHaveBeenCalledWith(
            'kb-embed-document',
            { workId: 'work-1', documentId: 'doc-1' },
            expect.objectContaining({
                tags: ['kb-embed-document', 'work:work-1', 'doc:doc-1'],
                concurrencyKey: 'kb-embed:work-1',
            }),
        );
        // No leakage to the module-global SDK mock.
        expect(tasksTriggerMock).not.toHaveBeenCalled();
    });

    it('dispatchKbNormalizeMedia picks the right per-kind task id', async () => {
        const fakeTrigger = vi.fn().mockResolvedValue({ id: 'r' });
        const fakeClient = {
            tasks: { trigger: fakeTrigger },
            runs: { cancel: vi.fn(), retrieve: vi.fn() },
        };
        const dispatchers = dispatchersFromTenantClient(fakeClient) as unknown as {
            dispatchKbNormalizeMedia: (p: unknown) => Promise<string | null>;
        };

        await dispatchers.dispatchKbNormalizeMedia({
            mediaKind: 'video',
            workId: 'w',
            uploadId: 'u',
        });
        await dispatchers.dispatchKbNormalizeMedia({
            mediaKind: 'audio',
            workId: 'w',
            uploadId: 'u',
        });

        expect(fakeTrigger.mock.calls[0][0]).toBe('kb-normalize-video');
        expect(fakeTrigger.mock.calls[1][0]).toBe('kb-normalize-audio');
    });

    it('soft-error dispatchers return null when the SDK throws (matches singleton shape)', async () => {
        const fakeTrigger = vi.fn().mockRejectedValue(new Error('SDK down'));
        const fakeClient = {
            tasks: { trigger: fakeTrigger },
            runs: { cancel: vi.fn(), retrieve: vi.fn() },
        };
        const dispatchers = dispatchersFromTenantClient(fakeClient) as unknown as {
            dispatchWorkGeneration: (p: unknown) => Promise<string | null>;
        };

        const out = await dispatchers.dispatchWorkGeneration({
            workId: 'w',
            mode: 'full',
        });
        expect(out).toBeNull();
    });

    // AW-07 — a BYO tenant's memory-fact embeds go to its own Trigger.dev
    // project under the same task id, and a failure is deferred work.
    it('dispatchMemoryFactEmbed triggers memory-fact-embed on the tenant client and soft-fails', async () => {
        const fakeTrigger = vi
            .fn()
            .mockResolvedValueOnce({ id: 'tenant-mfe' })
            .mockRejectedValueOnce(new Error('SDK down'));
        const fakeClient = {
            tasks: { trigger: fakeTrigger },
            runs: { cancel: vi.fn(), retrieve: vi.fn() },
        };
        const dispatchers = dispatchersFromTenantClient(fakeClient) as unknown as {
            dispatchMemoryFactEmbed: (p: unknown) => Promise<string | null>;
        };

        await expect(
            dispatchers.dispatchMemoryFactEmbed({ factId: 'f-1', userId: 'u-1' }),
        ).resolves.toBe('tenant-mfe');
        expect(fakeTrigger).toHaveBeenCalledWith(
            'memory-fact-embed',
            { factId: 'f-1', userId: 'u-1' },
            { tags: ['memory-fact-embed', 'fact:f-1'] },
        );
        await expect(
            dispatchers.dispatchMemoryFactEmbed({ factId: 'f-1', userId: 'u-1' }),
        ).resolves.toBeNull();
        expect(tasksTriggerMock).not.toHaveBeenCalled();
    });

    it('dispatchKbReembedWork propagates SDK errors (no silent drop)', async () => {
        const fakeTrigger = vi.fn().mockRejectedValue(new Error('SDK down'));
        const fakeClient = {
            tasks: { trigger: fakeTrigger },
            runs: { cancel: vi.fn(), retrieve: vi.fn() },
        };
        const dispatchers = dispatchersFromTenantClient(fakeClient) as unknown as {
            dispatchKbReembedWork: (p: unknown) => Promise<string>;
        };

        await expect(
            dispatchers.dispatchKbReembedWork({
                workId: 'w',
                previousModel: 'old',
                newModel: 'new',
            }),
        ).rejects.toThrow('SDK down');
    });

    it('dispatchAppDependencyProvision propagates SDK errors (APW07-G24 — no silent drop)', async () => {
        const fakeTrigger = vi.fn().mockRejectedValue(new Error('SDK down'));
        const fakeClient = {
            tasks: { trigger: fakeTrigger },
            runs: { cancel: vi.fn(), retrieve: vi.fn() },
        };
        const dispatchers = dispatchersFromTenantClient(fakeClient) as unknown as {
            dispatchAppDependencyProvision: (p: unknown) => Promise<string>;
        };

        // A silently dropped provisioning dispatch would leave the dependency
        // row `pending` with nothing scheduled behind it, and nothing else in
        // the platform picks that up — so the throw MUST escape.
        await expect(
            dispatchers.dispatchAppDependencyProvision({
                workId: 'w',
                kind: 'postgres',
                mode: 'provision',
            }),
        ).rejects.toThrow('SDK down');
    });

    it('dispatchAppDependencyProvision propagates a missing run id (never a silent null)', async () => {
        const fakeClient = {
            tasks: { trigger: vi.fn().mockResolvedValue(undefined) },
            runs: { cancel: vi.fn(), retrieve: vi.fn() },
        };
        const dispatchers = dispatchersFromTenantClient(fakeClient) as unknown as {
            dispatchAppDependencyProvision: (p: unknown) => Promise<string>;
        };

        await expect(
            dispatchers.dispatchAppDependencyProvision({
                workId: 'w',
                kind: 'redis',
                mode: 'refresh',
            }),
        ).rejects.toThrow('SDK returned no run id');
    });

    it('dispatchAppDependencyProvision carries the delayed re-dispatch as the runtime delay', async () => {
        const fakeTrigger = vi.fn().mockResolvedValue({ id: 'run_dep' });
        const fakeClient = {
            tasks: { trigger: fakeTrigger },
            runs: { cancel: vi.fn(), retrieve: vi.fn() },
        };
        const dispatchers = dispatchersFromTenantClient(fakeClient) as unknown as {
            dispatchAppDependencyProvision: (p: unknown) => Promise<string>;
        };

        const notBefore = Date.parse('2026-09-17T09:05:00.000Z');
        const runId = await dispatchers.dispatchAppDependencyProvision({
            workId: 'w',
            kind: 'postgres',
            mode: 'provision',
            requestedAtMs: Date.parse('2026-09-17T09:00:00.000Z'),
            notBefore,
        });

        expect(runId).toBe('run_dep');
        expect(fakeTrigger).toHaveBeenCalledTimes(1);
        const [taskId, payload, options] = fakeTrigger.mock.calls[0] as [
            string,
            Record<string, unknown>,
            { delay?: Date; concurrencyKey?: string; tags?: string[] },
        ];
        expect(taskId).toBe('app-dependency-provision');
        expect(payload).toMatchObject({ workId: 'w', kind: 'postgres', mode: 'provision' });
        // `notBefore` (epoch ms) becomes the runtime's own `delay` — the job
        // never sleeps (plan §7:875-876).
        expect(options.delay).toEqual(new Date(notBefore));
        expect(options.concurrencyKey).toBe('app-dependency:w:postgres');
        expect(options.tags).toEqual([
            'app-dependency-provision',
            'work:w',
            'kind:postgres',
            'mode:provision',
        ]);
    });

    it('two dispatcher maps for two clients do not cross-pollute', async () => {
        const triggerA = vi.fn().mockResolvedValue({ id: 'a-run' });
        const triggerB = vi.fn().mockResolvedValue({ id: 'b-run' });
        const clientA = {
            tasks: { trigger: triggerA },
            runs: { cancel: vi.fn(), retrieve: vi.fn() },
        };
        const clientB = {
            tasks: { trigger: triggerB },
            runs: { cancel: vi.fn(), retrieve: vi.fn() },
        };
        const dA = dispatchersFromTenantClient(clientA) as unknown as {
            dispatchKbEmbedDocument: (p: unknown) => Promise<string | null>;
        };
        const dB = dispatchersFromTenantClient(clientB) as unknown as {
            dispatchKbEmbedDocument: (p: unknown) => Promise<string | null>;
        };

        await dA.dispatchKbEmbedDocument({ workId: 'a', documentId: 'a' });
        await dB.dispatchKbEmbedDocument({ workId: 'b', documentId: 'b' });

        expect(triggerA).toHaveBeenCalledTimes(1);
        expect(triggerB).toHaveBeenCalledTimes(1);
        expect(triggerA.mock.calls[0][1]).toEqual({ workId: 'a', documentId: 'a' });
        expect(triggerB.mock.calls[0][1]).toEqual({ workId: 'b', documentId: 'b' });
    });

    // T26 / EW-742 P3 — the plugin execution router looks
    // `dispatchPluginOperation` up by name on a BYO tenant's view; without it
    // every long-running plugin call for that tenant answered
    // JOB_RUNTIME_UNAVAILABLE.
    it('dispatchPluginOperation triggers run-plugin-operation on the tenant client, with the tags and queue ttl', async () => {
        const fakeTrigger = vi.fn().mockResolvedValue({ id: 'tenant-plugin-run' });
        const fakeClient = {
            tasks: { trigger: fakeTrigger },
            runs: { cancel: vi.fn(), retrieve: vi.fn() },
        };
        const dispatchers = dispatchersFromTenantClient(fakeClient) as unknown as {
            dispatchPluginOperation: (p: unknown) => Promise<string | null>;
        };

        await expect(
            dispatchers.dispatchPluginOperation({
                pluginId: 'acme',
                operation: 'runSandboxSession',
                args: { n: 1 },
                tenantId: 't-1',
                providerId: 'trigger',
                credentialVersion: 3,
            }),
        ).resolves.toBe('tenant-plugin-run');
        expect(fakeTrigger).toHaveBeenCalledTimes(1);
        expect(fakeTrigger).toHaveBeenCalledWith(
            'run-plugin-operation',
            {
                pluginId: 'acme',
                operation: 'runSandboxSession',
                args: { n: 1 },
                tenantId: 't-1',
                providerId: 'trigger',
                credentialVersion: 3,
            },
            // No tenant tag here: the bound view's Proxy owns stamping.
            { tags: ['plugin-operation', 'plugin:acme'], ttl: '15m' },
        );
        expect(tasksTriggerMock).not.toHaveBeenCalled();
    });

    it('dispatchPluginOperation sends only the fields the payload has', async () => {
        const fakeTrigger = vi.fn().mockResolvedValue({ id: 'r' });
        const fakeClient = {
            tasks: { trigger: fakeTrigger },
            runs: { cancel: vi.fn(), retrieve: vi.fn() },
        };
        const dispatchers = dispatchersFromTenantClient(fakeClient) as unknown as {
            dispatchPluginOperation: (p: unknown) => Promise<string | null>;
        };

        await dispatchers.dispatchPluginOperation({ pluginId: 'acme', operation: 'op' });

        expect(Object.keys(fakeTrigger.mock.calls[0][1] as object)).toEqual([
            'pluginId',
            'operation',
            'args',
        ]);
    });

    it('dispatchPluginOperation answers null when the SDK throws or returns no run id (the router reads null as not accepted)', async () => {
        const fakeTrigger = vi
            .fn()
            .mockRejectedValueOnce(new Error('SDK down'))
            .mockResolvedValueOnce(undefined);
        const fakeClient = {
            tasks: { trigger: fakeTrigger },
            runs: { cancel: vi.fn(), retrieve: vi.fn() },
        };
        const dispatchers = dispatchersFromTenantClient(fakeClient) as unknown as {
            dispatchPluginOperation: (p: unknown) => Promise<string | null>;
        };

        await expect(
            dispatchers.dispatchPluginOperation({ pluginId: 'acme', operation: 'op' }),
        ).resolves.toBeNull();
        await expect(
            dispatchers.dispatchPluginOperation({ pluginId: 'acme', operation: 'op' }),
        ).resolves.toBeNull();
    });

    it('the dispatchers map is frozen', () => {
        const fakeClient = {
            tasks: { trigger: vi.fn() },
            runs: { cancel: vi.fn(), retrieve: vi.fn() },
        };
        const dispatchers = dispatchersFromTenantClient(fakeClient);
        expect(Object.isFrozen(dispatchers)).toBe(true);
    });
});

/**
 * C-8 — a BYO tenant's bound view reads its dispatchers from
 * `dispatchersFromTenantClient`'s map ONLY (`bindToTenant` in
 * `trigger-job-runtime.provider.ts`), so an App dispatcher missing here
 * answered `undefined` for that tenant and the job never left the API: fork
 * readiness stayed `dispatch_unavailable`, Builds and Blueprint applies ran in
 * process, and a Deploy was never enqueued. These pin every `dispatchApp*`
 * `TriggerService` declares to a mirror on the tenant's own client.
 */
describe('dispatchersFromTenantClient — every App dispatcher for a BYO tenant (C-8)', () => {
    type Dispatch = (payload: unknown, opts?: { delayMs?: number }) => Promise<string | null>;

    const srcDir = join(__dirname, '..', '..');

    function tenantClient(trigger = vi.fn().mockResolvedValue({ id: 'tenant-app-run' })) {
        return {
            trigger,
            client: { tasks: { trigger }, runs: { cancel: vi.fn(), retrieve: vi.fn() } },
        };
    }

    function dispatcher(name: string, client: ReturnType<typeof tenantClient>['client']): Dispatch {
        const fn = (dispatchers(client) as unknown as Record<string, unknown>)[name];
        expect(typeof fn).toBe('function');
        return fn as Dispatch;
    }

    const dispatchers = (client: ReturnType<typeof tenantClient>['client']) =>
        dispatchersFromTenantClient(client);

    /**
     * Each App dispatcher, the task it must reach and the singleton's tags /
     * keys. `taskModule` names the module whose exported `*_TASK_ID` the
     * factory's re-typed id must equal.
     */
    const cases: Array<{
        name: string;
        payload: Record<string, unknown>;
        taskId: string;
        taskModule?: string;
        options: Record<string, unknown>;
        propagates?: boolean;
    }> = [
        {
            name: 'dispatchAppDependencyProvision',
            payload: { workId: 'w', kind: 'postgres', mode: 'provision' },
            taskId: 'app-dependency-provision',
            options: {
                tags: ['app-dependency-provision', 'work:w', 'kind:postgres', 'mode:provision'],
                concurrencyKey: 'app-dependency:w:postgres',
            },
            propagates: true,
        },
        {
            name: 'dispatchAppSpecEvaluate',
            payload: { workId: 'w', trigger: 'save' },
            taskId: 'app-spec-evaluate',
            options: {
                tags: ['app-spec-evaluate', 'work:w', 'trigger:save'],
                concurrencyKey: 'app-spec-evaluate:w',
            },
            propagates: true,
        },
        {
            name: 'dispatchAppForkReadiness',
            payload: { workId: 'w', reason: 'retry' },
            taskId: 'app-fork-readiness',
            taskModule: 'app-fork-readiness.task.ts',
            options: {
                tags: ['app-fork-readiness', 'work:w', 'trigger:retry'],
                concurrencyKey: 'app-fork-readiness:w',
            },
        },
        {
            name: 'dispatchAppBuildPrepare',
            payload: { workId: 'w', buildId: 'b1', reason: 'rebuild' },
            taskId: 'app-build-prepare',
            taskModule: 'app-build-prepare.task.ts',
            options: {
                tags: ['app-build-prepare', 'work:w', 'build:b1'],
                concurrencyKey: 'app-build-prepare:w',
            },
        },
        {
            name: 'dispatchAppBuildWatch',
            payload: { buildId: 'b1' },
            taskId: 'app-build-watch',
            taskModule: 'app-build-watch.task.ts',
            options: {
                tags: ['app-build-watch', 'build:b1'],
                concurrencyKey: 'app-build-watch:b1',
            },
        },
        {
            name: 'dispatchAppDeploy',
            payload: { workId: 'w', deploymentId: 'd1', trigger: 'manual' },
            taskId: 'app-deploy',
            taskModule: 'app-deploy.task.ts',
            options: {
                tags: ['app-deploy', 'work:w', 'deployment:d1', 'trigger:manual'],
                concurrencyKey: 'app-deploy:w',
            },
        },
        {
            name: 'dispatchAppClusterOp',
            payload: { workId: 'w', op: 'status-refresh' },
            taskId: 'app-cluster-op',
            taskModule: 'app-cluster-op.task.ts',
            options: { tags: ['app-cluster-op', 'work:w', 'op:status-refresh'] },
        },
        {
            name: 'dispatchAppUpstreamSync',
            payload: { workId: 'w', trigger: 'manual' },
            taskId: 'app-upstream-sync',
            taskModule: 'app-upstream-sync.task.ts',
            options: {
                tags: ['app-upstream-sync', 'work:w', 'trigger:manual'],
                concurrencyKey: 'app-upstream-sync:w',
            },
        },
        {
            name: 'dispatchAppBlueprintApply',
            payload: { workId: 'w', mode: 'upgrade', version: '2.0.0', requestedAt: 't0' },
            taskId: 'app-blueprint-apply',
            taskModule: 'app-blueprint-apply.task.ts',
            options: {
                tags: ['app-blueprint-apply', 'work:w', 'mode:upgrade'],
                idempotencyKey: 'app-blueprint-apply:w:upgrade:2.0.0:t0',
                concurrencyKey: 'app-blueprint-apply:w',
            },
        },
    ];

    beforeEach(() => {
        tasksTriggerMock.mockReset();
    });

    it('mirrors every dispatchApp* method TriggerService declares', () => {
        // Read from the source, not the class: importing TriggerService pulls
        // the worker's whole task graph in. A new App dispatcher added there
        // without a BYO mirror fails here instead of answering `undefined`.
        const source = readFileSync(join(srcDir, 'trigger', 'trigger.service.ts'), 'utf8');
        const declared = [...source.matchAll(/^\s+async (dispatchApp\w+)\(/gm)].map((m) => m[1]);

        expect(declared.sort()).toEqual(cases.map((c) => c.name).sort());
        const { client } = tenantClient();
        for (const name of declared) {
            expect(typeof (dispatchers(client) as unknown as Record<string, unknown>)[name]).toBe(
                'function',
            );
        }
    });

    it.each(cases)(
        '$name triggers $taskId on the tenant client with the singleton tags and keys',
        async ({ name, payload, taskId, options }) => {
            const { trigger, client } = tenantClient();

            await expect(dispatcher(name, client)(payload)).resolves.toBe('tenant-app-run');

            expect(trigger).toHaveBeenCalledTimes(1);
            expect(trigger).toHaveBeenCalledWith(taskId, payload, expect.objectContaining(options));
            // No `machine` (like every BYO dispatcher), and never the SDK module.
            expect(trigger.mock.calls[0][2]).not.toHaveProperty('machine');
            expect(tasksTriggerMock).not.toHaveBeenCalled();
        },
    );

    it.each(cases.filter((c) => c.taskModule))(
        "$name's task id is the one $taskModule registers",
        ({ taskId, taskModule }) => {
            const source = readFileSync(join(srcDir, 'tasks', 'trigger', taskModule!), 'utf8');
            expect(source).toMatch(new RegExp(`export const \\w+_TASK_ID = '${taskId}' as const;`));
        },
    );

    it.each(cases.filter((c) => !c.propagates))(
        '$name is soft: null when the SDK throws or answers no run id',
        async ({ name, payload }) => {
            const { client } = tenantClient(
                vi
                    .fn()
                    .mockRejectedValueOnce(new Error('SDK down'))
                    .mockResolvedValueOnce(undefined),
            );
            const dispatch = dispatcher(name, client);

            await expect(dispatch(payload)).resolves.toBeNull();
            await expect(dispatch(payload)).resolves.toBeNull();
        },
    );

    it('dispatchAppSpecEvaluate propagates an SDK error and a missing run id (never a silent null)', async () => {
        const { client } = tenantClient(
            vi.fn().mockRejectedValueOnce(new Error('SDK down')).mockResolvedValueOnce(undefined),
        );
        const dispatch = dispatcher('dispatchAppSpecEvaluate', client);

        await expect(dispatch({ workId: 'w', trigger: 'save' })).rejects.toThrow('SDK down');
        await expect(dispatch({ workId: 'w', trigger: 'save' })).rejects.toThrow(
            'SDK returned no run id',
        );
    });

    it('dispatchAppUpstreamSync carries the minute-bucket idempotency key, defaulting the trigger to schedule', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-29T10:15:30.000Z'));
        try {
            const { trigger, client } = tenantClient();
            await dispatcher('dispatchAppUpstreamSync', client)({ workId: 'w' });

            const options = trigger.mock.calls[0][2] as Record<string, unknown>;
            expect(options.tags).toEqual(['app-upstream-sync', 'work:w', 'trigger:schedule']);
            expect(options.idempotencyKey).toBe('app-upstream-sync:w:schedule:202610291015');
            expect(options.idempotencyKey).toBe(appUpstreamSyncIdempotencyKey('w', 'schedule'));
        } finally {
            vi.useRealTimers();
        }
    });

    it('dispatchAppBlueprintApply uses the same idempotency key as the singleton', async () => {
        const { trigger, client } = tenantClient();
        const payload = { workId: 'w', mode: 'apply', version: '1.0.0' };

        await dispatcher('dispatchAppBlueprintApply', client)(payload);

        const options = trigger.mock.calls[0][2] as Record<string, unknown>;
        expect(options.idempotencyKey).toBe('app-blueprint-apply:w:apply:1.0.0:');
        expect(options.idempotencyKey).toBe(appBlueprintApplyIdempotencyKey(payload as never));
    });

    it.each(['dispatchAppDeploy', 'dispatchAppClusterOp'])(
        '%s turns delayMs into the runtime delay',
        async (name) => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-10-29T10:00:00.000Z'));
            try {
                const { trigger, client } = tenantClient();
                await dispatcher(name, client)(
                    { workId: 'w', deploymentId: 'd1', op: 'pause' },
                    { delayMs: 5000 },
                );

                const options = trigger.mock.calls[0][2] as Record<string, unknown>;
                expect(options.delay).toEqual(new Date('2026-10-29T10:00:05.000Z'));
            } finally {
                vi.useRealTimers();
            }
        },
    );

    it("dispatchAppClusterOp gives verification-deploy the task module's 3 600 s budget", async () => {
        const { trigger, client } = tenantClient();
        await dispatcher(
            'dispatchAppClusterOp',
            client,
        )({ workId: 'w', op: 'verification-deploy' });

        expect(trigger.mock.calls[0][2]).toMatchObject({ maxDuration: 3600 });
        const source = readFileSync(
            join(srcDir, 'tasks', 'trigger', 'app-cluster-op.task.ts'),
            'utf8',
        );
        expect(source).toMatch(
            /export const APP_CLUSTER_OP_VERIFICATION_MAX_DURATION = 3600 as const;/,
        );
    });

    describe('in production', () => {
        const env = { ...process.env };

        afterEach(() => {
            process.env.NODE_ENV = env.NODE_ENV;
            if (env.EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED === undefined) {
                delete process.env.EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED;
            } else {
                process.env.EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED =
                    env.EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED;
            }
        });

        it.each(['dispatchAppDeploy', 'dispatchAppClusterOp'])(
            '%s enqueues nothing without the worker-isolation attestation, as the singleton refuses',
            async (name) => {
                process.env.NODE_ENV = 'production';
                delete process.env.EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED;
                const { trigger, client } = tenantClient();

                await expect(
                    dispatcher(name, client)({ workId: 'w', deploymentId: 'd1', op: 'pause' }),
                ).resolves.toBeNull();
                expect(trigger).not.toHaveBeenCalled();
            },
        );

        it.each(['dispatchAppDeploy', 'dispatchAppClusterOp'])(
            '%s enqueues on the tenant client once the operator attests',
            async (name) => {
                process.env.NODE_ENV = 'production';
                process.env.EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED = 'true';
                const { trigger, client } = tenantClient();

                await expect(
                    dispatcher(name, client)({ workId: 'w', deploymentId: 'd1', op: 'pause' }),
                ).resolves.toBe('tenant-app-run');
                expect(trigger).toHaveBeenCalledTimes(1);
            },
        );
    });
});
