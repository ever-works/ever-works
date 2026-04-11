import 'server-only';

import { API_URL } from '@/lib/constants';
import { OAuthProvider } from '@/lib/api/enums';

type AuthProvidersResponse = {
    emailPassword: boolean;
    socialProviders: string[];
};

export async function getConfiguredAuthProviders(): Promise<OAuthProvider[]> {
    try {
        const response = await fetch(`${API_URL}/auth/providers`, {
            cache: 'no-store',
            next: { revalidate: 0 },
        });

        if (!response.ok) {
            return [];
        }

        const data = (await response.json()) as AuthProvidersResponse;
        return data.socialProviders.filter(
            (provider): provider is OAuthProvider =>
                provider === OAuthProvider.GITHUB ||
                provider === OAuthProvider.GOOGLE ||
                provider === OAuthProvider.FACEBOOK ||
                provider === OAuthProvider.LINKEDIN,
        );
    } catch {
        return [];
    }
}
