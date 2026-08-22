import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ApiResponseErrorMock, redirectMock, notFoundMock } = vi.hoisted(() => ({
    ApiResponseErrorMock: class ApiResponseError extends Error {
        constructor(
            message: string,
            public readonly statusCode: number,
        ) {
            super(message);
            this.name = 'ApiResponseError';
        }
    },
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
    ApiResponseError: ApiResponseErrorMock,
    serverFetch: vi.fn(),
}));

import { ApiResponseError, serverFetch } from '@/lib/api/server-api';
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

    it('renders not found when the active scope no longer exists', async () => {
        vi.mocked(serverFetch).mockRejectedValue(new ApiResponseError('Scope not found', 404));

        await expect(renderSlug('ever')).rejects.toThrow('NEXT_NOT_FOUND');
        expect(notFoundMock).toHaveBeenCalledTimes(1);
        expect(redirectMock).not.toHaveBeenCalled();
    });

    it.each([
        ['an unauthorized session', new ApiResponseError('Unauthorized', 401)],
        ['an upstream failure', new ApiResponseError('Unavailable', 503)],
        ['a network failure', new Error('socket disconnected')],
    ])('rethrows %s instead of disguising it as a missing route', async (_label, error) => {
        vi.mocked(serverFetch).mockRejectedValue(error);

        await expect(renderSlug('ever')).rejects.toBe(error);
        expect(notFoundMock).not.toHaveBeenCalled();
        expect(redirectMock).not.toHaveBeenCalled();
    });
});
