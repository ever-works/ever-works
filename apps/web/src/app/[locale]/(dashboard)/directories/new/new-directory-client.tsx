'use client';

import { useState } from 'react';
import { AuthUser } from '@/lib/auth';
import { cn } from '@/lib/utils/cn';
import { DirectoryAICreator } from '@/components/directories/DirectoryAICreator';
import { DirectoryManualForm } from '@/components/directories/DirectoryManualForm';
import { DirectoryImportForm } from '@/components/directories/DirectoryImportForm';
import { GitProviderSelector } from './git-provider-selector';
import { DeployProviderSelector, type DeployProvider } from './deploy-provider-selector';
import { useTranslations } from 'next-intl';
import type { ProviderWithConnection } from './page';

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

    const selectedProvider = providers.find((p) => p.provider.id === selectedProviderId) || null;
    const isConnected = selectedProvider?.connectionInfo?.connected ?? false;

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
                            'p-6 rounded-lg border-2 text-left transition-all',
                            'bg-card dark:bg-card-dark',
                            'border-card-border dark:border-card-border-dark',
                            'hover:border-primary hover:shadow-lg',
                            'group',
                        )}
                    >
                        <div className="mb-4">
                            <div
                                className={cn(
                                    'w-12 h-12 rounded-lg flex items-center justify-center',
                                    'bg-primary/10 group-hover:bg-primary/20 transition-colors',
                                )}
                            >
                                <svg
                                    className="w-6 h-6 text-primary"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                                    />
                                </svg>
                            </div>
                        </div>
                        <h3 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                            {t('ai.title')}
                        </h3>
                        <p className="text-text-secondary dark:text-text-secondary-dark mb-4">
                            {t('ai.subtitle')}
                        </p>
                        <div className="flex items-center gap-2 text-primary font-medium">
                            <span>{t('ai.getStarted')}</span>
                            <svg
                                className="w-4 h-4 group-hover:translate-x-1 transition-transform"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M9 5l7 7-7 7"
                                />
                            </svg>
                        </div>
                    </button>

                    {/* Manual Creation Card */}
                    <button
                        onClick={() => setCreationMode('manual')}
                        className={cn(
                            'p-6 rounded-lg border-2 text-left transition-all',
                            'bg-card dark:bg-card-dark',
                            'border-card-border dark:border-card-border-dark',
                            'hover:border-primary hover:shadow-lg',
                            'group',
                        )}
                    >
                        <div className="mb-4">
                            <div
                                className={cn(
                                    'w-12 h-12 rounded-lg flex items-center justify-center',
                                    'bg-success/10 group-hover:bg-success/20 transition-colors',
                                )}
                            >
                                <svg
                                    className="w-6 h-6 text-success"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                                    />
                                </svg>
                            </div>
                        </div>
                        <h3 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                            {t('manual.title')}
                        </h3>
                        <p className="text-text-secondary dark:text-text-secondary-dark mb-4">
                            {t('manual.subtitle')}
                        </p>
                        <div className="flex items-center gap-2 text-success font-medium">
                            <span>{t('manual.configureNow')}</span>
                            <svg
                                className="w-4 h-4 group-hover:translate-x-1 transition-transform"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M9 5l7 7-7 7"
                                />
                            </svg>
                        </div>
                    </button>

                    {/* Import Existing Card */}
                    <button
                        onClick={() => setCreationMode('import')}
                        className={cn(
                            'p-6 rounded-lg border-2 text-left transition-all',
                            'bg-card dark:bg-card-dark',
                            'border-card-border dark:border-card-border-dark',
                            'hover:border-primary hover:shadow-lg',
                            'group',
                        )}
                    >
                        <div className="mb-4">
                            <div
                                className={cn(
                                    'w-12 h-12 rounded-lg flex items-center justify-center',
                                    'bg-warning/10 group-hover:bg-warning/20 transition-colors',
                                )}
                            >
                                <svg
                                    className="w-6 h-6 text-warning"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                                    />
                                </svg>
                            </div>
                        </div>
                        <h3 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                            {t('import.title')}
                        </h3>
                        <p className="text-text-secondary dark:text-text-secondary-dark mb-4">
                            {t('import.subtitle')}
                        </p>
                        <div className="flex items-center gap-2 text-warning font-medium">
                            <span>{t('import.importNow')}</span>
                            <svg
                                className="w-4 h-4 group-hover:translate-x-1 transition-transform"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M9 5l7 7-7 7"
                                />
                            </svg>
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
                        deployProvider={selectedDeployProviderId || undefined}
                    />
                )}
                {creationMode === 'manual' && (
                    <DirectoryManualForm
                        user={user}
                        gitProvider={selectedProviderId || undefined}
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
                        'sticky top-8 p-6 rounded-lg space-y-6',
                        'bg-card dark:bg-card-dark',
                        'border border-card-border dark:border-card-border-dark',
                    )}
                >
                    <div>
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
                        <div>
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
            </aside>
        </div>
    );
}
