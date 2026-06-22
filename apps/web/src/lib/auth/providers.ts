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

const KNOWN_PROVIDERS: OAuthProvider[] = [
    OAuthProvider.GITHUB,
    OAuthProvider.GOOGLE,
    OAuthProvider.FACEBOOK,
    OAuthProvider.LINKEDIN,
];

function filterSocialProviders(raw: string[] | undefined): OAuthProvider[] {
    return (raw ?? []).filter((provider): provider is OAuthProvider =>
        KNOWN_PROVIDERS.includes(provider as OAuthProvider),
    );
}

// Warn once at startup so operators know an unset OAUTH_PROVIDERS means no login
// buttons appear during an API outage (silent empty-array fallback).
if (!process.env.OAUTH_PROVIDERS) {
    console.warn(
        '[ever-works] OAUTH_PROVIDERS is not set. If the API becomes unreachable, ' +
            'no OAuth login buttons will be shown. Set OAUTH_PROVIDERS to a ' +
            'comma-separated list (e.g. "github,google") to enable the offline fallback.',
    );
}

// Fallback: read from OAUTH_PROVIDERS env var (comma-separated, e.g. "github,google")
// when the API is unreachable, so login buttons still render.
function getFallbackProviders(): OAuthProvider[] {
    const raw = process.env.OAUTH_PROVIDERS;
    if (!raw) return [];
    return filterSocialProviders(raw.split(',').map((s) => s.trim().toLowerCase()));
}

export async function getConfiguredAuthProviders(): Promise<OAuthProvider[]> {
    const data = await fetchAuthProviders();
    if (!data) return getFallbackProviders();
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
        return { socialProviders: getFallbackProviders(), magicLinkEnabled: false };
    }
    return {
        socialProviders: filterSocialProviders(data.socialProviders),
        magicLinkEnabled: data.magicLink === true,
    };
}
