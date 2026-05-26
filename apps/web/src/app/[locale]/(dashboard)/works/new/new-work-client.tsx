'use client';

import { useMemo, useState } from 'react';
import { AuthUser } from '@/lib/auth';
import { cn } from '@/lib/utils/cn';
import { WorkAICreator } from '@/components/works/WorkAICreator';
import { WorkManualForm } from '@/components/works/WorkManualForm';
import { WorkImportForm } from '@/components/works/WorkImportForm';
import { CreationBlockTrio, type CreationMode } from '@/components/works/CreationBlockTrio';
import { GitProviderSelector } from './git-provider-selector';
import { DeployProviderSelector, type DeployProvider } from './deploy-provider-selector';
import { useTranslations } from 'next-intl';
import type { ProviderWithConnection } from './page';
import type { WebsiteTemplateOption } from '@/lib/api/work';
import type { WorkProposal } from '@/lib/api/work-proposals';

type InitialWorkKind = 'website' | 'landing-page' | 'blog' | 'directory' | 'awesome-repo';

interface NewWorkClientProps {
    user: AuthUser;
    providers: ProviderWithConnection[];
    defaultProviderId: string | null;
    deployProviders: DeployProvider[];
    defaultDeployProviderId: string | null;
    websiteTemplates: WebsiteTemplateOption[];
    proposal?: WorkProposal | null;
    initialMode?: CreationMode | null;
    initialPrompt?: string;
    initialKind?: InitialWorkKind | null;
}

export default function NewWorkClient({
    user,
    providers,
    defaultProviderId,
    deployProviders,
    defaultDeployProviderId,
    websiteTemplates,
    proposal,
    initialMode = null,
    initialPrompt,
    initialKind = null,
}: NewWorkClientProps) {
    const [creationMode, setCreationMode] = useState<CreationMode | null>(
        proposal ? 'ai' : initialMode,
    );
    const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
        defaultProviderId || providers[0]?.provider.id || null,
    );
    const [selectedDeployProviderId, setSelectedDeployProviderId] = useState<string | null>(
        defaultDeployProviderId ||
            deployProviders.find((provider) => provider.enabled && provider.configured)?.id ||
            deployProviders.find((provider) => provider.enabled)?.id ||
            deployProviders[0]?.id ||
            null,
    );
    const t = useTranslations('dashboard.workCreation');

    const gitConnected = useMemo(() => {
        if (!selectedProviderId) return false;
        const selected = providers.find((p) => p.provider.id === selectedProviderId);
        return selected?.connectionInfo?.connected ?? false;
    }, [selectedProviderId, providers]);

    if (creationMode === null) {
        return (
            <div className="w-full">
                <div className="mb-8">
                    <h1 className="text-3xl font-bold text-text dark:text-text-dark">
                        {t('title')}
                    </h1>
                    <p className="text-text-secondary dark:text-text-secondary-dark mt-2">
                        {t('subtitle')}
                    </p>
                </div>

                {/* Phase 6.5 PR CC1 — extracted to a shared component
                    so Phase 6.5 PR CC2's unified `/new` page can
                    render the same trio with the alternate label set.
                    Byte-identical render to the inline implementation
                    per Decision A11. */}
                <CreationBlockTrio onSelect={setCreationMode} />
            </div>
        );
    }

    return (
        <div className="flex flex-wrap justify-between gap-6 w-full">
            {/* Provider Selector Sidebar — full-width at top on small, sticky right column on @lg/main+ */}
            <aside className="order-first @lg/main:order-last w-full @lg/main:w-[280px] shrink-0 @lg/main:sticky @lg/main:top-8 self-start">
                <div
                    className={cn(
                        'p-1 rounded-lg space-y-6 shadow-xs',
                        'bg-card/10 dark:bg-card-primary-dark/30',
                        'border border-card-border dark:border-border-secondary-dark',
                    )}
                >
                    <div
                        className={cn(
                            'p-4 rounded-sm relative overflow-hidden',
                            'bg-card dark:bg-card-secondary-dark/30',
                            'border border-card-border dark:border-border-secondary-dark',
                        )}
                    >
                        <div className="absolute -top-5 -right-6 w-30 h-30 rounded-full dark:bg-accent-indigo/10 bg-accent-indigo/10 blur-xl pointer-events-none" />
                        <div className="relative z-20 mb-4">
                            <h3 className="font-bold text-sm text-text dark:text-text-dark mb-2">
                                {t('sidebar.selectedProvider')}
                            </h3>
                            <GitProviderSelector
                                providers={providers}
                                selectedProviderId={selectedProviderId}
                                onSelect={setSelectedProviderId}
                                compact
                            />
                        </div>
                        {deployProviders.length > 0 && (
                            <div className="relative z-20 mb-4">
                                <h3 className="font-bold text-sm text-text dark:text-text-dark mb-2">
                                    {t('sidebar.selectedDeployProvider')}
                                </h3>
                                <DeployProviderSelector
                                    providers={deployProviders}
                                    selectedProviderId={selectedDeployProviderId}
                                    onSelect={setSelectedDeployProviderId}
                                    compact
                                />
                            </div>
                        )}
                    </div>
                </div>
            </aside>
            {/* Main Content */}
            <div className="flex-1 min-w-96">
                <div className="mb-8">
                    <button
                        onClick={() => setCreationMode(null)}
                        className="flex cursor-pointer items-center gap-2 text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark transition-colors mb-4"
                    >
                        <svg
                            className="w-5 h-5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M10 19l-7-7m0 0l7-7m-7 7h18"
                            />
                        </svg>
                        {t('backToOptions')}
                    </button>
                </div>

                {creationMode === 'ai' && (
                    <WorkAICreator
                        gitProvider={selectedProviderId || undefined}
                        gitConnected={gitConnected}
                        deployProvider={selectedDeployProviderId || undefined}
                        websiteTemplates={websiteTemplates}
                        proposal={proposal ?? undefined}
                        initialPrompt={initialPrompt}
                        initialKind={initialKind ?? undefined}
                    />
                )}
                {creationMode === 'manual' && (
                    <WorkManualForm
                        user={user}
                        gitProvider={selectedProviderId || undefined}
                        gitConnected={gitConnected}
                        deployProvider={selectedDeployProviderId || undefined}
                        websiteTemplates={websiteTemplates}
                        proposal={proposal ?? undefined}
                        initialDescription={initialPrompt}
                    />
                )}
                {creationMode === 'import' && (
                    <WorkImportForm
                        user={user}
                        gitProvider={selectedProviderId || undefined}
                        deployProvider={selectedDeployProviderId || undefined}
                    />
                )}
            </div>
        </div>
    );
}
