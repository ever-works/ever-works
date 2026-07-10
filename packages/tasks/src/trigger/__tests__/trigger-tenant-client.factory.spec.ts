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

    it('the dispatchers map is frozen', () => {
        const fakeClient = {
            tasks: { trigger: vi.fn() },
            runs: { cancel: vi.fn(), retrieve: vi.fn() },
        };
        const dispatchers = dispatchersFromTenantClient(fakeClient);
        expect(Object.isFrozen(dispatchers)).toBe(true);
    });
});
