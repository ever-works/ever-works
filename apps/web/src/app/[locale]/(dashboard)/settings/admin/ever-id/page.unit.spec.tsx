import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    getProfile: vi.fn(),
    adminStatus: vi.fn(),
    adminHealth: vi.fn(),
    notFound: vi.fn(() => {
        throw new Error('NEXT_NOT_FOUND');
    }),
}));

vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/api', () => ({ authAPI: { getProfile: mocks.getProfile } }));
vi.mock('@/lib/api/ever-id', () => ({
    everIdAPI: { adminStatus: mocks.adminStatus, adminHealth: mocks.adminHealth },
}));
vi.mock('./ever-id-admin-client', () => ({ EverIdAdminClient: () => null }));

import EverIdAdminPage from './page';
import { EverIdAdminClient } from './ever-id-admin-client';

/**
 * APW-12 T51 — the administrator page is for platform administrators only, gated
 * the way `/admin/usage` is: an explicit `isPlatformAdmin === false` short-circuits
 * to 404 without an admin call, and the API's own 404 for anyone else becomes
 * `notFound()` too, so the route never advertises itself.
 */
describe('EverIdAdminPage gating', () => {
    beforeEach(() => {
        for (const fn of Object.values(mocks)) fn.mockClear();
        mocks.getProfile.mockReset();
        mocks.adminStatus.mockReset();
        mocks.adminHealth.mockReset();
    });

    it('404s a known non-administrator without calling the admin API', async () => {
        mocks.getProfile.mockResolvedValue({ isPlatformAdmin: false });

        await expect(EverIdAdminPage()).rejects.toThrow('NEXT_NOT_FOUND');
        expect(mocks.adminStatus).not.toHaveBeenCalled();
    });

    it('404s when the API refuses the status (anyone who is not an administrator)', async () => {
        mocks.getProfile.mockResolvedValue({});
        mocks.adminStatus.mockRejectedValue(new Error('404'));
        mocks.adminHealth.mockRejectedValue(new Error('404'));

        await expect(EverIdAdminPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('renders the surface for an administrator, tolerating missing health', async () => {
        const status = { enabled: true };
        mocks.getProfile.mockResolvedValue({});
        mocks.adminStatus.mockResolvedValue(status);
        mocks.adminHealth.mockRejectedValue(new Error('down'));

        const element = (await EverIdAdminPage()) as React.ReactElement<{
            initialStatus: unknown;
            initialHealth: unknown;
        }>;

        expect(element.type).toBe(EverIdAdminClient);
        expect(element.props.initialStatus).toBe(status);
        expect(element.props.initialHealth).toBeNull();
    });
});
