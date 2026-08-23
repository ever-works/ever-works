import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redirectMock, notFoundMock } = vi.hoisted(() => ({
    redirectMock: vi.fn(() => {
        throw new Error('NEXT_REDIRECT');
    }),
    notFoundMock: vi.fn(() => {
        throw new Error('NEXT_NOT_FOUND');
    }),
}));

vi.mock('next/navigation', () => ({ redirect: redirectMock, notFound: notFoundMock }));

import OrganizationDashboardCompatibilityPage from './page';

function renderSlug(slug: string) {
    return OrganizationDashboardCompatibilityPage({ params: Promise.resolve({ slug }) });
}

describe('/[slug]/dashboard compatibility route', () => {
    beforeEach(() => vi.clearAllMocks());

    it('redirects an unambiguous legacy slug to the canonical namespaced dashboard', async () => {
        await expect(renderSlug('ever')).rejects.toThrow('NEXT_REDIRECT');
        expect(redirectMock).toHaveBeenCalledWith('/org/ever/dashboard');
        expect(notFoundMock).not.toHaveBeenCalled();
    });

    it.each(['en', 'fr', 'settings', 'org', 'api', '@personal', 'bad/slug'])(
        'does not reinterpret locale, reserved, or malformed slug %s as an Organization',
        async (slug) => {
            await expect(renderSlug(slug)).rejects.toThrow('NEXT_NOT_FOUND');
            expect(redirectMock).not.toHaveBeenCalled();
        },
    );
});
