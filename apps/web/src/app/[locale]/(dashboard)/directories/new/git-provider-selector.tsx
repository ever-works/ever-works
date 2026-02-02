'use client';

import { useTransition } from 'react';
import { cn } from '@/lib/utils/cn';
import { connectGitProvider } from '@/app/actions/dashboard/oauth';
import { toast } from 'sonner';
import { ROUTES } from '@/lib/constants';
import { useTranslations } from 'next-intl';
import Image from 'next/image';
import { Github, GitlabIcon, Boxes, Check, Link as LinkIcon } from 'lucide-react';
import type { ProviderWithConnection } from './page';

interface GitProviderSelectorProps {
    providers: ProviderWithConnection[];
    selectedProviderId: string | null;
    onSelect: (providerId: string) => void;
    compact?: boolean;
}

function getProviderIcon(providerId: string) {
    switch (providerId.toLowerCase()) {
        case 'github':
            return Github;
        case 'gitlab':
            return GitlabIcon;
        default:
            return Boxes;
    }
}

function getProviderColors(providerId: string) {
    switch (providerId.toLowerCase()) {
        case 'github':
            return {
                bg: 'bg-[#24292e]',
                hover: 'hover:bg-[#24292e]/90',
                text: 'text-white',
            };
        case 'gitlab':
            return {
                bg: 'bg-[#fc6d26]',
                hover: 'hover:bg-[#fc6d26]/90',
                text: 'text-white',
            };
        default:
            return {
                bg: 'bg-primary',
                hover: 'hover:bg-primary/90',
                text: 'text-white',
            };
    }
}

export function GitProviderSelector({
    providers,
    selectedProviderId,
    onSelect,
    compact = false,
}: GitProviderSelectorProps) {
    const [isPending, startTransition] = useTransition();
    const t = useTranslations('dashboard.gitProvider.selector');

    const handleConnect = (providerId: string) => {
        startTransition(async () => {
            const result = await connectGitProvider(providerId, ROUTES.DASHBOARD_DIRECTORIES_NEW);

            if (result.success && result.url) {
                window.location.href = result.url;
            } else {
                toast.error(result.error || 'Failed to connect');
            }
        });
    };

    if (providers.length === 0) {
        return (
            <div
                className={cn(
                    'p-4 rounded-lg text-center',
                    'bg-surface dark:bg-surface-dark',
                    'border border-border dark:border-border-dark',
                )}
            >
                <Boxes className="w-8 h-8 mx-auto text-text-muted dark:text-text-muted-dark mb-2" />
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
                {providers.map(({ provider, connectionInfo }) => {
                    const isSelected = selectedProviderId === provider.id;
                    const isConnected = connectionInfo?.connected ?? false;
                    const ProviderIcon = getProviderIcon(provider.id);
                    const colors = getProviderColors(provider.id);

                    return (
                        <div key={provider.id} className="space-y-2">
                            <button
                                onClick={() => onSelect(provider.id)}
                                className={cn(
                                    'w-full flex items-center gap-3 p-3 rounded-lg transition-all',
                                    'border-2',
                                    isSelected
                                        ? 'border-primary bg-primary/5'
                                        : 'border-border dark:border-border-dark bg-surface dark:bg-surface-dark hover:border-primary/50',
                                )}
                            >
                                <ProviderIcon className="w-5 h-5 text-text dark:text-text-dark" />
                                <div className="flex-1 text-left">
                                    <p className="text-sm font-medium text-text dark:text-text-dark">
                                        {provider.name}
                                    </p>
                                    <p
                                        className={cn(
                                            'text-xs',
                                            isConnected
                                                ? 'text-success'
                                                : 'text-text-muted dark:text-text-muted-dark',
                                        )}
                                    >
                                        {isConnected
                                            ? `@${connectionInfo?.username}`
                                            : t('notConnected')}
                                    </p>
                                </div>
                                {isSelected && <Check className="w-4 h-4 text-primary" />}
                            </button>

                            {isSelected && !isConnected && (
                                <button
                                    onClick={() => handleConnect(provider.id)}
                                    disabled={isPending}
                                    className={cn(
                                        'w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                                        colors.bg,
                                        colors.hover,
                                        colors.text,
                                        'disabled:opacity-50 disabled:cursor-not-allowed',
                                    )}
                                >
                                    {isPending ? (
                                        <>
                                            <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                                            {t('connecting')}
                                        </>
                                    ) : (
                                        <>
                                            <LinkIcon className="w-4 h-4" />
                                            {t('connect')} {provider.name}
                                        </>
                                    )}
                                </button>
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
            <div className="flex flex-wrap gap-3">
                {providers.map(({ provider, connectionInfo }) => {
                    const isSelected = selectedProviderId === provider.id;
                    const isConnected = connectionInfo?.connected ?? false;
                    const ProviderIcon = getProviderIcon(provider.id);
                    const colors = getProviderColors(provider.id);

                    return (
                        <div key={provider.id} className="flex items-center gap-2">
                            <button
                                onClick={() => onSelect(provider.id)}
                                className={cn(
                                    'flex items-center gap-2 px-4 py-2 rounded-lg transition-all',
                                    'border-2',
                                    isSelected
                                        ? 'border-primary bg-primary/5 shadow-sm'
                                        : 'border-border dark:border-border-dark bg-card dark:bg-card-dark hover:border-primary/50',
                                )}
                            >
                                <ProviderIcon className="w-5 h-5 text-text dark:text-text-dark" />
                                <span className="font-medium text-text dark:text-text-dark">
                                    {provider.name}
                                </span>
                                {isConnected && connectionInfo?.avatarUrl && (
                                    <div className="flex items-center gap-1.5 ml-2 pl-2 border-l border-border dark:border-border-dark">
                                        <div className="relative w-5 h-5 rounded-full overflow-hidden">
                                            <Image
                                                src={connectionInfo.avatarUrl}
                                                alt={connectionInfo.username || ''}
                                                fill
                                                className="object-cover"
                                                sizes="20px"
                                            />
                                        </div>
                                        <span className="text-sm text-success">
                                            {t('connected')}
                                        </span>
                                    </div>
                                )}
                                {isConnected && !connectionInfo?.avatarUrl && (
                                    <span className="text-xs text-success ml-2">
                                        {t('connected')}
                                    </span>
                                )}
                                {!isConnected && (
                                    <span className="text-xs text-text-muted dark:text-text-muted-dark ml-2">
                                        {t('notConnected')}
                                    </span>
                                )}
                                {isSelected && <Check className="w-4 h-4 text-primary ml-1" />}
                            </button>

                            {isSelected && !isConnected && (
                                <button
                                    onClick={() => handleConnect(provider.id)}
                                    disabled={isPending}
                                    className={cn(
                                        'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                                        colors.bg,
                                        colors.hover,
                                        colors.text,
                                        'disabled:opacity-50 disabled:cursor-not-allowed',
                                    )}
                                >
                                    {isPending ? (
                                        <>
                                            <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                                            {t('connecting')}
                                        </>
                                    ) : (
                                        <>
                                            <LinkIcon className="w-4 h-4" />
                                            {t('connect')}
                                        </>
                                    )}
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
