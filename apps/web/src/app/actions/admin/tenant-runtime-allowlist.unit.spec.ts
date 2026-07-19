// EW-742 P5.1 (T35a UI follow-up) — coverage-driven unit spec for the two
// operator-scoped Server Actions wrapping the per-tenant runtime allow-list
// REST API.
//
// Targets: apps/web/src/app/actions/admin/tenant-runtime-allowlist.ts
//   - ensurePlatformAdmin() gating: missing session → redirect to login;
//     non-admin profile (explicit isPlatformAdmin === false) → redirect to "/"
//     (route-doesn't-exist posture); getProfile() rejection → null profile
//     PROCEEDS (the operator IsPlatformAdminGuard is the authoritative gate).
//   - replaceTenantRuntimeAllowlistAction: happy path returns
//     { success, data, error: null }, calls operatorTenantRuntimeAllowlistAPI.replace
//     with ordered providerIds, revalidates the admin page route, surfaces
//     ApiResponseError.message / generic Error.message / fallback copy.
//   - deleteTenantRuntimeAllowlistEntryAction: same shape, calls deleteEntry
//     with (tenantId, providerId), error mapping mirrors replace.
//
// Before: 0 spec lines covering this module. After: ~14 cases pinning the
// auth gate + both action paths + the three error-mapping branches.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
    redirectMock,
    revalidatePathMock,
    getAuthFromCookieMock,
    getProfileMock,
    replaceMock,
    deleteEntryMock,
} = vi.hoisted(() => ({
    redirectMock: vi.fn((_path: string) => {
        throw new Error('__REDIRECT__');
    }),
    revalidatePathMock: vi.fn(),
    getAuthFromCookieMock: vi.fn(),
    getProfileMock: vi.fn(),
    replaceMock: vi.fn(),
    deleteEntryMock: vi.fn(),
}));

vi.mock('next/cache', () => ({
    revalidatePath: revalidatePathMock,
}));

vi.mock('next/navigation', () => ({
    redirect: redirectMock,
}));

vi.mock('@/lib/auth', () => ({
    getAuthFromCookie: getAuthFromCookieMock,
}));

vi.mock('@/lib/api', () => ({
    authAPI: {
        getProfile: getProfileMock,
    },
}));

vi.mock('@/lib/api/operator-tenant-runtime-allowlist', () => ({
    operatorTenantRuntimeAllowlistAPI: {
        replace: replaceMock,
        deleteEntry: deleteEntryMock,
    },
}));

import { ApiResponseError } from '@/lib/api/server-api';

const adminProfile = { isPlatformAdmin: true, id: 'op-1' };
const okResponse = {
    tenantId: 't-1',
    providerIds: ['trigger', 'bullmq'],
    perTenantGatingEnabled: true,
};

async function importActions() {
    return import('./tenant-runtime-allowlist');
}

