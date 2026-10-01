import type { ComponentProps, ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getAuthFromCookie: vi.fn(),
    wasSignedOutByEverId: vi.fn(),
    hasEverIdSignOutMarker: vi.fn(),
    getAuthProvidersConfig: vi.fn(),
    isEverIdOffered: vi.fn(),
    redirect: vi.fn(() => {
        throw new Error('NEXT_REDIRECT');
    }),
}));

vi.mock('next-intl/server', () => ({
    getLocale: async () => 'en',
    getTranslations: async () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/auth', () => ({
    getAuthFromCookie: mocks.getAuthFromCookie,
    wasSignedOutByEverId: mocks.wasSignedOutByEverId,
}));
vi.mock('@/lib/auth/ever-id-signed-out', () => ({
    hasEverIdSignOutMarker: mocks.hasEverIdSignOutMarker,
}));
vi.mock('@/lib/auth/providers', () => ({ getAuthProvidersConfig: mocks.getAuthProvidersConfig }));
vi.mock('@/lib/feature-flags/ever-id', () => ({
    EVER_ID_ANONYMOUS_DISTINCT_ID: 'anonymous',
    isEverIdOffered: mocks.isEverIdOffered,
}));
vi.mock('./login-client', () => ({ LoginClient: () => null }));

import { ROUTES } from '@/lib/constants';
import LoginPage from './page';
import { LoginClient } from './login-client';

/**
 * APW-12 — what the sign-in page hands its client: the Ever ID button only when
 * the switch and the flag allow it, and the S6 notice ("You were signed out of
 * Ever ID.") when this request saw the API end the stale session OR an earlier
 * action already removed the cookie and left the marker. A signed-in visitor is
 * redirected before any of it is looked at.
 */

type LoginClientProps = ComponentProps<typeof LoginClient>;

const EVER_ID_OFF = { enabled: false, displayName: 'Ever ID' };

async function renderedClientProps(): Promise<LoginClientProps> {
    const page = (await LoginPage()) as ReactElement<{ children: ReactElement<LoginClientProps> }>;
    const client = page.props.children;
    expect(client.type).toBe(LoginClient);
    return client.props;
}

describe('LoginPage — Ever ID props', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getAuthFromCookie.mockResolvedValue(null);
        mocks.wasSignedOutByEverId.mockReturnValue(false);
        mocks.hasEverIdSignOutMarker.mockResolvedValue(false);
        mocks.isEverIdOffered.mockResolvedValue(false);
        mocks.getAuthProvidersConfig.mockResolvedValue({
            socialProviders: ['github'],
            magicLinkEnabled: true,
            everId: EVER_ID_OFF,
        });
    });

    it('keeps the existing props and shows nothing new while Ever ID is off', async () => {
        const props = await renderedClientProps();

        expect(props).toMatchObject({
            availableSocialProviders: ['github'],
            magicLinkEnabled: true,
            everIdEnabled: false,
            signedOutByEverId: false,
        });
        expect(mocks.isEverIdOffered).toHaveBeenCalledWith(EVER_ID_OFF, 'anonymous');
    });

    it('offers the button when the switch and the flag allow it', async () => {
        mocks.isEverIdOffered.mockResolvedValue(true);

        expect((await renderedClientProps()).everIdEnabled).toBe(true);
    });

    it('shows the S6 notice when this request saw the API end the stale session', async () => {
        mocks.wasSignedOutByEverId.mockReturnValue(true);

        expect((await renderedClientProps()).signedOutByEverId).toBe(true);
        // Already known; the marker is not consulted.
        expect(mocks.hasEverIdSignOutMarker).not.toHaveBeenCalled();
    });

    it('shows the S6 notice from the marker when the cookie was already removed', async () => {
        mocks.hasEverIdSignOutMarker.mockResolvedValue(true);

        expect((await renderedClientProps()).signedOutByEverId).toBe(true);
    });

    it('redirects a signed-in visitor before looking at the flag or the marker', async () => {
        mocks.getAuthFromCookie.mockResolvedValue({ id: 'u1' });

        await expect(LoginPage()).rejects.toThrow('NEXT_REDIRECT');
        expect(mocks.redirect).toHaveBeenCalledWith({ locale: 'en', href: ROUTES.DASHBOARD });
        expect(mocks.isEverIdOffered).not.toHaveBeenCalled();
        expect(mocks.hasEverIdSignOutMarker).not.toHaveBeenCalled();
    });
});
