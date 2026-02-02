import { getAuthFromCookie } from '@/lib/auth';
import { gitProvidersAPI, GitProviderConnectionInfo, GitProviderInfo } from '@/lib/api';
import NewDirectoryClient from './new-directory-client';

export interface ProviderWithConnection {
    provider: GitProviderInfo;
    connectionInfo: GitProviderConnectionInfo | null;
}

export default async function NewDirectoryPage() {
    const user = await getAuthFromCookie();

    // Get all available git providers and their connection status
    let providers: ProviderWithConnection[] = [];
    let defaultProviderId: string | null = null;

    try {
        const [providersResult, defaultResult] = await Promise.all([
            gitProvidersAPI.list(),
            gitProvidersAPI.getDefault(),
        ]);

        defaultProviderId = defaultResult.provider?.id || null;

        // Get connection info for each provider
        providers = await Promise.all(
            providersResult.providers.map(async (provider) => {
                const connectionInfo = await gitProvidersAPI
                    .checkConnection(provider.id)
                    .catch(() => null);
                return { provider, connectionInfo };
            }),
        );
    } catch (error) {
        console.error('Failed to fetch git providers:', error);
    }

    return (
        <NewDirectoryClient
            user={user!}
            providers={providers}
            defaultProviderId={defaultProviderId}
        />
    );
}