describe('replaceTenantRuntimeAllowlistAction', () => {
    beforeEach(() => {
        redirectMock.mockClear();
        revalidatePathMock.mockClear();
        getAuthFromCookieMock.mockReset();
        getProfileMock.mockReset();
        replaceMock.mockReset();
        deleteEntryMock.mockReset();

        getAuthFromCookieMock.mockResolvedValue({ id: 'op-1' });
        getProfileMock.mockResolvedValue(adminProfile);
        replaceMock.mockResolvedValue(okResponse);
    });

    afterEach(() => vi.resetModules());

    it('returns { success: true, data, error: null } when the API call resolves', async () => {
        const { replaceTenantRuntimeAllowlistAction } = await importActions();
        const result = await replaceTenantRuntimeAllowlistAction('t-1', ['trigger', 'bullmq']);
        expect(result).toEqual({ success: true, data: okResponse, error: null });
    });

    it('forwards the tenantId and providerIds in the original order to operatorTenantRuntimeAllowlistAPI.replace', async () => {
        const { replaceTenantRuntimeAllowlistAction } = await importActions();
        const ids: ('trigger' | 'bullmq' | 'pgboss')[] = ['pgboss', 'trigger', 'bullmq'];
        await replaceTenantRuntimeAllowlistAction('t-99', ids);
        expect(replaceMock).toHaveBeenCalledTimes(1);
        expect(replaceMock).toHaveBeenCalledWith('t-99', ids);
    });

    it('revalidates the admin allow-list page route after a successful save', async () => {
        const { replaceTenantRuntimeAllowlistAction } = await importActions();
        await replaceTenantRuntimeAllowlistAction('t-1', []);
        expect(revalidatePathMock).toHaveBeenCalledTimes(1);
        const [pattern, kind] = revalidatePathMock.mock.calls[0]!;
        expect(pattern).toContain('/admin/tenants/');
        expect(pattern).toContain('/runtime-allowlist');
        expect(kind).toBe('page');
    });

    it('redirects to the login route when getAuthFromCookie returns null (unauthenticated)', async () => {
        getAuthFromCookieMock.mockResolvedValue(null);
        const { replaceTenantRuntimeAllowlistAction } = await importActions();
        await expect(replaceTenantRuntimeAllowlistAction('t-1', [])).rejects.toThrow(
            '__REDIRECT__',
        );
        expect(redirectMock).toHaveBeenCalledTimes(1);
        const target = redirectMock.mock.calls[0]![0] as string;
        expect(target.toLowerCase()).toContain('login');
        expect(replaceMock).not.toHaveBeenCalled();
    });

    it('redirects to "/" when the fresh profile is not a platform admin (route-not-found posture)', async () => {
        getProfileMock.mockResolvedValue({ isPlatformAdmin: false, id: 'op-1' });
        const { replaceTenantRuntimeAllowlistAction } = await importActions();
        await expect(replaceTenantRuntimeAllowlistAction('t-1', [])).rejects.toThrow(
            '__REDIRECT__',
        );
        expect(redirectMock).toHaveBeenCalledWith('/');
        expect(replaceMock).not.toHaveBeenCalled();
    });

    it('does NOT client-redirect when getProfile() rejects — null profile proceeds and the operator IsPlatformAdminGuard is the authoritative gate', async () => {
        // Contract (see ensurePlatformAdmin): only an EXPLICIT
        // `isPlatformAdmin === false` triggers the route-not-found redirect.
        // A rejected getProfile() resolves to null via `.catch(() => null)`,
        // which is NOT `=== false`, so the action proceeds to the REST call;
        // a real non-admin 403s there (surfaced as success:false). Redirecting
        // on null would bounce actual admins whenever getProfile has a
        // transient failure.
        getProfileMock.mockRejectedValue(new Error('upstream down'));
        const { replaceTenantRuntimeAllowlistAction } = await importActions();
        const result = await replaceTenantRuntimeAllowlistAction('t-1', []);
        expect(redirectMock).not.toHaveBeenCalled();
        expect(replaceMock).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ success: true, data: okResponse, error: null });
    });

    it('maps an ApiResponseError to { success: false, error: error.message } and skips revalidation', async () => {
        replaceMock.mockRejectedValue(
            new ApiResponseError('Allow-list capped at 5 providers', 400, 'TOO_MANY'),
        );
        const { replaceTenantRuntimeAllowlistAction } = await importActions();
        const result = await replaceTenantRuntimeAllowlistAction('t-1', []);
        expect(result.success).toBe(false);
        if (result.success === false) {
            expect(result.error).toBe('Allow-list capped at 5 providers');
            expect(result.data).toBeNull();
        }
        expect(revalidatePathMock).not.toHaveBeenCalled();
    });

    it('maps a generic Error.message when not an ApiResponseError', async () => {
        replaceMock.mockRejectedValue(new Error('network: ECONNREFUSED'));
        const { replaceTenantRuntimeAllowlistAction } = await importActions();
        const result = await replaceTenantRuntimeAllowlistAction('t-1', []);
        expect(result.success).toBe(false);
        if (result.success === false) {
            expect(result.error).toBe('network: ECONNREFUSED');
        }
    });

    it('falls back to a default error message when the rejection has no .message', async () => {
        replaceMock.mockRejectedValue('opaque rejection value');
        const { replaceTenantRuntimeAllowlistAction } = await importActions();
        const result = await replaceTenantRuntimeAllowlistAction('t-1', []);
        expect(result.success).toBe(false);
        if (result.success === false) {
            expect(result.error).toMatch(/failed/i);
            expect(result.error).toMatch(/allow-?list/i);
        }
    });

    it('treats an empty providerIds array as a clear-all (still calls replace + revalidates)', async () => {
        const { replaceTenantRuntimeAllowlistAction } = await importActions();
        await replaceTenantRuntimeAllowlistAction('t-1', []);
        expect(replaceMock).toHaveBeenCalledWith('t-1', []);
        expect(revalidatePathMock).toHaveBeenCalledTimes(1);
    });
});

