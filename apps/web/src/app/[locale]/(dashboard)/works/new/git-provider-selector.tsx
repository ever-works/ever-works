'use client';

import { useTransition } from 'react';
import { cn } from '@/lib/utils/cn';
import { connectOAuthProvider } from '@/app/actions/dashboard/oauth';
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
                bg: 'bg-github dark:bg-primary',
                hover: 'hover:bg-github/90 dark:hover:bg-primary/90',
                text: 'text-white',
            };
        case 'gitlab':
            return {
                bg: 'bg-gitlab',
                hover: 'hover:bg-gitlab/90',
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
            const result = await connectOAuthProvider(providerId, ROUTES.DASHBOARD_WORKS_NEW);

            if (result.success && result.url) {
                window.location.href = result.url;
            } else {
                toast.error(result.error || t('connectError'));
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
                <Boxes
                    className="w-8 h-8 mx-auto text-text-muted dark:text-accent-indigo mb-2"
                    strokeWidth={1.4}
                />
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
                {providers.map(({ provider, connectionInfo }) => {
                    const isSelected = selectedProviderId === provider.id;
                    const isConnected = connectionInfo?.connected ?? false;
                    const ProviderIcon = getProviderIcon(provider.id);
                    const colors = getProviderColors(provider.id);

                    return (
                        <div key={provider.id} className="space-y-1.5">
                            <button
                                onClick={() => onSelect(provider.id)}
                                className={cn(
                                    'w-full flex items-center gap-2.5 px-3 py-2 rounded-xl transition-all text-left',
                                    isSelected
                                        ? 'bg-white/5 dark:bg-white/5 ring-1 ring-primary/30'
                                        : 'hover:bg-white/5 dark:hover:bg-white/5 ring-1 ring-transparent hover:ring-white/10',
                                )}
                            >
                                <div
                                    className={cn(
                                        'w-7 h-7 rounded-lg flex items-center justify-center shrink-0',
                                        'bg-white/8 dark:bg-white/8',
                                    )}
                                >
                                    <ProviderIcon
                                        className="w-3.5 h-3.5 text-text dark:text-text-dark"
                                        strokeWidth={1.8}
                                    />
                                </div>
                                <div className="flex flex-col min-w-0 flex-1">
                                    <span className="text-xs font-medium text-text dark:text-text-dark leading-none">
                                        {provider.name}
                                    </span>
                                    <span
                                        className={cn(
                                            'text-[11px] mt-0.5 truncate leading-none',
                                            isConnected
                                                ? 'text-emerald-500 dark:text-emerald-400'
                                                : 'text-text-muted dark:text-text-muted-dark',
                                        )}
                                    >
                                        {isConnected
                                            ? `@${connectionInfo?.username}`
                                            : t('notConnected')}
                                    </span>
                                </div>
                                {isSelected && (
                                    <Check
                                        className="w-3 h-3 text-primary shrink-0"
                                        strokeWidth={2.5}
                                    />
                                )}
                            </button>

                            {isSelected && !isConnected && (
                                <button
                                    onClick={() => handleConnect(provider.id)}
                                    disabled={isPending}
                                    className={cn(
                                        'w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all',
                                        colors.bg,
                                        colors.hover,
                                        colors.text,
                                        'disabled:opacity-50 disabled:cursor-not-allowed',
                                    )}
                                >
                                    {isPending ? (
                                        <>
                                            <div className="w-3 h-3 border-[1.5px] border-current border-t-transparent rounded-full animate-spin" />
                                            {t('connecting')}
                                        </>
                                    ) : (
                                        <>
                                            <LinkIcon className="w-3 h-3" />
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
        <div className="flex flex-wrap gap-2">
            {providers.map(({ provider, connectionInfo }) => {
                const isSelected = selectedProviderId === provider.id;
                const isConnected = connectionInfo?.connected ?? false;
                const ProviderIcon = getProviderIcon(provider.id);
                const colors = getProviderColors(provider.id);

                return (
                    <div key={provider.id} className="flex flex-col gap-2">
                        <button
                            onClick={() => onSelect(provider.id)}
                            className={cn(
                                'flex items-center gap-2.5 px-3.5 py-2 rounded-xl transition-all',
                                isSelected
                                    ? 'ring-1 ring-primary/40 bg-primary/5 dark:bg-primary/10'
                                    : 'ring-1 ring-border dark:ring-border-dark bg-card dark:bg-card-primary-dark/30 hover:ring-primary/30 hover:bg-primary/5 dark:hover:bg-primary/5',
                            )}
                        >
                            <div className="w-7 h-7 rounded-lg bg-white/8 dark:bg-white/5 flex items-center justify-center shrink-0">
                                <ProviderIcon
                                    className="w-4 h-4 text-text dark:text-text-dark"
                                    strokeWidth={1.8}
                                />
                            </div>
                            <div className="flex flex-col">
                                <span className="text-sm font-medium text-text dark:text-text-dark leading-none">
                                    {provider.name}
                                </span>
                                {isConnected && connectionInfo?.avatarUrl ? (
                                    <div className="flex items-center gap-1 mt-0.5">
                                        <div className="relative w-3.5 h-3.5 rounded-full overflow-hidden">
                                            <Image
                                                src={connectionInfo.avatarUrl}
                                                alt={connectionInfo.username || ''}
                                                fill
                                                className="object-cover"
                                                sizes="14px"
                                            />
                                        </div>
                                        <span className="text-[11px] text-emerald-500 dark:text-emerald-400 leading-none">
                                            @{connectionInfo.username}
                                        </span>
                                    </div>
                                ) : isConnected ? (
                                    <span className="text-[11px] text-emerald-500 dark:text-emerald-400 mt-0.5 leading-none">
                                        {t('connected')}
                                    </span>
                                ) : (
                                    <span className="text-[11px] text-text-muted dark:text-text-muted-dark mt-0.5 leading-none">
                                        {t('notConnected')}
                                    </span>
                                )}
                            </div>
                            {isSelected && (
                                <Check
                                    className="w-3.5 h-3.5 text-primary ml-1 shrink-0"
                                    strokeWidth={2.5}
                                />
                            )}
                        </button>

                        {isSelected && !isConnected && (
                            <button
                                onClick={() => handleConnect(provider.id)}
                                disabled={isPending}
                                className={cn(
                                    'flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all w-full',
                                    colors.bg,
                                    colors.hover,
                                    colors.text,
                                    'disabled:opacity-50 disabled:cursor-not-allowed',
                                )}
                            >
                                {isPending ? (
                                    <>
                                        <div className="w-3 h-3 border-[1.5px] border-current border-t-transparent rounded-full animate-spin" />
                                        {t('connecting')}
                                    </>
                                ) : (
                                    <>
                                        <LinkIcon className="w-3 h-3" />
                                        {t('connect')}
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
