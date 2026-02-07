'use client';

import { useState, useTransition, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { Check, Settings, ChevronDown, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { Directory } from '@/lib/api';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import type { PluginIcon as PluginIconType } from '@ever-works/plugin';
import { getDeployProviders, updateDeployProvider } from './actions';

interface DeployProvider {
    id: string;
    name: string;
    enabled: boolean;
    icon?: PluginIconType;
    description?: string;
    homepage?: string;
}

interface DeployProviderSettingsProps {
    directory: Directory;
}

export function DeployProviderSettings({ directory }: DeployProviderSettingsProps) {
    const t = useTranslations('dashboard.directoryDetail.settings');
    const [isPending, startTransition] = useTransition();
    const [isOpen, setIsOpen] = useState(false);
    const [providers, setProviders] = useState<DeployProvider[]>([]);
    const [selectedProvider, setSelectedProvider] = useState(directory.deployProvider || '');
    const router = useRouter();

    // Fetch available providers via server action
    useEffect(() => {
        getDeployProviders().then((result) => {
            setProviders(result);
            // Default to the directory's provider or the first enabled provider
            if (!selectedProvider && result.length > 0) {
                const first = result.find((p) => p.enabled) || result[0];
                setSelectedProvider(first.id);
            }
        });
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const currentProvider = providers.find((p) => p.id === selectedProvider) || {
        id: selectedProvider,
        name: selectedProvider || 'None',
        enabled: true,
    };

    const handleSave = () => {
        startTransition(async () => {
            const result = await updateDeployProvider(directory.id, selectedProvider);
            if (result.success) {
                toast.success(t('deployProvider.updateSuccess'));
                router.refresh();
            } else {
                toast.error(result.error || t('deployProvider.updateFailed'));
            }
        });
    };

    const hasChanges = selectedProvider !== (directory.deployProvider || '');

    return (
        <div
            className={cn(
                'rounded-lg border p-6',
                'bg-card dark:bg-card-dark',
                'border-card-border dark:border-card-border-dark',
            )}
        >
            <div className="flex items-center justify-between mb-4">
                <div>
                    <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                        {t('deployProvider.title')}
                    </h3>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark mt-1">
                        {t('deployProvider.description')}
                    </p>
                </div>
                <Link
                    href={`/plugins/${currentProvider.id}`}
                    className={cn(
                        'flex items-center gap-1 text-sm text-primary hover:text-primary/80 transition-colors',
                    )}
                >
                    <Settings className="w-4 h-4" />
                    {t('deployProvider.configure')}
                </Link>
            </div>

            <div className="space-y-4">
                {/* Current Provider Display */}
                <div className="relative">
                    <button
                        type="button"
                        onClick={() => setIsOpen(!isOpen)}
                        className={cn(
                            'w-full flex items-center justify-between gap-3 p-3 rounded-lg transition-all',
                            'border-2 border-border dark:border-border-dark',
                            'bg-surface dark:bg-surface-dark',
                            'hover:border-primary/50',
                        )}
                    >
                        <div className="flex items-center gap-3">
                            <PluginIcon
                                icon={currentProvider.icon}
                                name={currentProvider.name}
                                size={40}
                            />
                            <div className="text-left">
                                <p className="font-medium text-text dark:text-text-dark">
                                    {currentProvider.name}
                                </p>
                                <p
                                    className={cn(
                                        'text-xs',
                                        currentProvider.enabled
                                            ? 'text-success'
                                            : 'text-text-muted dark:text-text-muted-dark',
                                    )}
                                >
                                    {currentProvider.enabled
                                        ? t('deployProvider.ready')
                                        : t('deployProvider.notConfigured')}
                                </p>
                            </div>
                        </div>
                        <ChevronDown
                            className={cn(
                                'w-5 h-5 text-text-muted transition-transform',
                                isOpen && 'rotate-180',
                            )}
                        />
                    </button>

                    {/* Dropdown */}
                    {isOpen && providers.length > 0 && (
                        <div
                            className={cn(
                                'absolute z-10 w-full mt-2 rounded-lg overflow-hidden',
                                'border border-border dark:border-border-dark',
                                'bg-card dark:bg-card-dark',
                                'shadow-lg',
                            )}
                        >
                            {providers.map((provider) => {
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
                                            size={32}
                                        />
                                        <div className="flex-1 text-left">
                                            <p className="font-medium text-text dark:text-text-dark">
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
                                                {provider.enabled
                                                    ? t('deployProvider.ready')
                                                    : t('deployProvider.notConfigured')}
                                            </p>
                                        </div>
                                        {isSelected && <Check className="w-4 h-4 text-primary" />}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Save Button */}
                {hasChanges && (
                    <Button
                        type="button"
                        onClick={handleSave}
                        disabled={isPending}
                        loading={isPending}
                        variant="primary"
                    >
                        {t('saveChanges')}
                    </Button>
                )}

                {/* Current deployment info */}
                {directory.website && (
                    <div
                        className={cn(
                            'flex items-center gap-2 p-3 rounded-lg',
                            'bg-success/10 border border-success/20',
                        )}
                    >
                        <Check className="w-4 h-4 text-success" />
                        <span className="text-sm text-success font-medium">
                            {t('deployProvider.deployed')}
                        </span>
                        <Link
                            href={directory.website}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ml-auto flex items-center gap-1 text-sm text-success hover:underline"
                        >
                            {t('deployProvider.viewSite')}
                            <ExternalLink className="w-3 h-3" />
                        </Link>
                    </div>
                )}
            </div>
        </div>
    );
}
