// EW-742 P5.1 (T35a UI follow-up) — coverage-driven unit spec for the
// operator-scoped per-tenant runtime allow-list API wrapper.
//
// Targets: apps/web/src/lib/api/operator-tenant-runtime-allowlist.ts
//   - URL construction (`/api/operator/tenants/:tenantId/runtime-allowlist`)
//   - .list() uses serverFetch (GET)
//   - .replace() uses serverMutation with PUT + { providerIds } body + wrapInData: false
//   - .deleteEntry() uses serverMutation with DELETE + /:providerId suffix
//   - Convenience aliases (getTenantRuntimeAllowlist / replaceTenantRuntimeAllowlist /
//     deleteTenantRuntimeAllowlistEntry) delegate to the namespaced object
//
// Before: 0 spec lines covering this module. After: ~15 cases pinning the
// URL shape and the request envelope for all three verbs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { serverFetchMock, serverMutationMock } = vi.hoisted(() => ({
    serverFetchMock: vi.fn(),
    serverMutationMock: vi.fn(),
}));

vi.mock('./server-api', () => ({
    serverFetch: serverFetchMock,
    serverMutation: serverMutationMock,
}));

const okResponse = {
    tenantId: 't-1',
    providerIds: ['trigger', 'bullmq'] as const,
    perTenantGatingEnabled: true,
};

async function importApi() {
    return import('./operator-tenant-runtime-allowlist');
}

describe('operatorTenantRuntimeAllowlistAPI.list', () => {
    beforeEach(() => {
        serverFetchMock.mockReset();
        serverMutationMock.mockReset();
        serverFetchMock.mockResolvedValue(okResponse);
    });
    afterEach(() => vi.resetModules());

    it('calls serverFetch with the operator-scoped per-tenant URL', async () => {
        const { operatorTenantRuntimeAllowlistAPI } = await importApi();
        await operatorTenantRuntimeAllowlistAPI.list('t-abc');
        expect(serverFetchMock).toHaveBeenCalledTimes(1);
        expect(serverFetchMock).toHaveBeenCalledWith(
            '/api/operator/tenants/t-abc/runtime-allowlist',
        );
    });

    it('returns the parsed response verbatim (no client-side reshaping)', async () => {
        const { operatorTenantRuntimeAllowlistAPI } = await importApi();
        const out = await operatorTenantRuntimeAllowlistAPI.list('t-1');
        expect(out).toBe(okResponse);
    });

    it('does not touch serverMutation on a read path', async () => {
        const { operatorTenantRuntimeAllowlistAPI } = await importApi();
        await operatorTenantRuntimeAllowlistAPI.list('t-1');
        expect(serverMutationMock).not.toHaveBeenCalled();
    });

    it('propagates rejections from serverFetch unchanged (caller maps the error)', async () => {
        serverFetchMock.mockRejectedValue(new Error('upstream 503'));
        const { operatorTenantRuntimeAllowlistAPI } = await importApi();
        await expect(operatorTenantRuntimeAllowlistAPI.list('t-1')).rejects.toThrow('upstream 503');
    });
});

describe('operatorTenantRuntimeAllowlistAPI.replace', () => {
    beforeEach(() => {
        serverFetchMock.mockReset();
        serverMutationMock.mockReset();
        serverMutationMock.mockResolvedValue(okResponse);
    });
    afterEach(() => vi.resetModules());

    it('PUTs to the per-tenant allow-list URL with a { providerIds } body', async () => {
        const { operatorTenantRuntimeAllowlistAPI } = await importApi();
        await operatorTenantRuntimeAllowlistAPI.replace('t-7', ['trigger', 'bullmq']);
        expect(serverMutationMock).toHaveBeenCalledTimes(1);
        expect(serverMutationMock).toHaveBeenCalledWith({
            endpoint: '/api/operator/tenants/t-7/runtime-allowlist',
            data: { providerIds: ['trigger', 'bullmq'] },
            method: 'PUT',
            wrapInData: false,
        });
    });

    it('passes wrapInData: false so the body is the literal payload, not { data: {...} }', async () => {
        const { operatorTenantRuntimeAllowlistAPI } = await importApi();
        await operatorTenantRuntimeAllowlistAPI.replace('t-1', []);
        const arg = serverMutationMock.mock.calls[0]![0];
        expect(arg.wrapInData).toBe(false);
    });

    it('preserves the providerIds order verbatim (controller relies on caller-supplied order)', async () => {
        const { operatorTenantRuntimeAllowlistAPI } = await importApi();
        await operatorTenantRuntimeAllowlistAPI.replace('t-1', ['inngest', 'pgboss', 'temporal']);
        const body = serverMutationMock.mock.calls[0]![0].data;
        expect(body.providerIds).toEqual(['inngest', 'pgboss', 'temporal']);
    });

    it('allows an empty providerIds list (clear-all case)', async () => {
        const { operatorTenantRuntimeAllowlistAPI } = await importApi();
        await operatorTenantRuntimeAllowlistAPI.replace('t-1', []);
        const body = serverMutationMock.mock.calls[0]![0].data;
        expect(body.providerIds).toEqual([]);
    });

    it('returns the parsed mutation response (caller forwards data to UI)', async () => {
        const { operatorTenantRuntimeAllowlistAPI } = await importApi();
        const out = await operatorTenantRuntimeAllowlistAPI.replace('t-1', []);
        expect(out).toBe(okResponse);
    });
});

