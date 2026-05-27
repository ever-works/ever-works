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
import { redirect } from 'next/navigation';
import NewWorkClient, { type CreationMode } from './new-work-client';
import type { DeployProvider } from './deploy-provider-selector';
import { workProposalsAPI } from '@/lib/api/work-proposals';
import type { WorkProposal } from '@/lib/api/work-proposals';
import { ROUTES } from '@/lib/constants';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('newWork') };
}

export interface ProviderWithConnection {
    provider: GitProviderInfo;
    connectionInfo: GitProviderConnectionInfo | null;
}

interface NewWorkPageProps {
    searchParams: Promise<{ proposal?: string; mode?: string; prompt?: string; kind?: string }>;
}

const VALID_CREATION_MODES: CreationMode[] = ['ai', 'manual', 'import'];
const VALID_WORK_KINDS = ['website', 'landing-page', 'blog', 'directory', 'awesome-repo'] as const;
type InitialWorkKind = (typeof VALID_WORK_KINDS)[number];

export default async function NewWorkPage({ searchParams }: NewWorkPageProps) {
    const params = await searchParams;
    const proposalId = params.proposal;
    const initialPrompt = (params.prompt ?? '').trim().slice(0, 4000);
    const initialMode = (VALID_CREATION_MODES as string[]).includes(params.mode ?? '')
        ? (params.mode as CreationMode)
        : initialPrompt.length > 0
          ? 'ai'
          : null;
    const initialKind = (VALID_WORK_KINDS as readonly string[]).includes(params.kind ?? '')
        ? (params.kind as InitialWorkKind)
        : null;

    if (!proposalId && !initialMode) {
        redirect(ROUTES.DASHBOARD_NEW);
    }
    const user = await getAuthFromCookie();

    // Defense: rendering with `user!` (non-null assertion) crashes the page
    // when the cookie is missing or stale. Redirect to login first so the
    // server response is a clean 307 instead of a 500.
    if (!user) {
        redirect('/login');
    }

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
        proposal = await workProposalsAPI.get(proposalId);
        // If the proposal is already accepted, send the user to the existing Work
        // instead of starting a duplicate create flow.
        if (proposal?.status === 'accepted' && proposal.acceptedWorkId) {
            redirect(`/works/${proposal.acceptedWorkId}`);
        }
        // Already-dismissed proposals fall through: form opens blank, no prefill.
        if (proposal?.status !== 'pending') {
            proposal = null;
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
            initialMode={initialMode}
            initialPrompt={initialPrompt}
            initialKind={initialKind}
        />
    );
}
