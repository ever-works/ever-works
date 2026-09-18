import { describe, it, expect, vi } from 'vitest';
import {
    APP_UPSTREAM_STATE_SERVICE,
    APP_UPSTREAM_SYNC_DISPATCHER_SERVICE,
    TriggerInternalModule,
    WORK_UPSTREAM_STATE_REPOSITORY,
} from '../trigger-internal.module';

/**
 * APW-02 T28 — the three worker-side App upstream proxies.
 *
 * `TriggerInternalModule` is instantiated only inside a Trigger.dev task, which CI never
 * runs, and `tsc` cannot see a wrong string: `createRemoteProxy(apiClient, 'X')` compiles
 * for every `X`, and a name the API's `remoteMap` does not carry fails at call time with
 * `Unknown remote target: X` — in production, on the run that needed it. That is the
 * silent no-op this slice exists to remove (T26 reported the repository binding by name
 * for exactly that reason), so the names are pinned here rather than trusted.
 *
 * ## Why the providers are read off the module instead of booting it
 *
 * Booting `TriggerInternalModule` pulls `DatabaseModule`, the whole Work/Agents/Tasks
 * graph and a live DataSource into the worker test process — none of which these three
 * providers need (each is a single `useFactory(apiClient)`). `Reflect.getMetadata` reads
 * the **real** decorated providers, so the string under test is the one the module will
 * use in production, and `useFactory` is invoked exactly as Nest invokes it.
 */

/** The worker-side API client, reduced to the one call a proxy makes. */
function fakeApiClient(): {
    callRemote: ReturnType<typeof vi.fn>;
} {
    return {
        callRemote: vi.fn(async (name: string, method: string) => ({ name, method })),
    };
}

interface ProviderEntry {
    provide?: unknown;
    useFactory?: (client: unknown) => unknown;
    inject?: unknown[];
}

/** Every provider the module decorates, as Nest sees it. */
function providers(): ProviderEntry[] {
    return (Reflect.getMetadata('providers', TriggerInternalModule) as ProviderEntry[]) ?? [];
}

/** The `useFactory` provider registered for one token. */
function providerFor(token: string): ProviderEntry {
    const entry = providers().find((candidate) => candidate?.provide === token);
    expect(entry, `no provider is registered for ${token}`).toBeDefined();
    expect(typeof entry?.useFactory).toBe('function');
    return entry as ProviderEntry;
}

describe('TriggerInternalModule — the APW-02 upstream proxies (T28)', () => {
    it('exports all three tokens, so the job modules can resolve them from here', () => {
        const exports = (Reflect.getMetadata('exports', TriggerInternalModule) as unknown[]) ?? [];

        expect(exports).toContain(APP_UPSTREAM_STATE_SERVICE);
        expect(exports).toContain(APP_UPSTREAM_SYNC_DISPATCHER_SERVICE);
        expect(exports).toContain(WORK_UPSTREAM_STATE_REPOSITORY);
    });

    it('dials the API-side AppUpstreamStateService and nothing else', async () => {
        const client = fakeApiClient();
        const proxy = providerFor(APP_UPSTREAM_STATE_SERVICE).useFactory!(client) as {
            beginSync: (workId: string, trigger: string) => Promise<unknown>;
        };

        await proxy.beginSync('work-1', 'manual');

        expect(client.callRemote).toHaveBeenCalledTimes(1);
        expect(client.callRemote.mock.calls[0][0]).toBe('AppUpstreamStateService');
        expect(client.callRemote.mock.calls[0][1]).toBe('beginSync');
    });

    it('dials the API-side AppUpstreamSyncDispatcherService', async () => {
        const client = fakeApiClient();
        const proxy = providerFor(APP_UPSTREAM_SYNC_DISPATCHER_SERVICE).useFactory!(client) as {
            dispatchDue: (now: number) => Promise<unknown>;
        };

        await proxy.dispatchDue(1_700_000_000_000);

        expect(client.callRemote.mock.calls[0][0]).toBe('AppUpstreamSyncDispatcherService');
        expect(client.callRemote.mock.calls[0][1]).toBe('dispatchDue');
    });

    it('dials the API-side WorkUpstreamStateRepository — T26’s owed binding', async () => {
        const client = fakeApiClient();
        const proxy = providerFor(WORK_UPSTREAM_STATE_REPOSITORY).useFactory!(client) as {
            findByWorkId: (workId: string) => Promise<unknown>;
        };

        await proxy.findByWorkId('work-1');

        expect(client.callRemote.mock.calls[0][0]).toBe('WorkUpstreamStateRepository');
        expect(client.callRemote.mock.calls[0][1]).toBe('findByWorkId');
    });

    it('resolves each proxy from the shared TriggerInternalApiClient', () => {
        for (const token of [
            APP_UPSTREAM_STATE_SERVICE,
            APP_UPSTREAM_SYNC_DISPATCHER_SERVICE,
            WORK_UPSTREAM_STATE_REPOSITORY,
        ]) {
            // The client is the only dependency; a proxy wired to anything else (or to a
            // second client of its own) would dial a different environment than every
            // sibling proxy in this module.
            expect(providerFor(token).inject).toHaveLength(1);
        }
    });
});