describe('operatorTenantRuntimeAllowlistAPI.deleteEntry', () => {
    beforeEach(() => {
        serverFetchMock.mockReset();
        serverMutationMock.mockReset();
        serverMutationMock.mockResolvedValue(okResponse);
    });
    afterEach(() => vi.resetModules());

    it('DELETEs to /:providerId under the per-tenant URL', async () => {
        const { operatorTenantRuntimeAllowlistAPI } = await importApi();
        await operatorTenantRuntimeAllowlistAPI.deleteEntry('t-7', 'trigger');
        expect(serverMutationMock).toHaveBeenCalledTimes(1);
        expect(serverMutationMock).toHaveBeenCalledWith({
            endpoint: '/api/operator/tenants/t-7/runtime-allowlist/trigger',
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    });

    it('sends an empty {} body (REST DELETE semantics) — caller cannot smuggle extra fields', async () => {
        const { operatorTenantRuntimeAllowlistAPI } = await importApi();
        await operatorTenantRuntimeAllowlistAPI.deleteEntry('t-1', 'bullmq');
        expect(serverMutationMock.mock.calls[0]![0].data).toEqual({});
    });

    it('returns the parsed mutation response (caller updates the UI saved-list view)', async () => {
        const { operatorTenantRuntimeAllowlistAPI } = await importApi();
        const out = await operatorTenantRuntimeAllowlistAPI.deleteEntry('t-1', 'pgboss');
        expect(out).toBe(okResponse);
    });
});

describe('convenience aliases', () => {
    beforeEach(() => {
        serverFetchMock.mockReset();
        serverMutationMock.mockReset();
        serverFetchMock.mockResolvedValue(okResponse);
        serverMutationMock.mockResolvedValue(okResponse);
    });
    afterEach(() => vi.resetModules());

    it('getTenantRuntimeAllowlist delegates to .list(tenantId)', async () => {
        const { getTenantRuntimeAllowlist } = await importApi();
        await getTenantRuntimeAllowlist('t-99');
        expect(serverFetchMock).toHaveBeenCalledWith(
            '/api/operator/tenants/t-99/runtime-allowlist',
        );
    });

    it('replaceTenantRuntimeAllowlist delegates to .replace(tenantId, providerIds)', async () => {
        const { replaceTenantRuntimeAllowlist } = await importApi();
        await replaceTenantRuntimeAllowlist('t-99', ['trigger']);
        expect(serverMutationMock).toHaveBeenCalledWith(
            expect.objectContaining({
                endpoint: '/api/operator/tenants/t-99/runtime-allowlist',
                method: 'PUT',
                data: { providerIds: ['trigger'] },
            }),
        );
    });

    it('deleteTenantRuntimeAllowlistEntry delegates to .deleteEntry(tenantId, providerId)', async () => {
        const { deleteTenantRuntimeAllowlistEntry } = await importApi();
        await deleteTenantRuntimeAllowlistEntry('t-99', 'inngest');
        expect(serverMutationMock).toHaveBeenCalledWith(
            expect.objectContaining({
                endpoint: '/api/operator/tenants/t-99/runtime-allowlist/inngest',
                method: 'DELETE',
            }),
        );
    });
});
