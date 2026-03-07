'use client';

import { useMemo, useState } from 'react';
import { AuthUser } from '@/lib/auth';
import { cn } from '@/lib/utils/cn';
import { DirectoryAICreator } from '@/components/directories/DirectoryAICreator';
import { DirectoryManualForm } from '@/components/directories/DirectoryManualForm';
import { DirectoryImportForm } from '@/components/directories/DirectoryImportForm';
import { GitProviderSelector } from './git-provider-selector';
import { DeployProviderSelector, type DeployProvider } from './deploy-provider-selector';
import { useTranslations } from 'next-intl';
import type { ProviderWithConnection } from './page';
import { Bot, PenLine, FolderInput, ArrowRight } from 'lucide-react';

interface NewDirectoryClientProps {
    user: AuthUser;
    providers: ProviderWithConnection[];
    defaultProviderId: string | null;
    deployProviders: DeployProvider[];
    defaultDeployProviderId: string | null;
}

export default function NewDirectoryClient({
    user,
    providers,
    defaultProviderId,
    deployProviders,
    defaultDeployProviderId,
}: NewDirectoryClientProps) {
    const [creationMode, setCreationMode] = useState<'ai' | 'manual' | 'import' | null>(null);
    const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
        defaultProviderId || providers[0]?.provider.id || null,
    );
    const [selectedDeployProviderId, setSelectedDeployProviderId] = useState<string | null>(
        defaultDeployProviderId || deployProviders[0]?.id || null,
    );
    const t = useTranslations('dashboard.directoryCreation');

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

                <div className="grid md:grid-cols-3 gap-6">
                    {/* AI Creation Card */}
                    <button
                        onClick={() => setCreationMode('ai')}
                        className={cn(
                            'rounded-b-lg rounded-t-lg rounded-tr-lg text-left transition-all',
                            'bg-surface-tertiary dark:bg-card-navy-dark',
                            'border-card-border dark:border-card-border-dark',
                            'hover:border-primary hover:shadow-lg shadow-sm',
                            'group relative cursor-pointer',
                        )}
                    >
                        <div className="absolute left-0 -top-2 flex w-full">
                            <div className="h-6 w-2/4 bg-surface-tertiary dark:bg-card-navy-dark rounded-t-2xl" />
                            <div className="w-0 h-0 -ml-2 mt-0.5 border-b-20 border-r-20 border-b-surface-tertiary dark:border-b-card-navy-dark border-r-transparent" />
                        </div>
                        <div className="flex absolute right-0 top-1 w-[55%] h-6">
                            <div className="w-0 h-0 border-b-20 mt-1 -mr-1.5 border-l-20 border-b-card dark:border-b-card-primary-dark border-l-transparent"></div>
                            <div className="w-[94%] h-full bg-card dark:bg-card-primary-dark rounded-tl-2xl rounded-tr-lg" />
                        </div>
                        <div className="relative overflow-hidden rounded-lg bg-card dark:bg-card-primary-dark p-6 mt-4  h-[94%]">
                            <div className="opacity-0 group-hover:opacity-100 absolute -bottom-5 right-6 w-40 h-30 rounded-full dark:bg-accent-indigo/10 bg-accent-indigo/15  blur-2xl pointer-events-none" />
                            <div className="card-top-accent-indigo opacity-0 group-hover:opacity-100 pointer-events-none absolute right-8 bottom-0 w-1/2 h-px z-20 rounded-full" />
                            <div className="mb-4">
                                <div
                                    className={cn(
                                        'w-12 h-12 rounded-lg flex items-center justify-center',
                                        'bg-primary/10 border border-primary/20 group-hover:bg-primary/20 transition-colors',
                                    )}
                                >
                                    <Bot className="w-6 h-6 text-primary" strokeWidth={1.5} />
                                </div>
                            </div>
                            <h3 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                                {t('ai.title')}
                            </h3>
                            <p className="text-text-secondary text-sm dark:text-text-secondary-dark mb-4">
                                {t('ai.subtitle')}
                            </p>
                            <div className="flex items-center gap-2 text-primary font-medium">
                                <span>{t('ai.getStarted')}</span>
                                <ArrowRight
                                    className="w-4 h-4 group-hover:translate-x-1 transition-transform"
                                    strokeWidth={2}
                                />
                            </div>
                        </div>
                    </button>

                    {/* Manual Creation Card */}
                    <button
                        onClick={() => setCreationMode('manual')}
                        className={cn(
                            'rounded-b-lg rounded-t-lg rounded-tr-lg text-left transition-all',
                            'bg-surface-tertiary dark:bg-card-navy-dark',
                            'border-card-border dark:border-card-border-dark',
                            'hover:border-primary hover:shadow-lg shadow-sm',
                            'group relative cursor-pointer',
                        )}
                    >
                        <div className="absolute left-0 -top-2 flex w-full">
                            <div className="h-6 w-2/4 bg-surface-tertiary dark:bg-card-navy-dark rounded-t-2xl" />
                            <div className="w-0 h-0 -ml-2 mt-0.5 border-b-20 border-r-20 border-b-surface-tertiary dark:border-b-card-navy-dark border-r-transparent" />
                        </div>
                        <div className="flex absolute right-0 top-1 w-[55%] h-6">
                            <div className="w-0 h-0 border-b-20 mt-1 -mr-1.5 border-l-20 border-b-card dark:border-b-card-primary-dark border-l-transparent"></div>
                            <div className="w-[94%] h-full bg-card dark:bg-card-primary-dark rounded-tl-2xl rounded-tr-lg" />
                        </div>
                        <div className="relative overflow-hidden rounded-lg bg-card dark:bg-card-primary-dark p-6 mt-4  h-[94%]">
                            <div className="opacity-0 group-hover:opacity-100 absolute -bottom-5 right-6 w-40 h-30 rounded-full dark:bg-accent-indigo/10 bg-accent-indigo/15  blur-2xl pointer-events-none" />
                            <div className="card-top-accent-indigo opacity-0 group-hover:opacity-100 pointer-events-none absolute right-8 bottom-0 w-1/2 h-px z-20 rounded-full" />
                            <div className="mb-4">
                                <div
                                    className={cn(
                                        'w-12 h-12 rounded-lg flex items-center justify-center',
                                        'bg-success/10 border border-success/20 group-hover:bg-success/20 transition-colors',
                                    )}
                                >
                                    <PenLine className="w-6 h-6 text-success" strokeWidth={1.5} />
                                </div>
                            </div>
                            <h3 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                                {t('manual.title')}
                            </h3>
                            <p className="text-text-secondary text-sm dark:text-text-secondary-dark mb-4">
                                {t('manual.subtitle')}
                            </p>
                            <div className="flex items-center gap-2 text-success font-medium">
                                <span>{t('manual.configureNow')}</span>
                                <ArrowRight
                                    className="w-4 h-4 group-hover:translate-x-1 transition-transform"
                                    strokeWidth={2}
                                />
                            </div>
                        </div>
                    </button>

                    {/* Import Existing Card */}
                    <button
                        onClick={() => setCreationMode('import')}
                        className={cn(
                            'rounded-b-lg rounded-t-lg rounded-tr-lg text-left transition-all',
                            'bg-surface-tertiary dark:bg-card-navy-dark',
                            'border-card-border dark:border-card-border-dark',
                            'hover:border-primary hover:shadow-lg shadow-sm',
                            'group relative cursor-pointer',
                        )}
                    >
                        <div className="absolute left-0 -top-2 flex w-full">
                            <div className="h-6 w-2/4 bg-surface-tertiary dark:bg-card-navy-dark rounded-t-2xl" />
                            <div className="w-0 h-0 -ml-2 mt-0.5 border-b-20 border-r-20 border-b-surface-tertiary dark:border-b-card-navy-dark border-r-transparent" />
                        </div>
                        <div className="flex absolute right-0 top-1 w-[55%] h-6">
                            <div className="w-0 h-0 border-b-20 mt-1 -mr-1.5 border-l-20 border-b-card dark:border-b-card-primary-dark border-l-transparent"></div>
                            <div className="w-[94%] h-full bg-card dark:bg-card-primary-dark rounded-tl-2xl rounded-tr-lg" />
                        </div>
                        <div className="relative overflow-hidden rounded-lg bg-card dark:bg-card-primary-dark p-6 mt-4 h-[94%]">
                            <div className="opacity-0 group-hover:opacity-100 absolute -bottom-5 right-6 w-40 h-30 rounded-full dark:bg-accent-indigo/10 bg-accent-indigo/15  blur-2xl pointer-events-none" />
                            <div className="card-top-accent-indigo opacity-0 group-hover:opacity-100 pointer-events-none absolute right-8 bottom-0 w-1/2 h-px z-20 rounded-full" />
                            <div className="mb-4">
                                <div
                                    className={cn(
                                        'w-12 h-12 rounded-lg flex items-center justify-center',
                                        'bg-warning/10 border border-warning/20 group-hover:bg-warning/20 transition-colors',
                                    )}
                                >
                                    <FolderInput
                                        className="w-6 h-6 text-warning"
                                        strokeWidth={1.5}
                                    />
                                </div>
                            </div>
                            <h3 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                                {t('import.title')}
                            </h3>
                            <p className="text-text-secondary text-sm dark:text-text-secondary-dark mb-4">
                                {t('import.subtitle')}
                            </p>
                            <div className="flex items-center gap-2 text-warning font-medium">
                                <span>{t('import.importNow')}</span>
                                <ArrowRight
                                    className="w-4 h-4 group-hover:translate-x-1 transition-transform"
                                    strokeWidth={2}
                                />
                            </div>
                        </div>
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="flex gap-6 w-full">
            {/* Main Content */}
            <div className="flex-1">
                <div className="mb-8">
                    <button
                        onClick={() => setCreationMode(null)}
                        className="flex items-center gap-2 text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark transition-colors mb-4"
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
                    <DirectoryAICreator
                        gitProvider={selectedProviderId || undefined}
                        gitConnected={gitConnected}
                        deployProvider={selectedDeployProviderId || undefined}
                    />
                )}
                {creationMode === 'manual' && (
                    <DirectoryManualForm
                        user={user}
                        gitProvider={selectedProviderId || undefined}
                        gitConnected={gitConnected}
                        deployProvider={selectedDeployProviderId || undefined}
                    />
                )}
                {creationMode === 'import' && (
                    <DirectoryImportForm
                        user={user}
                        gitProvider={selectedProviderId || undefined}
                        deployProvider={selectedDeployProviderId || undefined}
                    />
                )}
            </div>

            {/* Git Provider Selector Sidebar */}
            <aside className="w-80 shrink-0">
                <div
                    className={cn(
                        'sticky top-8 p-1 rounded-lg space-y-6',
                        'bg-card/10 dark:bg-card-primary-dark/30',
                        'border border-card-border dark:border-border-secondary-dark',
                    )}
                >
                    <div
                        className={cn(
                            'p-6 rounded-sm relative overflow-hidden',
                            'bg-card dark:bg-card-secondary-dark/30',
                            'border border-card-border dark:border-border-secondary-dark',
                        )}
                    >
                        <div className="absolute -top-5 -right-6 w-30 h-30 rounded-full dark:bg-accent-indigo/10 bg-accent-indigo/15  blur-xl pointer-events-none" />
                        <div className="relative z-20">
                            <h3 className="font-medium text-text dark:text-text-dark mb-4">
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
                            <div className="relative z-20">
                                <h3 className="font-medium text-text dark:text-text-dark mb-4">
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
        </div>
    );
}
