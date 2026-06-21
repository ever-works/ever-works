import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * EW-742 P3.2 T22 — deep edge coverage for `createTenantTriggerClient`
 * + `dispatchersFromTenantClient` on top of the canonical happy-path
 * `trigger-tenant-client.factory.spec.ts`. Pins:
 *
 *   - apiUrl boundary cases (empty string vs undefined vs schemeless).
 *   - Per-call `clientConfig` isolation under 50-way concurrent dispatch
 *     between two distinct tenant clients (no cross-pollution).
 *   - `withAuth` receiving the right clientConfig for runs.cancel +
 *     runs.retrieve.
 *   - Multiple dispatcher maps from the SAME client share clientConfig.
 *   - The returned dispatchers map is frozen — mutation attempts throw
 *     in strict mode.
 *   - Memory hygiene: constructing 1000 clients in a tight loop doesn't
 *     blow up the heap (loose assert).
 *
 * The Trigger.dev SDK v4 surface is fully mocked — never touches the
 * network. Mirror the hoisted-mock idiom used in the canonical spec.
 */

const { tasksTriggerMock, runsCancelMock, runsRetrieveMock, withAuthMock } = vi.hoisted(() => ({
    tasksTriggerMock: vi.fn(),
    runsCancelMock: vi.fn(),
    runsRetrieveMock: vi.fn(),
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

const baseCreds = (overrides: Partial<{ apiUrl: string }> = {}) => ({
    accessToken: 'tr_pat_x',
    secretKey: 'tr_dev_x',
    projectRef: 'proj_x',
    ...overrides,
});

describe('createTenantTriggerClient — apiUrl boundary cases', () => {
    beforeEach(() => {
        tasksTriggerMock.mockReset().mockResolvedValue({ id: 'run_default' });
        runsCancelMock.mockReset().mockResolvedValue(undefined);
        runsRetrieveMock.mockReset().mockResolvedValue({ id: 'r1', status: 'EXECUTING' });
        withAuthMock.mockReset().mockImplementation((_c, fn) => fn());
    });

    it('credentials.apiUrl === "" (empty string) → baseURL is the empty string (NOT replaced by DEFAULT)', async () => {
        // `??` only fires on null/undefined — an empty string is a string
        // and falls through verbatim. Operators that want the default
        // must omit the field entirely, not set it to "". Pins this
        // gotcha so a future "treat empty as default" change is a
        // visible behavioural choice.
        const client = createTenantTriggerClient(baseCreds({ apiUrl: '' }));
        await client.tasks.trigger('t', {});
        const requestOptions = tasksTriggerMock.mock.calls[0][3];
        expect(requestOptions).toEqual({
            clientConfig: { accessToken: 'tr_dev_x', baseURL: '' },
        });
    });

    it('credentials.apiUrl undefined → baseURL is DEFAULT_TRIGGER_API_URL', async () => {
        const client = createTenantTriggerClient(baseCreds());
        await client.tasks.trigger('t', {});
        const requestOptions = tasksTriggerMock.mock.calls[0][3];
        expect(requestOptions.clientConfig.baseURL).toBe(DEFAULT_TRIGGER_API_URL);
    });

    it('credentials.apiUrl with no scheme → passed verbatim (SDK / operator handles or fails)', async () => {
        const client = createTenantTriggerClient(baseCreds({ apiUrl: 'trigger.tenant-x.internal' }));
        await client.tasks.trigger('t', {});
        const requestOptions = tasksTriggerMock.mock.calls[0][3];
        expect(requestOptions.clientConfig.baseURL).toBe('trigger.tenant-x.internal');
    });

    it.each([
        ['trailing slash', 'https://trigger.example.com/'],
        ['custom port', 'https://trigger.example.com:8443'],
        ['plain http', 'http://localhost:3030'],
        ['ipv4 + port', 'http://127.0.0.1:8080'],
    ])('apiUrl %s → propagated to clientConfig.baseURL verbatim', async (_label, apiUrl) => {
        const client = createTenantTriggerClient(baseCreds({ apiUrl }));
        await client.tasks.trigger('t', {});
        const requestOptions = tasksTriggerMock.mock.calls[0][3];
        expect(requestOptions.clientConfig.baseURL).toBe(apiUrl);
    });

    it('clientConfig object is frozen (per-call isolation invariant)', async () => {
        const client = createTenantTriggerClient(baseCreds());
        await client.tasks.trigger('t', {});
        const cfg = tasksTriggerMock.mock.calls[0][3].clientConfig;
        expect(Object.isFrozen(cfg)).toBe(true);
    });
});

describe('createTenantTriggerClient — concurrent multi-tenant dispatch isolation', () => {
    beforeEach(() => {
        tasksTriggerMock.mockReset().mockResolvedValue({ id: 'run_concurrent' });
        runsCancelMock.mockReset();
        runsRetrieveMock.mockReset();
        withAuthMock.mockReset().mockImplementation((_c, fn) => fn());
    });

    it('50 concurrent tasks.trigger calls across 2 clients → each call carries the right clientConfig', async () => {
        const clientA = createTenantTriggerClient({
            accessToken: 'tr_pat_a',
            secretKey: 'tr_dev_a',
            projectRef: 'proj_a',
        });
        const clientB = createTenantTriggerClient({
            accessToken: 'tr_pat_b',
            secretKey: 'tr_dev_b',
            projectRef: 'proj_b',
            apiUrl: 'https://trigger.tenant-b.internal',
        });

        await Promise.all(
            Array.from({ length: 50 }, async (_, i) => {
                const useA = i % 2 === 0;
                const target = useA ? clientA : clientB;
                await target.tasks.trigger(`t-${randomUUID()}`, { i });
            }),
        );

        expect(tasksTriggerMock).toHaveBeenCalledTimes(50);
        for (let i = 0; i < 50; i++) {
            const payload = tasksTriggerMock.mock.calls[i][1] as { i: number };
            const cfg = tasksTriggerMock.mock.calls[i][3].clientConfig;
            // Map dispatch # → expected tenant by the parity rule above.
            const expectedSecret = payload.i % 2 === 0 ? 'tr_dev_a' : 'tr_dev_b';
            const expectedBase =
                payload.i % 2 === 0
                    ? DEFAULT_TRIGGER_API_URL
                    : 'https://trigger.tenant-b.internal';
            expect(cfg.accessToken).toBe(expectedSecret);
            expect(cfg.baseURL).toBe(expectedBase);
        }
    });

    it('two clients built with the same creds use independent (but equal) clientConfig objects on each call', async () => {
        const c1 = createTenantTriggerClient(baseCreds());
        const c2 = createTenantTriggerClient(baseCreds());
        await c1.tasks.trigger('t', {});
        await c2.tasks.trigger('t', {});
        const cfg1 = tasksTriggerMock.mock.calls[0][3].clientConfig;
        const cfg2 = tasksTriggerMock.mock.calls[1][3].clientConfig;
        expect(cfg1).toEqual(cfg2);
        // Different object identities — each `createTenantTriggerClient`
        // call constructs a fresh closure. Important so a hypothetical
        // global cache key bug can't collapse two tenants onto one
        // shared config.
        expect(cfg1).not.toBe(cfg2);
    });
});

describe('createTenantTriggerClient — runs.cancel + runs.retrieve auth scope', () => {
    beforeEach(() => {
        tasksTriggerMock.mockReset();
        runsCancelMock.mockReset().mockResolvedValue(undefined);
        runsRetrieveMock.mockReset().mockResolvedValue({ id: 'r', status: 'COMPLETED' });
        withAuthMock.mockReset().mockImplementation((_c, fn) => fn());
    });

    it('runs.cancel calls auth.withAuth with the tenant clientConfig AND invokes SDK runs.cancel(runId)', async () => {
        const client = createTenantTriggerClient(baseCreds({ apiUrl: 'https://t.example.com' }));
        await client.runs.cancel('run_to_cancel');

        expect(withAuthMock).toHaveBeenCalledTimes(1);
        expect(withAuthMock.mock.calls[0][0]).toEqual({
            accessToken: 'tr_dev_x',
            baseURL: 'https://t.example.com',
        });
        expect(runsCancelMock).toHaveBeenCalledWith('run_to_cancel');
    });

    it('runs.retrieve calls auth.withAuth with the tenant clientConfig AND returns the SDK run record', async () => {
        runsRetrieveMock.mockResolvedValueOnce({ id: 'r2', status: 'EXECUTING' });
        const client = createTenantTriggerClient(baseCreds());
        const record = await client.runs.retrieve('r2');
        expect(record).toEqual({ id: 'r2', status: 'EXECUTING' });
        expect(withAuthMock.mock.calls[0][0]).toEqual({
            accessToken: 'tr_dev_x',
            baseURL: DEFAULT_TRIGGER_API_URL,
        });
    });

    it('multiple sequential runs.* calls all use the SAME clientConfig (closure capture)', async () => {
        const client = createTenantTriggerClient(baseCreds());
        await client.runs.cancel('a');
        await client.runs.cancel('b');
        await client.runs.retrieve('c');
        expect(withAuthMock).toHaveBeenCalledTimes(3);
        const cfgs = withAuthMock.mock.calls.map((c) => c[0]);
        expect(cfgs[0]).toBe(cfgs[1]);
        expect(cfgs[1]).toBe(cfgs[2]);
    });
});

describe('dispatchersFromTenantClient — dispatcher map invariants', () => {
    beforeEach(() => {
        tasksTriggerMock.mockReset();
        runsCancelMock.mockReset();
        runsRetrieveMock.mockReset();
        withAuthMock.mockReset();
    });

    it('two dispatcher maps built from the SAME client share the underlying client (auth scope shared)', async () => {
        const triggerFn = vi.fn().mockResolvedValue({ id: 'r' });
        const client = {
            tasks: { trigger: triggerFn },
            runs: { cancel: vi.fn(), retrieve: vi.fn() },
        };
        const dA = dispatchersFromTenantClient(client) as unknown as {
            dispatchKbEmbedDocument: (p: unknown) => Promise<string | null>;
        };
        const dB = dispatchersFromTenantClient(client) as unknown as {
            dispatchKbEmbedDocument: (p: unknown) => Promise<string | null>;
        };
        // Identity distinct (each call returns a new frozen map)…
        expect(dA).not.toBe(dB);
        // …but BOTH route through the SAME client's `tasks.trigger`.
        await dA.dispatchKbEmbedDocument({ workId: 'w', documentId: 'd' });
        await dB.dispatchKbEmbedDocument({ workId: 'w', documentId: 'd' });
        expect(triggerFn).toHaveBeenCalledTimes(2);
    });

    it('mutating the returned dispatcher object does NOT affect future invocations (frozen map invariant)', () => {
        const client = {
            tasks: { trigger: vi.fn() },
            runs: { cancel: vi.fn(), retrieve: vi.fn() },
        };
        const dispatchers = dispatchersFromTenantClient(client) as Record<string, unknown>;
        expect(Object.isFrozen(dispatchers)).toBe(true);
        expect(() => {
            (dispatchers as Record<string, unknown>).dispatchKbEmbedDocument = () => {
                throw new Error('hijacked');
            };
        }).toThrow(TypeError);
    });

    it('100 concurrent dispatchKbEmbedDocument calls land on the right client (no cross-pollution)', async () => {
        const triggerA = vi.fn().mockResolvedValue({ id: 'a' });
        const triggerB = vi.fn().mockResolvedValue({ id: 'b' });
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
        await Promise.all(
            Array.from({ length: 100 }, async (_, i) => {
                const target = i % 2 === 0 ? dA : dB;
                const workId = randomUUID();
                await target.dispatchKbEmbedDocument({ workId, documentId: 'd' });
            }),
        );
        expect(triggerA).toHaveBeenCalledTimes(50);
        expect(triggerB).toHaveBeenCalledTimes(50);
    });
});

describe('createTenantTriggerClient — memory hygiene', () => {
    it('constructing 1000 clients in a tight loop does not blow up the heap (loose assert)', () => {
        const before = process.memoryUsage().heapUsed;
        const clients: unknown[] = [];
        for (let i = 0; i < 1000; i++) {
            clients.push(
                createTenantTriggerClient({
                    accessToken: `tr_pat_${i}`,
                    secretKey: `tr_dev_${i}`,
                    projectRef: `proj_${i}`,
                }),
            );
        }
        // Sanity: all 1000 produced distinct objects.
        const ids = new Set(clients.map((c) => c));
        expect(ids.size).toBe(1000);
        const after = process.memoryUsage().heapUsed;
        // Loose upper bound: 1000 closure-laden objects + their frozen
        // clientConfigs should comfortably fit in < 50 MB delta. Tight
        // enough to catch a regression that leaks the whole module
        // graph per construction; loose enough not to flake on a busy
        // CI shard.
        expect(after - before).toBeLessThan(50 * 1024 * 1024);
    });
});
