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
import { Bot, PenLine, Import, ArrowRight } from 'lucide-react';
import Image from 'next/image';
import { CardDecoration } from '@/components/ui/CardDecoration';

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
                            'p-6 rounded-lg border text-left transition-all h-full',
                            'bg-card dark:bg-card-primary-dark',
                            'border-card-border dark:border-card-border-dark',
                            'hover:border-primary-500/70 hover:shadow-lg shadow-sm',
                            'group cursor-pointer relative',
                        )}
                    >
                        <CardDecoration
                            accentClassName="opacity-0 group-hover:opacity-100"
                            wrapperClassName="opacity-0 group-hover:opacity-100"
                        />
                        <div className="flex flex-col h-full">
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

                            <div className="flex items-center gap-2 text-primary mt-auto">
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
                            'p-6 rounded-lg border text-left transition-all h-full',
                            'bg-card dark:bg-card-primary-dark',
                            'border-card-border dark:border-card-border-dark',
                            'hover:border-primary-500/70 hover:shadow-lg shadow-sm',
                            'group cursor-pointer relative',
                        )}
                    >
                        <CardDecoration
                            accentClassName="opacity-0 group-hover:opacity-100"
                            wrapperClassName="opacity-0 group-hover:opacity-100"
                        />
                        <div className="flex flex-col h-full">
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

                            <div className="flex items-center gap-2 text-success mt-auto">
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
                            'p-6 rounded-lg border text-left transition-all h-full',
                            'bg-card dark:bg-card-primary-dark',
                            'border-card-border dark:border-card-border-dark',
                            'hover:border-primary-500/70 hover:shadow-lg shadow-sm',
                            'group cursor-pointer relative',
                        )}
                    >
                        <CardDecoration
                            accentClassName="opacity-0 group-hover:opacity-100"
                            wrapperClassName="opacity-0 group-hover:opacity-100"
                        />
                        <div className="flex flex-col h-full">
                            <div
                                className={cn(
                                    'w-12 h-12 mb-4 rounded-lg flex items-center justify-center',
                                    'bg-warning/10 border border-warning/20 group-hover:bg-warning/20 transition-colors',
                                )}
                            >
                                <Import className="w-6 h-6 text-warning" strokeWidth={1.5} />
                            </div>

                            <h3 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                                {t('import.title')}
                            </h3>
                            <p className="text-text-secondary text-sm dark:text-text-secondary-dark mb-4">
                                {t('import.subtitle')}
                            </p>

                            <div className="flex items-center gap-2 text-warning mt-auto">
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
                            'p-6 rounded-sm',
                            'bg-card dark:bg-card-secondary-dark/50',
                            'border border-card-border dark:border-border-secondary-dark',
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
                </div>
            </aside>
        </div>
    );
}
