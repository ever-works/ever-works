import 'server-only';

import { API_URL } from '@/lib/constants';
import { OAuthProvider } from '@/lib/api/enums';

type AuthProvidersResponse = {
    emailPassword: boolean;
    magicLink?: boolean;
    socialProviders: string[];
};

export interface AuthProvidersConfig {
    socialProviders: OAuthProvider[];
    magicLinkEnabled: boolean;
}

async function fetchAuthProviders(): Promise<AuthProvidersResponse | null> {
    try {
        const response = await fetch(`${API_URL}/auth/providers`, {
            cache: 'no-store',
            next: { revalidate: 0 },
        });
        if (!response.ok) {
            return null;
        }
        return (await response.json()) as AuthProvidersResponse;
    } catch {
        return null;
    }
}

function filterSocialProviders(raw: string[] | undefined): OAuthProvider[] {
    return (raw ?? []).filter(
        (provider): provider is OAuthProvider =>
            provider === OAuthProvider.GITHUB ||
            provider === OAuthProvider.GOOGLE ||
            provider === OAuthProvider.FACEBOOK ||
            provider === OAuthProvider.LINKEDIN,
    );
}

export async function getConfiguredAuthProviders(): Promise<OAuthProvider[]> {
    const data = await fetchAuthProviders();
    if (!data) return [];
    return filterSocialProviders(data.socialProviders);
}

/**
 * EW-633 — full auth-provider config. Returns both the social provider
 * list and the magic-link availability flag so the login UI can render
 * the right tabs in a single API round-trip.
 */
export async function getAuthProvidersConfig(): Promise<AuthProvidersConfig> {
    const data = await fetchAuthProviders();
    if (!data) {
        return { socialProviders: [], magicLinkEnabled: false };
    }
    return {
        socialProviders: filterSocialProviders(data.socialProviders),
        magicLinkEnabled: data.magicLink === true,
    };
}
