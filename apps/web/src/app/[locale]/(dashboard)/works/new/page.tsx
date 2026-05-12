import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getAuthFromCookie } from '@/lib/auth';
import {
    gitProvidersAPI,
    deployAPI,
    workAPI,
    GitProviderConnectionInfo,
    GitProviderInfo,
    type WebsiteTemplateOption,
} from '@/lib/api';
import NewWorkClient from './new-work-client';
import type { DeployProvider } from './deploy-provider-selector';
import { workProposalsAPI } from '@/lib/api/work-proposals';
import type { WorkProposal } from '@/lib/api/work-proposals';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('newWork') };
}

export interface ProviderWithConnection {
    provider: GitProviderInfo;
    connectionInfo: GitProviderConnectionInfo | null;
}

interface NewWorkPageProps {
    searchParams: Promise<{ proposal?: string }>;
}

export default async function NewWorkPage({ searchParams }: NewWorkPageProps) {
    const { proposal: proposalId } = await searchParams;
    const user = await getAuthFromCookie();

    // Get all available git providers and their connection status
    let providers: ProviderWithConnection[] = [];
    let defaultProviderId: string | null = null;

    // Get all available deploy providers
    let deployProviders: DeployProvider[] = [];
    let defaultDeployProviderId: string | null = null;
    let websiteTemplates: WebsiteTemplateOption[] = [];

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
            const firstConfigured = deployProviders.find((p) => p.enabled && p.configured);
            const firstEnabled = deployProviders.find((p) => p.enabled);
            defaultDeployProviderId = firstConfigured?.id || firstEnabled?.id || null;
        }
    } catch (error) {
        console.error('Failed to fetch deploy providers:', error);
        deployProviders = [];
    }

    try {
        const websiteTemplatesResult = await workAPI.getWebsiteTemplates();
        websiteTemplates = websiteTemplatesResult.templates;
    } catch (error) {
        console.error('Failed to fetch website templates:', error);
        websiteTemplates = [];
    }

    let proposal: WorkProposal | null = null;
    if (proposalId) {
        try {
            const list = await workProposalsAPI.list(['pending']);
            proposal = list.find((p) => p.id === proposalId) ?? null;
        } catch (error) {
            console.error('Failed to fetch proposal for prefill:', error);
        }
    }

    return (
        <NewWorkClient
            user={user!}
            providers={providers}
            defaultProviderId={defaultProviderId}
            deployProviders={deployProviders}
            defaultDeployProviderId={defaultDeployProviderId}
            websiteTemplates={websiteTemplates}
            proposal={proposal}
        />
    );
}
