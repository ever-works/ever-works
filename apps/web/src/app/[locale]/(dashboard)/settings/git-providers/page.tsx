import { gitProvidersAPI } from '@/lib/api/git-providers';
import { authAPI } from '@/lib/api/auth';
import { GitProviderConnections } from '@/components/settings/GitProviderConnections';

export default async function OAuthSettingsPage() {
    const [profile, providersResult] = await Promise.all([
        authAPI.getFreshProfile(),
        gitProvidersAPI.list(),
    ]);

    // Get connection info for each provider
    const providersWithConnections = await Promise.all(
        providersResult.providers.map(async (provider) => {
            const connectionInfo = await gitProvidersAPI
                .checkConnection(provider.id)
                .catch(() => null);

            // Fetch organizations only if the provider is connected
            const organizations = connectionInfo?.connected
                ? await gitProvidersAPI
                      .getOrganizations(provider.id)
                      .then((r) => r.organizations)
                      .catch(() => [])
                : [];

            return {
                provider,
                connectionInfo,
                organizations,
            };
        }),
    );

    return <GitProviderConnections user={profile} providers={providersWithConnections} />;
}
