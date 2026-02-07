'use client';

import { useState, useTransition } from 'react';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { AlertTriangle, Check, Plug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import { updateDeployProvider } from '@/components/directories/detail/settings/actions';
import { toast } from 'sonner';
import type { DeployProvider } from '@/lib/api/plugins-capabilities/deploy';

interface NoDeployProviderAlertProps {
    directoryId: string;
    providers: DeployProvider[];
}

export function NoDeployProviderAlert({ directoryId, providers }: NoDeployProviderAlertProps) {
    const t = useTranslations('dashboard.directoryDetail.deploy');
    const [selectedProvider, setSelectedProvider] = useState<string>('');
    const [isPending, startTransition] = useTransition();
    const router = useRouter();

    const enabledProviders = providers.filter((p) => p.enabled);

    const handleConfirm = () => {
        if (!selectedProvider) return;

        startTransition(async () => {
            const result = await updateDeployProvider(directoryId, selectedProvider);
            if (result.success) {
                router.refresh();
            } else {
                toast.error(result.error);
            }
        });
    };

    return (
        <div className="max-w-full mx-auto">
            <div
                className={cn(
                    'rounded-lg p-6',
                    'bg-surface dark:bg-surface-dark',
                    'border border-warning/20 dark:border-warning-dark/20',
                )}
            >
                <div className="flex items-start gap-4">
                    <div
                        className={cn(
                            'shrink-0 w-10 h-10 rounded-full flex items-center justify-center',
                            'bg-warning/10 dark:bg-warning-dark/10',
                        )}
                    >
                        <AlertTriangle className="w-5 h-5 text-warning dark:text-warning-dark" />
                    </div>
                    <div className="flex-1">
                        <h3 className="text-lg font-semibold text-text dark:text-text-dark mb-2">
                            {t('noProviderAlert.title')}
                        </h3>
                        <p className="text-text-secondary dark:text-text-secondary-dark mb-4">
                            {t('noProviderAlert.description')}
                        </p>

                        {enabledProviders.length === 0 ? (
                            <div className="flex items-center gap-2 text-text-muted dark:text-text-muted-dark">
                                <Plug className="w-4 h-4" />
                                <span className="text-sm">{t('noProviderAlert.noProviders')}</span>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                <div className="space-y-2">
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
                                                <PluginIcon
                                                    icon={provider.icon}
                                                    name={provider.name}
                                                    size={40}
                                                />
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
                                    onClick={handleConfirm}
                                    disabled={!selectedProvider || isPending}
                                    loading={isPending}
                                    variant="primary"
                                >
                                    {t('noProviderAlert.selectButton')}
                                </Button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
