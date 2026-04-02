'use client';

import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { Cloud, Check, Settings } from 'lucide-react';
import Link from 'next/link';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import type { PluginIcon as PluginIconType } from '@ever-works/plugin';

export interface DeployProvider {
    id: string;
    name: string;
    enabled: boolean;
    icon?: PluginIconType;
    description?: string;
    homepage?: string;
}

interface DeployProviderSelectorProps {
    providers: DeployProvider[];
    selectedProviderId: string | null;
    onSelect: (providerId: string) => void;
    compact?: boolean;
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
            <div className="space-y-1.5">
                {providers.map((provider) => {
                    const isSelected = selectedProviderId === provider.id;

                    return (
                        <div key={provider.id} className="space-y-1.5">
                            <button
                                onClick={() => onSelect(provider.id)}
                                disabled={!provider.enabled}
                                className={cn(
                                    'w-full flex items-center gap-2.5 px-3 py-2 rounded-xl transition-all text-left',
                                    isSelected
                                        ? 'bg-white/5 dark:bg-white/5 ring-1 ring-primary/30'
                                        : 'hover:bg-white/5 dark:hover:bg-white/5 ring-1 ring-transparent hover:ring-white/10',
                                    !provider.enabled && 'opacity-50 cursor-not-allowed',
                                )}
                            >
                                <div className="w-7 h-7 rounded-lg bg-white/8 dark:bg-white/8 flex items-center justify-center shrink-0">
                                    <PluginIcon icon={provider.icon} name={provider.name} size={14} />
                                </div>
                                <div className="flex flex-col min-w-0 flex-1">
                                    <span className="text-xs font-medium text-text dark:text-text-dark leading-none">
                                        {provider.name}
                                    </span>
                                    <span className={cn(
                                        'text-[11px] mt-0.5 leading-none',
                                        provider.enabled
                                            ? 'text-emerald-500 dark:text-emerald-400'
                                            : 'text-text-muted dark:text-text-muted-dark',
                                    )}>
                                        {provider.enabled ? t('configured') : t('notConfigured')}
                                    </span>
                                </div>
                                {isSelected && <Check className="w-3 h-3 text-primary shrink-0" strokeWidth={2.5} />}
                            </button>

                            {isSelected && !provider.enabled && (
                                <Link
                                    href={`/plugins/${provider.id}`}
                                    className={cn(
                                        'w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all',
                                        'bg-primary hover:bg-primary/90 text-white',
                                    )}
                                >
                                    <Settings className="w-3 h-3" />
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
        <div className="flex flex-wrap gap-2">
            {providers.map((provider) => {
                const isSelected = selectedProviderId === provider.id;

                return (
                    <div key={provider.id} className="flex flex-col gap-2">
                        <button
                            onClick={() => onSelect(provider.id)}
                            disabled={!provider.enabled}
                            className={cn(
                                'flex items-center gap-2.5 px-3.5 py-2 rounded-xl transition-all',
                                isSelected
                                    ? 'ring-1 ring-primary/40 bg-primary/5 dark:bg-primary/10'
                                    : 'ring-1 ring-border dark:ring-border-dark bg-card dark:bg-card-dark hover:ring-primary/30 hover:bg-primary/5 dark:hover:bg-primary/5',
                                !provider.enabled && 'opacity-50 cursor-not-allowed',
                            )}
                        >
                            <div className="w-7 h-7 rounded-lg bg-white/8 dark:bg-white/5 flex items-center justify-center shrink-0">
                                <PluginIcon icon={provider.icon} name={provider.name} size={14} />
                            </div>
                            <div className="flex flex-col">
                                <span className="text-sm font-medium text-text dark:text-text-dark leading-none">
                                    {provider.name}
                                </span>
                                <span className={cn(
                                    'text-[11px] mt-0.5 leading-none',
                                    provider.enabled
                                        ? 'text-emerald-500 dark:text-emerald-400'
                                        : 'text-text-muted dark:text-text-muted-dark',
                                )}>
                                    {provider.enabled ? t('configured') : t('notConfigured')}
                                </span>
                            </div>
                            {isSelected && <Check className="w-3.5 h-3.5 text-primary ml-1 shrink-0" strokeWidth={2.5} />}
                        </button>

                        {isSelected && !provider.enabled && (
                            <Link
                                href={`/plugins/${provider.id}`}
                                className={cn(
                                    'flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all w-full',
                                    'bg-primary hover:bg-primary/90 text-white',
                                )}
                            >
                                <Settings className="w-3 h-3" />
                                {t('configureLink')}
                            </Link>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

// Export types for use in page
export type { DeployProvider as DeployProviderInfo };
