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

                <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-6">
                    {/* AI Creation Card */}
                    <button
                        onClick={() => setCreationMode('ai')}
                        className={cn(
                            'rounded-lg p-4 text-left transition-all shadow-sm',
                            'bg-white dark:bg-card-primary-dark',
                            'border border-card-border dark:border-white/9',
                            'hover:border-primary-500/50 dark:hover:border-white/20',
                            'group relative cursor-pointer',
                        )}
                    >
                        <div className="mb-4">
                            <div
                                className={cn(
                                    'w-12 h-12 rounded-lg flex items-center justify-center',
                                    'bg-gray-100 dark:bg-white/5',
                                )}
                            >
                                <Bot
                                    className="w-6 h-6 text-gray-800 dark:text-gray-300"
                                    strokeWidth={1.5}
                                />
                            </div>
                        </div>
                        <h3 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                            {t('ai.title')}
                        </h3>
                        <p className="text-text-secondary/50 text-sm dark:text-text-secondary-dark mb-6">
                            {t('ai.subtitle')}
                        </p>
                        <div className="flex items-center gap-2 bg-button-primary dark:bg-button-primary-dark hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark text-white dark:text-black rounded-full px-3 py-1 text-sm font-medium w-fit">
                            <span>{t('ai.getStarted')}</span>
                            <ArrowRight
                                className="w-4 h-4 group-hover:translate-x-1 transition-transform"
                                strokeWidth={2}
                            />
                        </div>
                    </button>

                    {/* Manual Creation Card */}
                    <button
                        onClick={() => setCreationMode('manual')}
                        className={cn(
                            'rounded-lg p-4 text-left transition-all shadow-sm',
                            'bg-white dark:bg-card-primary-dark',
                            'border border-card-border dark:border-white/9',
                            'hover:border-primary-500/50 dark:hover:border-white/20',
                            'group relative cursor-pointer',
                        )}
                    >
                        <div className="mb-4">
                            <div
                                className={cn(
                                    'w-12 h-12 rounded-lg flex items-center justify-center',
                                    'bg-gray-100 dark:bg-white/5',
                                )}
                            >
                                <PenLine
                                    className="w-6 h-6 text-gray-800 dark:text-gray-500"
                                    strokeWidth={1.5}
                                />
                            </div>
                        </div>
                        <h3 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                            {t('manual.title')}
                        </h3>
                        <p className="text-text-secondary/50 text-sm dark:text-text-secondary-dark mb-4">
                            {t('manual.subtitle')}
                        </p>
                        <div className="flex items-center gap-2 bg-button-primary dark:bg-button-primary-dark hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark text-white dark:text-black rounded-full px-3 py-1 text-sm font-medium w-fit">
                            <span>{t('manual.configureNow')}</span>
                            <ArrowRight
                                className="w-4 h-4 group-hover:translate-x-1 transition-transform"
                                strokeWidth={2}
                            />
                        </div>
                    </button>

                    {/* Import Existing Card */}
                    <button
                        onClick={() => setCreationMode('import')}
                        className={cn(
                            'rounded-lg p-4 text-left transition-all shadow-sm',
                            'bg-white dark:bg-card-primary-dark',
                            'border border-card-border dark:border-white/9',
                            'hover:border-primary-500/50 dark:hover:border-white/20',
                            'group relative cursor-pointer',
                        )}
                    >
                        <div className="mb-4">
                            <div
                                className={cn(
                                    'w-12 h-12 rounded-lg flex items-center justify-center',
                                    'bg-gray-100 dark:bg-white/5',
                                )}
                            >
                                <FolderInput
                                    className="w-6 h-6 text-gray-800 dark:text-gray-500"
                                    strokeWidth={1.5}
                                />
                            </div>
                        </div>
                        <h3 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                            {t('import.title')}
                        </h3>
                        <p className="text-text-secondary/50 text-sm dark:text-text-secondary-dark mb-4">
                            {t('import.subtitle')}
                        </p>
                        <div className="flex items-center gap-2 bg-button-primary dark:bg-button-primary-dark hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark text-white dark:text-black rounded-full px-3 py-1 text-sm font-medium w-fit">
                            <span>{t('import.importNow')}</span>
                            <ArrowRight
                                className="w-4 h-4 group-hover:translate-x-1 transition-transform"
                                strokeWidth={2}
                            />
                        </div>
                    </button>
                </div>
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
        </div>
    );
}
