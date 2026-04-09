'use client';

import { useState, useTransition } from 'react';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { Check, ChevronDown, Plug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import { updateDeployProvider } from '@/components/directories/detail/settings/actions';
import { toast } from 'sonner';
import type { DeployProvider } from '@/lib/api/plugins-capabilities/deploy';

interface DeployProviderSelectorProps {
    directoryId: string;
    providers: DeployProvider[];
    currentProviderId: string;
}

export function DeployProviderSelector({
    directoryId,
    providers,
    currentProviderId,
}: DeployProviderSelectorProps) {
    const t = useTranslations('dashboard.directoryDetail.deploy');
    const [selectedProvider, setSelectedProvider] = useState(currentProviderId);
    const [isOpen, setIsOpen] = useState(!currentProviderId);
    const [isPending, startTransition] = useTransition();
    const router = useRouter();

    const enabledProviders = providers.filter((p) => p.enabled);

    // Hide entirely: single provider that's already selected
    if (enabledProviders.length === 1 && enabledProviders[0].id === currentProviderId) {
        return null;
    }

    // No providers at all
    if (enabledProviders.length === 0) {
        return (
            <div
                className={cn(
                    'rounded-lg p-6',
                    'bg-surface dark:bg-surface-dark',
                    'border border-warning/20 dark:border-warning-dark/20',
                )}
            >
                <div className="flex items-center gap-2 text-text-muted dark:text-text-muted-dark">
                    <Plug className="w-4 h-4" />
                    <span className="text-sm">{t('noProviderAlert.noProviders')}</span>
                </div>
            </div>
        );
    }

    const hasChanges = selectedProvider !== currentProviderId;

    const handleSave = () => {
        if (!selectedProvider || !hasChanges) return;

        startTransition(async () => {
            const result = await updateDeployProvider(directoryId, selectedProvider);
            if (result.success) {
                router.refresh();
            } else {
                toast.error(result.error);
            }
        });
    };

    const current = enabledProviders.find((p) => p.id === selectedProvider);

    // No provider selected yet — show full list
    if (!currentProviderId) {
        return (
            <div
                className={cn(
                    'rounded-lg p-6',
                    'bg-surface dark:bg-surface-dark',
                    'border border-border dark:border-border-dark',
                )}
            >
                <h3 className="text-base font-semibold text-text dark:text-text-dark mb-1">
                    {t('noProviderAlert.title')}
                </h3>
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark mb-4">
                    {t('noProviderAlert.description')}
                </p>
                <div className="space-y-2 mb-4">
                    {enabledProviders.map((provider) => {
                        const isSelected = selectedProvider === provider.id;
                        return (
                            <button
                                key={provider.id}
                                type="button"
                                onClick={() => setSelectedProvider(provider.id)}
                                className={cn(
                                    'w-full flex items-center gap-3 p-3 rounded-lg transition-all',
                                    'border-2',
                                    isSelected
                                        ? 'border-primary dark:border-primary-dark bg-primary/5'
                                        : 'border-border dark:border-border-dark hover:border-primary/50',
                                )}
                            >
                                <PluginIcon icon={provider.icon} name={provider.name} size={40} />
                                <div className="flex-1 text-left">
                                    <p className="font-medium text-text dark:text-text-dark">
                                        {provider.name}
                                    </p>
                                    {provider.description && (
                                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                            {provider.description}
                                        </p>
                                    )}
                                </div>
                                {isSelected && (
                                    <Check className="w-5 h-5 text-primary dark:text-primary-dark" />
                                )}
                            </button>
                        );
                    })}
                </div>
                <Button
                    type="button"
                    onClick={handleSave}
                    disabled={!selectedProvider || isPending}
                    loading={isPending}
                    variant="primary"
                >
                    {t('noProviderAlert.selectButton')}
                </Button>
            </div>
        );
    }

    // Provider is selected but there are multiple — compact dropdown to switch
    return (
        <div
            className={cn(
                'rounded-lg p-4',
                'bg-surface dark:bg-surface-dark',
                'border border-border dark:border-border-dark',
            )}
        >
            <div className="relative">
                <button
                    type="button"
                    onClick={() => setIsOpen(!isOpen)}
                    className={cn(
                        'w-full flex items-center justify-between gap-3 p-3 rounded-lg transition-all',
                        'border border-border dark:border-border-dark',
                        'bg-surface-secondary dark:bg-surface-secondary-dark',
                        'hover:border-primary/50',
                    )}
                >
                    <div className="flex items-center gap-3">
                        {current && (
                            <PluginIcon icon={current.icon} name={current.name} size={32} />
                        )}
                        <div className="text-left">
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                {current?.name || selectedProvider}
                            </p>
                        </div>
                    </div>
                    <ChevronDown
                        className={cn(
                            'w-4 h-4 text-text-muted transition-transform',
                            isOpen && 'rotate-180',
                        )}
                    />
                </button>

                {isOpen && (
                    <div
                        className={cn(
                            'absolute z-10 w-full mt-1 rounded-lg overflow-hidden',
                            'border border-border dark:border-border-dark',
                            'bg-card dark:bg-card-primary-dark/30',
                            'shadow-lg',
                        )}
                    >
                        {enabledProviders.map((provider) => {
                            const isSelected = selectedProvider === provider.id;
                            return (
                                <button
                                    key={provider.id}
                                    type="button"
                                    onClick={() => {
                                        setSelectedProvider(provider.id);
                                        setIsOpen(false);
                                    }}
                                    className={cn(
                                        'w-full flex items-center gap-3 p-3 transition-colors',
                                        'hover:bg-surface dark:hover:bg-surface-dark',
                                        isSelected && 'bg-primary/5',
                                    )}
                                >
                                    <PluginIcon
                                        icon={provider.icon}
                                        name={provider.name}
                                        size={28}
                                    />
                                    <span className="flex-1 text-left text-sm font-medium text-text dark:text-text-dark">
                                        {provider.name}
                                    </span>
                                    {isSelected && <Check className="w-4 h-4 text-primary" />}
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>

            {hasChanges && (
                <div className="mt-3">
                    <Button
                        type="button"
                        onClick={handleSave}
                        disabled={isPending}
                        loading={isPending}
                        variant="primary"
                        size="sm"
                    >
                        {t('noProviderAlert.selectButton')}
                    </Button>
                </div>
            )}
        </div>
    );
}
