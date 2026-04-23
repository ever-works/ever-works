'use client';

import { useTranslations } from 'next-intl';
import { ExternalLink, KeyRound, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import type { PluginDeviceAuthStatus } from '@/lib/api/plugins-capabilities/device-auth';
import { usePluginDeviceAuth } from '@/lib/hooks/use-plugin-device-auth';

interface PluginDeviceAuthConnectionProps {
    pluginId: string;
    pluginName: string;
    initialStatus: PluginDeviceAuthStatus | null;
    onActivate?: () => void;
}

export function PluginDeviceAuthConnection({
    pluginId,
    pluginName,
    initialStatus,
    onActivate,
}: PluginDeviceAuthConnectionProps) {
    const t = useTranslations('dashboard.plugins.deviceAuth');
    const { status, error, isLoading, isStarting, refresh, start } = usePluginDeviceAuth({
        pluginId,
        initialStatus,
        loadErrorMessage: t('loadError'),
        startErrorMessage: t('startError'),
        onActivate,
    });

    const isConnected = status?.connected ?? false;
    const isPending = status?.pending ?? false;
    const prompt = status?.prompt;

    return (
        <div
            className={cn(
                'rounded-lg p-4',
                'bg-surface dark:bg-surface-dark',
                'border border-border dark:border-border-dark',
            )}
        >
            <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                    <div
                        className={cn(
                            'w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0',
                            isConnected
                                ? 'bg-success/10 text-success'
                                : isPending
                                  ? 'bg-primary/10 text-primary'
                                  : 'bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted dark:text-text-muted-dark',
                        )}
                    >
                        {isConnected ? (
                            <ShieldCheck className="w-5 h-5" />
                        ) : isPending ? (
                            <Loader2 className="w-5 h-5 animate-spin" />
                        ) : (
                            <KeyRound className="w-5 h-5" />
                        )}
                    </div>

                    <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-text dark:text-text-dark">
                                {t('title')}
                            </span>
                            {isConnected ? (
                                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
                                    <span className="w-1.5 h-1.5 rounded-full bg-success" />
                                    {t('connected')}
                                </span>
                            ) : isPending ? (
                                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary">
                                    <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                                    {t('pending')}
                                </span>
                            ) : (
                                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-text-muted dark:text-text-muted-dark">
                                    <span className="w-1.5 h-1.5 rounded-full bg-text-muted dark:bg-text-muted-dark" />
                                    {t('notConnected')}
                                </span>
                            )}
                        </div>

                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                            {status?.message || t('description', { plugin: pluginName })}
                        </p>

                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('backendHint')}
                        </p>

                        {prompt && (
                            <div className="rounded-lg bg-surface-secondary/70 dark:bg-surface-secondary-dark/60 px-4 py-3 space-y-2">
                                <div>
                                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-text-muted dark:text-text-muted-dark">
                                        {t('deviceCode')}
                                    </p>
                                    <p className="mt-1 font-mono text-lg font-semibold text-text dark:text-text-dark">
                                        {prompt.userCode}
                                    </p>
                                </div>

                                <div>
                                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-text-muted dark:text-text-muted-dark">
                                        {t('verificationUrl')}
                                    </p>
                                    <p className="mt-1 text-sm break-all text-text dark:text-text-dark">
                                        {prompt.verificationUri}
                                    </p>
                                </div>
                            </div>
                        )}

                        {error && <p className="text-sm text-danger">{error}</p>}
                    </div>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                    {prompt?.verificationUri && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                                window.open(prompt.verificationUri, '_blank', 'noopener,noreferrer')
                            }
                        >
                            <ExternalLink className="w-4 h-4 mr-1.5" />
                            {t('open')}
                        </Button>
                    )}

                    {!status?.installed ? (
                        <span className="text-sm text-danger">{t('notInstalled')}</span>
                    ) : (
                        <Button
                            onClick={() => void start()}
                            disabled={isLoading || isStarting}
                            size="sm"
                        >
                            {isPending ? t('restart') : t('start')}
                        </Button>
                    )}

                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void refresh()}
                        disabled={isLoading}
                    >
                        <RefreshCw className={cn('w-4 h-4 mr-1.5', isLoading && 'animate-spin')} />
                        {t('refresh')}
                    </Button>
                </div>
            </div>
        </div>
    );
}
