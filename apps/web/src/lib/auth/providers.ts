import 'server-only';

import { API_URL } from '@/lib/constants';

export type AuthProvider = 'github' | 'google' | 'linkedin' | 'facebook' | 'twitter';

type AuthProvidersResponse = {
    emailPassword: boolean;
    socialProviders: string[];
};

export async function getConfiguredAuthProviders(): Promise<AuthProvider[]> {
    try {
        const response = await fetch(`${API_URL}/auth/providers`, {
            cache: 'no-store',
            next: { revalidate: 0 },
        });

        if (!response.ok) {
            return ['github'];
        }

        const data = (await response.json()) as AuthProvidersResponse;
        return data.socialProviders.filter(
            (provider): provider is AuthProvider =>
                provider === 'github' ||
                provider === 'google' ||
                provider === 'linkedin' ||
                provider === 'facebook' ||
                provider === 'twitter',
        );
    } catch {
        return ['github'];
    }
}
