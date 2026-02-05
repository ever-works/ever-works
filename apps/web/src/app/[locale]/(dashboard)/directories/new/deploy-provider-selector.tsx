'use client';

import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { Triangle, Cloud, Check, Settings } from 'lucide-react';
import Link from 'next/link';

export interface DeployProvider {
    id: string;
    name: string;
    enabled: boolean;
}

interface DeployProviderSelectorProps {
    providers: DeployProvider[];
    selectedProviderId: string | null;
    onSelect: (providerId: string) => void;
    compact?: boolean;
}

function getProviderIcon(providerId: string) {
    switch (providerId.toLowerCase()) {
        case 'vercel':
            return Triangle;
        default:
            return Cloud;
    }
}

function getProviderColors(providerId: string) {
    switch (providerId.toLowerCase()) {
        case 'vercel':
            return {
                bg: 'bg-black dark:bg-white',
                hover: 'hover:bg-black/90 dark:hover:bg-white/90',
                text: 'text-white dark:text-black',
                iconClass: 'fill-current',
            };
        default:
            return {
                bg: 'bg-primary',
                hover: 'hover:bg-primary/90',
                text: 'text-white',
                iconClass: '',
            };
    }
}

export function DeployProviderSelector({
    providers,
    selectedProviderId,
    onSelect,
    compact = false,
}: DeployProviderSelectorProps) {
    const t = useTranslations('dashboard.directoryCreation.deployProvider');

    if (providers.length === 0) {
        return (
            <div
                className={cn(
                    'p-4 rounded-lg text-center',
                    'bg-surface dark:bg-surface-dark',
                    'border border-border dark:border-border-dark',
                )}
            >
                <Cloud className="w-8 h-8 mx-auto text-text-muted dark:text-text-muted-dark mb-2" />
                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                    {t('noProviders')}
                </p>
            </div>
        );
    }

    if (compact) {
        // Compact view for sidebar
        return (
            <div className="space-y-2">
                {providers.map((provider) => {
                    const isSelected = selectedProviderId === provider.id;
                    const ProviderIcon = getProviderIcon(provider.id);
                    const colors = getProviderColors(provider.id);

                    return (
                        <div key={provider.id} className="space-y-2">
                            <button
                                onClick={() => onSelect(provider.id)}
                                disabled={!provider.enabled}
                                className={cn(
                                    'w-full flex items-center gap-3 p-3 rounded-lg transition-all',
                                    'border-2',
                                    isSelected
                                        ? 'border-primary bg-primary/5'
                                        : 'border-border dark:border-border-dark bg-surface dark:bg-surface-dark hover:border-primary/50',
                                    !provider.enabled && 'opacity-50 cursor-not-allowed',
                                )}
                            >
                                <ProviderIcon
                                    className={cn(
                                        'w-5 h-5 text-text dark:text-text-dark',
                                        colors.iconClass,
                                    )}
                                />
                                <div className="flex-1 text-left">
                                    <p className="text-sm font-medium text-text dark:text-text-dark">
                                        {provider.name}
                                    </p>
                                    <p
                                        className={cn(
                                            'text-xs',
                                            provider.enabled
                                                ? 'text-success'
                                                : 'text-text-muted dark:text-text-muted-dark',
                                        )}
                                    >
                                        {provider.enabled ? t('configured') : t('notConfigured')}
                                    </p>
                                </div>
                                {isSelected && <Check className="w-4 h-4 text-primary" />}
                            </button>

                            {isSelected && !provider.enabled && (
                                <Link
                                    href={`/plugins/${provider.id}`}
                                    className={cn(
                                        'w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                                        colors.bg,
                                        colors.hover,
                                        colors.text,
                                    )}
                                >
                                    <Settings className="w-4 h-4" />
                                    {t('configureLink')}
                                </Link>
                            )}
                        </div>
                    );
                })}
            </div>
        );
    }

    // Full view for main page
    return (
        <div
            className={cn(
                'p-4 rounded-lg',
                'bg-surface dark:bg-surface-dark',
                'border border-border dark:border-border-dark',
            )}
        >
            <h3 className="text-sm font-medium text-text dark:text-text-dark mb-3">{t('title')}</h3>
            <p className="text-xs text-text-muted dark:text-text-muted-dark mb-4">
                {t('description')}
            </p>
            <div className="flex flex-wrap gap-3">
                {providers.map((provider) => {
                    const isSelected = selectedProviderId === provider.id;
                    const ProviderIcon = getProviderIcon(provider.id);
                    const colors = getProviderColors(provider.id);

                    return (
                        <div key={provider.id} className="flex items-center gap-2">
                            <button
                                onClick={() => onSelect(provider.id)}
                                disabled={!provider.enabled}
                                className={cn(
                                    'flex items-center gap-2 px-4 py-2 rounded-lg transition-all',
                                    'border-2',
                                    isSelected
                                        ? 'border-primary bg-primary/5 shadow-sm'
                                        : 'border-border dark:border-border-dark bg-card dark:bg-card-dark hover:border-primary/50',
                                    !provider.enabled && 'opacity-50 cursor-not-allowed',
                                )}
                            >
                                <ProviderIcon
                                    className={cn(
                                        'w-5 h-5 text-text dark:text-text-dark',
                                        colors.iconClass,
                                    )}
                                />
                                <span className="font-medium text-text dark:text-text-dark">
                                    {provider.name}
                                </span>
                                {provider.enabled && (
                                    <span className="text-xs text-success ml-2">
                                        {t('configured')}
                                    </span>
                                )}
                                {!provider.enabled && (
                                    <span className="text-xs text-text-muted dark:text-text-muted-dark ml-2">
                                        {t('notConfigured')}
                                    </span>
                                )}
                                {isSelected && <Check className="w-4 h-4 text-primary ml-1" />}
                            </button>

                            {isSelected && !provider.enabled && (
                                <Link
                                    href={`/plugins/${provider.id}`}
                                    className={cn(
                                        'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                                        colors.bg,
                                        colors.hover,
                                        colors.text,
                                    )}
                                >
                                    <Settings className="w-4 h-4" />
                                    {t('configureLink')}
                                </Link>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// Export types for use in page
export type { DeployProvider as DeployProviderInfo };
