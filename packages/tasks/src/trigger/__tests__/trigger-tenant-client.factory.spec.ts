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

import {
    createTenantTriggerClient,
    dispatchersFromTenantClient,
} from '../trigger-tenant-client.factory';
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
