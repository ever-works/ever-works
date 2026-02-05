import { getAuthFromCookie } from '@/lib/auth';
import { gitProvidersAPI, deployAPI, GitProviderConnectionInfo, GitProviderInfo } from '@/lib/api';
import NewDirectoryClient from './new-directory-client';
import type { DeployProvider } from './deploy-provider-selector';

export interface ProviderWithConnection {
    provider: GitProviderInfo;
    connectionInfo: GitProviderConnectionInfo | null;
}

export default async function NewDirectoryPage() {
    const user = await getAuthFromCookie();

    // Get all available git providers and their connection status
    let providers: ProviderWithConnection[] = [];
    let defaultProviderId: string | null = null;

    // Get all available deploy providers
    let deployProviders: DeployProvider[] = [];
    let defaultDeployProviderId: string | null = 'vercel'; // Default to vercel

    try {
        const providersResult = await gitProvidersAPI.list();

        // Use first enabled provider as default
        const enabledProviders = providersResult.providers.filter((p) => p.enabled);
        defaultProviderId = enabledProviders[0]?.id || null;

        // Get connection info for each provider
        providers = await Promise.all(
            providersResult.providers.map(async (provider: GitProviderInfo) => {
                const connectionInfo = await gitProvidersAPI
                    .checkConnection(provider.id)
                    .catch(() => null);
                return { provider, connectionInfo };
            }),
        );
    } catch (error) {
        console.error('Failed to fetch git providers:', error);
    }

    // Fetch deploy providers
    try {
        const deployProvidersResult = await deployAPI.getProviders();
        if (deployProvidersResult.providers) {
            deployProviders = deployProvidersResult.providers;
            // Use first enabled provider as default, or vercel if available
            const vercelProvider = deployProviders.find((p) => p.id === 'vercel');
            const firstEnabled = deployProviders.find((p) => p.enabled);
            defaultDeployProviderId = vercelProvider?.id || firstEnabled?.id || null;
        }
    } catch (error) {
        console.error('Failed to fetch deploy providers:', error);
        // Provide a fallback with vercel as default
        deployProviders = [{ id: 'vercel', name: 'Vercel', enabled: true }];
    }

    return (
        <NewDirectoryClient
            user={user!}
            providers={providers}
            defaultProviderId={defaultProviderId}
            deployProviders={deployProviders}
            defaultDeployProviderId={defaultDeployProviderId}
        />
    );
}
