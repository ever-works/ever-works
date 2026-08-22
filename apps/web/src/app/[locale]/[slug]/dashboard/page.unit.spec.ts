import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redirectMock, notFoundMock } = vi.hoisted(() => ({
    redirectMock: vi.fn(() => {
        throw new Error('NEXT_REDIRECT');
    }),
    notFoundMock: vi.fn(() => {
        throw new Error('NEXT_NOT_FOUND');
    }),
}));

vi.mock('next/navigation', () => ({
    redirect: redirectMock,
    notFound: notFoundMock,
}));

vi.mock('@/lib/api/server-api', () => ({
    serverFetch: vi.fn(),
}));

import { serverFetch } from '@/lib/api/server-api';
import OrganizationDashboardCompatibilityPage from './page';

function renderSlug(slug: string) {
    return OrganizationDashboardCompatibilityPage({ params: Promise.resolve({ slug }) });
}

describe('/[slug]/dashboard compatibility route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('validates the persisted active Organization and redirects to the existing root dashboard', async () => {
        vi.mocked(serverFetch).mockResolvedValue({
            tenantId: 'tenant-1',
            organizationId: 'org-ever',
            organizationSlug: 'ever',
        });

        await expect(renderSlug('ever')).rejects.toThrow('NEXT_REDIRECT');
        expect(serverFetch).toHaveBeenCalledWith('/users/me/scope');
        expect(redirectMock).toHaveBeenCalledWith('/');
        expect(notFoundMock).not.toHaveBeenCalled();
    });

    it.each([
        ['another Organization is persisted', 'yo-inc'],
        ['personal scope is persisted', null],
    ])('fails closed when %s', async (_label, organizationSlug) => {
        vi.mocked(serverFetch).mockResolvedValue({
            tenantId: 'tenant-1',
            organizationId: organizationSlug ? 'another-org' : null,
            organizationSlug,
        });

        await expect(renderSlug('ever')).rejects.toThrow('NEXT_NOT_FOUND');
        expect(notFoundMock).toHaveBeenCalledTimes(1);
        expect(redirectMock).not.toHaveBeenCalled();
    });

    it('fails closed when the active-scope API cannot validate the session', async () => {
        vi.mocked(serverFetch).mockRejectedValue(new Error('Unauthorized'));

        await expect(renderSlug('ever')).rejects.toThrow('NEXT_NOT_FOUND');
        expect(notFoundMock).toHaveBeenCalledTimes(1);
        expect(redirectMock).not.toHaveBeenCalled();
    });
});
