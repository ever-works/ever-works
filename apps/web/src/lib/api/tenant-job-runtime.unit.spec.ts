// EW-742 — regression spec for the tenant job-runtime overlay API wrapper.
//
// Targets: apps/web/src/lib/api/tenant-job-runtime.ts
//
// Primary purpose: pin the endpoint URL shape so the `/api/api/...`
// double-prefix bug can never come back. `serverFetch` / `serverMutation`
// prepend `API_URL` (normalised to end in `/api` by lib/constants.ts), so
// every endpoint passed here MUST be relative to `/api` — i.e. it must NOT
// start with `/api`. A regression here rendered the Job Runtime settings
// page unusable ("Cannot GET /api/api/account/job-runtime/config").
//
// Also covers the request envelope (method + wrapInData:false + body) for
// each of the six verbs and the convenience aliases.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { serverFetchMock, serverMutationMock } = vi.hoisted(() => ({
    serverFetchMock: vi.fn(),
    serverMutationMock: vi.fn(),
}));

vi.mock('./server-api', () => ({
    serverFetch: serverFetchMock,
    serverMutation: serverMutationMock,
}));

const configResponse = {
    tenantId: 't-1',
    providerId: null,
    mode: 'inherit',
    hasCredentials: false,
    credentialsSecretRefRedacted: null,
    credentialVersion: null,
    enabled: true,
    createdBy: null,
    createdAt: null,
    updatedAt: null,
};

async function importApi() {
    return import('./tenant-job-runtime');
}

beforeEach(() => {
    serverFetchMock.mockReset();
    serverMutationMock.mockReset();
    serverFetchMock.mockResolvedValue(configResponse);
    serverMutationMock.mockResolvedValue(configResponse);
});
afterEach(() => vi.resetModules());

describe('tenantJobRuntimeAPI — endpoint URL shape (no /api double-prefix)', () => {
    it('getConfig hits /account/job-runtime/config WITHOUT a leading /api', async () => {
        const { tenantJobRuntimeAPI } = await importApi();
        await tenantJobRuntimeAPI.getConfig();
        expect(serverFetchMock).toHaveBeenCalledTimes(1);
        expect(serverFetchMock).toHaveBeenCalledWith('/account/job-runtime/config');
    });

    it('getAvailableProviders hits /account/job-runtime/available-providers', async () => {
        const { tenantJobRuntimeAPI } = await importApi();
        await tenantJobRuntimeAPI.getAvailableProviders();
        expect(serverFetchMock).toHaveBeenCalledWith('/account/job-runtime/available-providers');
    });

    it('upsertConfig PUTs to /account/job-runtime/config with the raw payload', async () => {
        const { tenantJobRuntimeAPI } = await importApi();
        const payload = { providerId: 'trigger', mode: 'byo' } as const;
        await tenantJobRuntimeAPI.upsertConfig(payload);
        expect(serverMutationMock).toHaveBeenCalledWith({
            endpoint: '/account/job-runtime/config',
            data: payload,
            method: 'PUT',
            wrapInData: false,
        });
    });

    it('rotate POSTs to /account/job-runtime/rotate', async () => {
        const { tenantJobRuntimeAPI } = await importApi();
        await tenantJobRuntimeAPI.rotate();
        expect(serverMutationMock).toHaveBeenCalledWith({
            endpoint: '/account/job-runtime/rotate',
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    });

    it('forceInvalidate POSTs to /account/job-runtime/force-invalidate', async () => {
        const { tenantJobRuntimeAPI } = await importApi();
        await tenantJobRuntimeAPI.forceInvalidate();
        expect(serverMutationMock).toHaveBeenCalledWith({
            endpoint: '/account/job-runtime/force-invalidate',
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    });

    it('revertToInherit DELETEs /account/job-runtime/config', async () => {
        const { tenantJobRuntimeAPI } = await importApi();
        await tenantJobRuntimeAPI.revertToInherit();
        expect(serverMutationMock).toHaveBeenCalledWith({
            endpoint: '/account/job-runtime/config',
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    });

    it('NONE of the six verbs ever passes an endpoint starting with /api', async () => {
        const { tenantJobRuntimeAPI } = await importApi();
        // Independent calls — fire concurrently (we only assert the set of
        // endpoints hit, not their order).
        await Promise.all([
            tenantJobRuntimeAPI.getConfig(),
            tenantJobRuntimeAPI.getAvailableProviders(),
            tenantJobRuntimeAPI.upsertConfig({ providerId: 'trigger', mode: 'byo' }),
            tenantJobRuntimeAPI.rotate(),
            tenantJobRuntimeAPI.forceInvalidate(),
            tenantJobRuntimeAPI.revertToInherit(),
        ]);

        const fetchEndpoints = serverFetchMock.mock.calls.map((c) => c[0] as string);
        const mutationEndpoints = serverMutationMock.mock.calls.map(
            (c) => (c[0] as { endpoint: string }).endpoint,
        );
        for (const endpoint of [...fetchEndpoints, ...mutationEndpoints]) {
            expect(endpoint.startsWith('/api')).toBe(false);
            expect(endpoint).not.toContain('/api/');
        }
    });
});

describe('tenantJobRuntimeAPI — convenience aliases delegate to the namespaced object', () => {
    it('getJobRuntimeConfig delegates to getConfig', async () => {
        const { getJobRuntimeConfig } = await importApi();
        await getJobRuntimeConfig();
        expect(serverFetchMock).toHaveBeenCalledWith('/account/job-runtime/config');
    });

    it('getAvailableJobRuntimeProviders delegates to getAvailableProviders', async () => {
        const { getAvailableJobRuntimeProviders } = await importApi();
        await getAvailableJobRuntimeProviders();
        expect(serverFetchMock).toHaveBeenCalledWith('/account/job-runtime/available-providers');
    });

    it('upsertJobRuntimeConfig delegates to upsertConfig', async () => {
        const { upsertJobRuntimeConfig } = await importApi();
        await upsertJobRuntimeConfig({ providerId: 'bullmq', mode: 'override' });
        expect(serverMutationMock).toHaveBeenCalledWith(
            expect.objectContaining({
                endpoint: '/account/job-runtime/config',
                method: 'PUT',
            }),
        );
    });

    it('rotateJobRuntimeConfig delegates to rotate', async () => {
        const { rotateJobRuntimeConfig } = await importApi();
        await rotateJobRuntimeConfig();
        expect(serverMutationMock).toHaveBeenCalledWith(
            expect.objectContaining({
                endpoint: '/account/job-runtime/rotate',
                method: 'POST',
            }),
        );
    });

    it('forceInvalidateJobRuntimeConfig delegates to forceInvalidate', async () => {
        const { forceInvalidateJobRuntimeConfig } = await importApi();
        await forceInvalidateJobRuntimeConfig();
        expect(serverMutationMock).toHaveBeenCalledWith(
            expect.objectContaining({
                endpoint: '/account/job-runtime/force-invalidate',
                method: 'POST',
            }),
        );
    });

    it('deleteJobRuntimeConfig delegates to revertToInherit', async () => {
        const { deleteJobRuntimeConfig } = await importApi();
        await deleteJobRuntimeConfig();
        expect(serverMutationMock).toHaveBeenCalledWith(
            expect.objectContaining({
                endpoint: '/account/job-runtime/config',
                method: 'DELETE',
            }),
        );
    });
});
