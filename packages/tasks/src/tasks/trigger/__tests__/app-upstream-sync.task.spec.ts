import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * APW-02 T33 — `app-upstream-sync` (plan §6.3).
 *
 * Pinned: the registration (id + `maxDuration: 1_800`); the payload reaching
 * `AppUpstreamSyncService.run` with a `wait.for` sleep; the drained-credential skip; the
 * worker composition (no database module; the claim and the row through the internal
 * RPC proxies; the App spec and the licence service as remote proxies by the names the
 * API `remoteMap` publishes); and the named refusals.
 *
 * Every worker / agent import is mocked: the spec is about THIS file's wiring, and the
 * real modules pull the whole worker graph (and the agent's built output) in.
 */

const h = vi.hoisted(() => ({
    recorded: [] as Array<Record<string, unknown>>,
    waitFor: vi.fn(async () => undefined),
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
    loggerError: vi.fn(),
    createRemoteProxy: vi.fn((_client: unknown, name: string) => ({ __remote: name })),
    contextHolder: { current: undefined as unknown },
}));

vi.mock('@trigger.dev/sdk', () => ({
    task: (params: Record<string, unknown>) => {
        h.recorded.push(params);
        return params;
    },
    wait: { for: h.waitFor },
    logger: {
        info: h.loggerInfo,
        warn: h.loggerWarn,
        error: h.loggerError,
        debug: vi.fn(),
        log: vi.fn(),
    },
}));

vi.mock('@ever-works/agent/app-works', () => ({
    APP_UPSTREAM_LICENSE_SERVICE: Symbol.for('test:APP_UPSTREAM_LICENSE_SERVICE'),
    APP_UPSTREAM_SYNC_SPEC_SOURCE: Symbol.for('test:APP_UPSTREAM_SYNC_SPEC_SOURCE'),
    AppActionsHygieneService: class AppActionsHygieneService {},
    AppUpstreamStateService: class AppUpstreamStateService {},
    AppUpstreamSyncService: class AppUpstreamSyncService {},
}));
vi.mock('@ever-works/agent/database', () => ({
    WorkUpstreamStateRepository: class WorkUpstreamStateRepository {},
}));
vi.mock('@ever-works/agent/tasks', () => ({
    CredentialVersionService: class CredentialVersionService {},
}));
vi.mock('@ever-works/agent/utils', () => ({
    getOptionalProvider: (resolver: { get(token: unknown): unknown }, token: unknown) => {
        try {
            return resolver.get(token);
        } catch {
            return undefined;
        }
    },
}));
vi.mock('../../../trigger/worker/modules/trigger-internal.module', () => ({
    TriggerInternalModule: class TriggerInternalModule {},
    APP_UPSTREAM_STATE_SERVICE: 'AppUpstreamStateService',
    WORK_UPSTREAM_STATE_REPOSITORY: 'WorkUpstreamStateRepository',
}));
vi.mock('../../../trigger/worker/modules/trigger-facades.module', () => ({
    TriggerFacadesModule: class TriggerFacadesModule {},
}));
vi.mock('../../../trigger/worker/modules/trigger-plugins.module', () => ({
    TriggerPluginsModule: { forRoot: () => ({ module: 'TriggerPluginsModule' }) },
}));
vi.mock('../../../trigger/worker/modules/trigger-remote-cache.module', () => ({
    TriggerRemoteCacheModule: { forRoot: () => ({ module: 'TriggerRemoteCacheModule' }) },
}));
vi.mock('../../../trigger/worker/services/trigger-internal-api.client', () => ({
    TriggerInternalApiClient: class TriggerInternalApiClient {},
}));
vi.mock('../../../trigger/worker/services/tenant-runtime-binding-resolver.service', () => ({
    TenantRuntimeBindingResolverService: class TenantRuntimeBindingResolverService {},
}));
vi.mock('../../../trigger/worker/remote-proxy', () => ({
    createRemoteProxy: h.createRemoteProxy,
}));
vi.mock('../../../trigger/worker/utils/worker-context.utils', () => ({
    withWorkerContext: async (_name: string, fn: (ctx: unknown) => Promise<unknown>) =>
        fn(h.contextHolder.current),
}));

import {
    APP_UPSTREAM_LICENSE_SERVICE,
    APP_UPSTREAM_SYNC_SPEC_SOURCE,
    AppActionsHygieneService,
    AppUpstreamStateService,
    AppUpstreamSyncService,
} from '@ever-works/agent/app-works';
import { WorkUpstreamStateRepository } from '@ever-works/agent/database';
import { TenantRuntimeBindingResolverService } from '../../../trigger/worker/services/tenant-runtime-binding-resolver.service';
import {
    APP_UPSTREAM_SYNC_TASK_ID,
    AppUpstreamSyncWorkerModule,
    runAppUpstreamSyncTask,
    upstreamSyncSleep,
} from '../app-upstream-sync.task';

const WORK_ID = '0b1c2d3e-4444-4555-8666-777788889999';

type Provider = {
    provide?: unknown;
    useExisting?: unknown;
    useFactory?: (client: unknown) => unknown;
    inject?: unknown[];
};

function providers(): Array<Provider | (new (...args: never[]) => unknown)> {
    return (Reflect.getMetadata('providers', AppUpstreamSyncWorkerModule) as never) ?? [];
}

function binding(token: unknown): Provider | undefined {
    return providers().find(
        (provider) => typeof provider === 'object' && (provider as Provider).provide === token,
    ) as Provider | undefined;
}

describe('app-upstream-sync (APW-02 T33)', () => {
    let run: ReturnType<typeof vi.fn>;
    let resolveForWork: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        run = vi.fn(async () => ({
            workId: WORK_ID,
            outcome: 'settled',
            result: 'fast_forwarded',
            reason: 'fast_forwarded',
            providerCalls: 4,
        }));
        resolveForWork = vi.fn(async () => ({ status: 'resolved' }));
        h.contextHolder.current = {
            get: vi.fn((token: unknown) => {
                if (token === AppUpstreamSyncService) return { run };
                if (token === TenantRuntimeBindingResolverService) return { resolveForWork };
                return undefined;
            }),
        };
    });

    it('registers plan §6.3’s id and budget', () => {
        const registered = h.recorded.find((entry) => entry.id === APP_UPSTREAM_SYNC_TASK_ID);
        expect(APP_UPSTREAM_SYNC_TASK_ID).toBe('app-upstream-sync');
        expect(registered).toBeDefined();
        expect(registered?.maxDuration).toBe(1_800);
    });

    it('forwards the payload to AppUpstreamSyncService.run with a wait.for sleep', async () => {
        const result = await runAppUpstreamSyncTask({
            workId: WORK_ID,
            trigger: 'manual',
            providerId: 'github',
            credentialVersion: 3,
        });

        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0][0]).toEqual({
            workId: WORK_ID,
            trigger: 'manual',
            providerId: 'github',
            credentialVersion: 3,
        });
        expect(run.mock.calls[0][1]).toEqual({ sleep: upstreamSyncSleep });
        expect(result).toMatchObject({
            status: 'ran',
            workId: WORK_ID,
            outcome: 'settled',
            reason: 'fast_forwarded',
        });
    });

    it('defaults an unknown trigger to schedule', async () => {
        await runAppUpstreamSyncTask({ workId: WORK_ID, trigger: 'bogus' as never });
        expect(run.mock.calls[0][0]).toMatchObject({ trigger: 'schedule' });
    });

    it('sleeps through wait.for in whole seconds', async () => {
        await upstreamSyncSleep(5_000);
        await upstreamSyncSleep(1);
        expect(h.waitFor).toHaveBeenNthCalledWith(1, { seconds: 5 });
        expect(h.waitFor).toHaveBeenNthCalledWith(2, { seconds: 1 });
    });

    it('skips a run whose credentials were drained — no sync call', async () => {
        resolveForWork.mockResolvedValue({
            status: 'drained',
            providerId: 'github',
            credentialVersion: 2,
            tenantId: 't1',
        });

        const result = await runAppUpstreamSyncTask({ workId: WORK_ID, credentialVersion: 1 });

        expect(run).not.toHaveBeenCalled();
        expect(result).toMatchObject({ status: 'skipped', reason: 'credentials-drained' });
    });

    it('names an invalid payload and an absent service, never a green run', async () => {
        await expect(runAppUpstreamSyncTask({} as never)).resolves.toMatchObject({
            status: 'skipped',
            reason: 'invalid_payload',
        });

        h.contextHolder.current = { get: vi.fn(() => undefined) };
        await expect(runAppUpstreamSyncTask({ workId: WORK_ID })).resolves.toMatchObject({
            status: 'skipped',
            reason: 'serviceUnavailable',
        });
    });

    it('reports a throwing run as failed with its message', async () => {
        run.mockRejectedValue(new Error('Unknown remote target: AppUpstreamStateService'));

        await expect(runAppUpstreamSyncTask({ workId: WORK_ID })).resolves.toMatchObject({
            status: 'failed',
            reason: 'syncFailed',
            error: 'Unknown remote target: AppUpstreamStateService',
        });
    });

    describe('the worker composition', () => {
        it('imports no database module', () => {
            const imports = (Reflect.getMetadata('imports', AppUpstreamSyncWorkerModule) ??
                []) as unknown[];
            const names = imports.map((entry) =>
                typeof entry === 'function'
                    ? entry.name
                    : String((entry as { module?: unknown })?.module ?? entry),
            );
            expect(names).toEqual(
                expect.arrayContaining(['TriggerFacadesModule', 'TriggerInternalModule']),
            );
            expect(names.some((name) => /Database|TypeOrm/.test(name))).toBe(false);
        });

        it('reaches the claim (beginSync/finishSync) and the row through the RPC proxies', () => {
            expect(binding(AppUpstreamStateService)?.useExisting).toBe('AppUpstreamStateService');
            expect(binding(WorkUpstreamStateRepository)?.useExisting).toBe(
                'WorkUpstreamStateRepository',
            );
        });

        it('proxies the App spec and the licence service by their remoteMap names', () => {
            const client = {};
            expect(binding(APP_UPSTREAM_SYNC_SPEC_SOURCE)?.useFactory?.(client)).toEqual({
                __remote: 'AppSpecService',
            });
            expect(binding(APP_UPSTREAM_LICENSE_SERVICE)?.useFactory?.(client)).toEqual({
                __remote: 'AppLicenseService',
            });
        });

        it('provides the sync service and its hygiene collaborator locally', () => {
            expect(providers()).toEqual(
                expect.arrayContaining([AppUpstreamSyncService, AppActionsHygieneService]),
            );
        });
    });
});
