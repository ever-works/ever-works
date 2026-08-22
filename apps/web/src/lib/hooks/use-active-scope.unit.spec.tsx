import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrganizationResponse } from '@ever-works/contracts/api';

const paramsMock = vi.fn<() => { slug?: string }>();
vi.mock('next/navigation', () => ({
    useParams: () => paramsMock(),
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
        paramsMock.mockReset().mockReturnValue({});
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
        paramsMock.mockReturnValue({ slug: 'ever' });

        const { result } = renderHook(() => useActiveScope());

        expect(result.current.activeOrganization?.id).toBe('org-ever');
        expect(result.current.slug).toBe('ever');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('restores the persisted Organization on an unprefixed legacy route', async () => {
        const { result } = renderHook(() => useActiveScope());

        await waitFor(() => expect(result.current.activeOrganization?.id).toBe('org-yo'));
        expect(fetch).toHaveBeenCalledWith(
            '/api/users/me/scope',
            expect.objectContaining({ method: 'GET' }),
        );
    });

    it('reflects a successfully persisted switch immediately without localStorage', async () => {
        const { result } = renderHook(() => useActiveScope());
        await waitFor(() => expect(result.current.activeOrganization?.id).toBe('org-yo'));

        act(() => result.current.setActiveOrganization(ever));

        expect(result.current.activeOrganization?.id).toBe('org-ever');
        expect(result.current.slug).toBe('ever');
    });
});