describe('deleteTenantRuntimeAllowlistEntryAction', () => {
    beforeEach(() => {
        redirectMock.mockClear();
        revalidatePathMock.mockClear();
        getAuthFromCookieMock.mockReset();
        getProfileMock.mockReset();
        replaceMock.mockReset();
        deleteEntryMock.mockReset();

        getAuthFromCookieMock.mockResolvedValue({ id: 'op-1' });
        getProfileMock.mockResolvedValue(adminProfile);
        deleteEntryMock.mockResolvedValue(okResponse);
    });

    afterEach(() => vi.resetModules());

    it('returns { success: true, data, error: null } when the API call resolves', async () => {
        const { deleteTenantRuntimeAllowlistEntryAction } = await importActions();
        const result = await deleteTenantRuntimeAllowlistEntryAction('t-1', 'trigger');
        expect(result).toEqual({ success: true, data: okResponse, error: null });
    });

    it('forwards (tenantId, providerId) to operatorTenantRuntimeAllowlistAPI.deleteEntry', async () => {
        const { deleteTenantRuntimeAllowlistEntryAction } = await importActions();
        await deleteTenantRuntimeAllowlistEntryAction('t-77', 'pgboss');
        expect(deleteEntryMock).toHaveBeenCalledTimes(1);
        expect(deleteEntryMock).toHaveBeenCalledWith('t-77', 'pgboss');
    });

    it('revalidates the admin allow-list page route after a successful delete', async () => {
        const { deleteTenantRuntimeAllowlistEntryAction } = await importActions();
        await deleteTenantRuntimeAllowlistEntryAction('t-1', 'inngest');
        expect(revalidatePathMock).toHaveBeenCalledTimes(1);
        expect(revalidatePathMock.mock.calls[0]![1]).toBe('page');
    });

    it('still enforces the platform-admin gate on delete (non-admin profile redirects to "/")', async () => {
        getProfileMock.mockResolvedValue({ isPlatformAdmin: false, id: 'op-1' });
        const { deleteTenantRuntimeAllowlistEntryAction } = await importActions();
        await expect(deleteTenantRuntimeAllowlistEntryAction('t-1', 'trigger')).rejects.toThrow(
            '__REDIRECT__',
        );
        expect(redirectMock).toHaveBeenCalledWith('/');
        expect(deleteEntryMock).not.toHaveBeenCalled();
    });

    it('maps ApiResponseError.message into the error field on rejection', async () => {
        deleteEntryMock.mockRejectedValue(
            new ApiResponseError("Can't remove the last allow-listed provider", 409, 'LAST_ONE'),
        );
        const { deleteTenantRuntimeAllowlistEntryAction } = await importActions();
        const result = await deleteTenantRuntimeAllowlistEntryAction('t-1', 'trigger');
        expect(result.success).toBe(false);
        if (result.success === false) {
            expect(result.error).toContain('last allow-listed');
        }
        expect(revalidatePathMock).not.toHaveBeenCalled();
    });

    it('falls back to a default error copy when the rejection lacks a message', async () => {
        deleteEntryMock.mockRejectedValue(undefined);
        const { deleteTenantRuntimeAllowlistEntryAction } = await importActions();
        const result = await deleteTenantRuntimeAllowlistEntryAction('t-1', 'trigger');
        expect(result.success).toBe(false);
        if (result.success === false) {
            expect(result.error).toMatch(/failed/i);
            expect(result.error).toMatch(/remove/i);
        }
    });
});
