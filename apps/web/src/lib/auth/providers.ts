import 'server-only';

import { EVER_ID_DEFAULT_DISPLAY_NAME, type EverIdAvailability } from '@ever-works/contracts';
import { API_URL } from '@/lib/constants';
import { OAuthProvider } from '@/lib/api/enums';

type AuthProvidersResponse = {
    emailPassword: boolean;
    magicLink?: boolean;
    socialProviders: string[];
    /**
     * APW-12 (Ever ID) — the one additive field (spec FR-6). Absent on an API
     * that predates Ever ID, which reads as "not available".
     */
    everId?: { enabled?: unknown; displayName?: unknown };
};

export interface AuthProvidersConfig {
    socialProviders: OAuthProvider[];
    magicLinkEnabled: boolean;
    /**
     * APW-12 — whether an administrator has enabled and configured Ever ID. The
     * `ever-id` rollout flag is evaluated on top of this, and only when it is
     * `true` (`isEverIdOffered`, `lib/feature-flags/ever-id.ts`).
     */
    everId: EverIdAvailability;
}

/** Ever ID as the web sees it when the API does not say otherwise. */
export const EVER_ID_UNAVAILABLE: EverIdAvailability = {
    enabled: false,
    displayName: EVER_ID_DEFAULT_DISPLAY_NAME,
};

/** Only a strict `enabled: true` turns Ever ID on; anything else is off. */
function toEverIdAvailability(raw: AuthProvidersResponse['everId']): EverIdAvailability {
    if (!raw || typeof raw !== 'object') {
        return EVER_ID_UNAVAILABLE;
    }
    const displayName =
        typeof raw.displayName === 'string' && raw.displayName.trim().length > 0
            ? raw.displayName.trim()
            : EVER_ID_DEFAULT_DISPLAY_NAME;
    return { enabled: raw.enabled === true, displayName };
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
        return {
            socialProviders: getFallbackProviders(),
            magicLinkEnabled: false,
            everId: EVER_ID_UNAVAILABLE,
        };
    }
    return {
        socialProviders: filterSocialProviders(data.socialProviders),
        magicLinkEnabled: data.magicLink === true,
        everId: toEverIdAvailability(data.everId),
    };
}

/**
 * APW-12 — Ever ID's availability alone, for pages that render no other sign-in
 * method (Settings → Security). An unreachable API reads as "not available".
 */
export async function getEverIdAvailability(): Promise<EverIdAvailability> {
    const data = await fetchAuthProviders();
    return data ? toEverIdAvailability(data.everId) : EVER_ID_UNAVAILABLE;
}
