import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrganizationResponse } from '@ever-works/contracts/api';

const pathnameMock = vi.fn<() => string>();
vi.mock('next/navigation', () => ({
    usePathname: () => pathnameMock(),
}));

import { useActiveScope } from './use-active-scope';
import {
    __resetOrganizationsStoreForTests,
    __seedOrganizationsStoreForTests,
} from './use-organizations';

const ever = {
    id: 'org-ever',
    tenantId: 'tenant-1',
    slug: 'ever',
    displayName: 'Ever',
} as OrganizationResponse;
const yo = {
    id: 'org-yo',
    tenantId: 'tenant-1',
    slug: 'yo-inc',
    displayName: 'Yo Incorporated',
} as OrganizationResponse;

describe('useActiveScope', () => {
    beforeEach(() => {
        __resetOrganizationsStoreForTests();
        __seedOrganizationsStoreForTests({ data: [yo, ever], isLoading: false, error: null });
        pathnameMock.mockReset().mockReturnValue('/dashboard');
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({
                    tenantId: 'tenant-1',
                    organizationId: 'org-yo',
                    organizationSlug: 'yo-inc',
                }),
            }),
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('uses the route slug as the canonical active scope when one is present', () => {
        pathnameMock.mockReturnValue('/org/ever/dashboard');

        const { result } = renderHook(() => useActiveScope());

        expect(result.current.activeOrganization?.id).toBe('org-ever');
        expect(result.current.slug).toBe('ever');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('keeps an unprefixed route explicitly personal without reading persisted preference', () => {
        const { result } = renderHook(() => useActiveScope());

        expect(result.current.activeOrganization).toBeNull();
        expect(result.current.slug).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('re-derives from the visible URL after navigation without shared module cache', () => {
        pathnameMock.mockReturnValue('/org/ever/dashboard');
        const { result, rerender, unmount } = renderHook(() => useActiveScope());
        expect(result.current.activeOrganization?.id).toBe('org-ever');

        pathnameMock.mockReturnValue('/org/yo-inc/dashboard');
        rerender();
        expect(result.current.activeOrganization?.id).toBe('org-yo');

        unmount();
        pathnameMock.mockReturnValue('/dashboard');
        const fresh = renderHook(() => useActiveScope());
        expect(fresh.result.current.activeOrganization).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
    });
});
