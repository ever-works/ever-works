'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { connectOAuthProvider, disconnectOAuthProvider } from '@/app/actions/dashboard/oauth';
import { toast } from 'sonner';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { OAuthConnectionInfo } from '@/lib/api/plugins-capabilities/oauth';
import { GitProviderConnectionInfo } from '@/lib/api/plugins-capabilities/git-providers';
import Image from 'next/image';
import { Check, Link as LinkIcon, Unlink, RefreshCw, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePathname } from '@/i18n/navigation';

interface PluginOAuthConnectionProps {
    pluginId: string;
    pluginName: string;
    connection: OAuthConnectionInfo | GitProviderConnectionInfo | null;
    returnPath?: string;
    allowDisconnect?: boolean;
}

export function PluginOAuthConnection({
    pluginId,
    pluginName,
    connection,
    returnPath,
    allowDisconnect = true,
}: PluginOAuthConnectionProps) {
    const [isPending, startTransition] = useTransition();
    const t = useTranslations('dashboard.plugins.oauth');
    const pathname = usePathname();

    const isConnected = connection?.connected ?? false;
    const isSocialConnection =
        !!connection &&
        'connectionSource' in connection &&
        connection.connectionSource === 'social';
    const canDisconnect = allowDisconnect && !isSocialConnection;
    const username = connection?.username;
    const avatarUrl = connection?.avatarUrl;
    const email = connection?.email;

    const getReturnPath = () => returnPath || pathname || ROUTES.DASHBOARD_SETTINGS;

    const handleConnect = () => {
        startTransition(() => {
            void (async () => {
                const result = await connectOAuthProvider(pluginId, getReturnPath());

                if (result.success && result.url) {
                    window.location.href = result.url;
                } else {
                    toast.error(result.error || t('connectError'));
                }
            })();
        });
    };

    const handleReconnect = () => {
        startTransition(() => {
            void (async () => {
                const result = await connectOAuthProvider(pluginId, getReturnPath(), true);

                if (result.success && result.url) {
                    window.location.href = result.url;
                } else {
                    toast.error(result.error || t('reconnectError'));
                }
            })();
        });
    };

    const handleDisconnect = () => {
        if (!confirm(t('confirmDisconnect', { plugin: pluginName }))) {
            return;
        }

        startTransition(() => {
            void (async () => {
                const result = await disconnectOAuthProvider(pluginId);

                if (result.success) {
                    toast.success(t('disconnected', { plugin: pluginName }));
                    window.location.reload();
                } else {
                    toast.error(result.error || t('disconnectError'));
                }
            })();
        });
    };

    return (
        <div
            className={cn(
                'rounded-lg p-4',
                'bg-surface dark:bg-surface-dark',
                'border border-border dark:border-border-dark',
            )}
        >
            <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                    {/* Connection Status Icon */}
                    <div
                        className={cn(
                            'w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0',
                            isConnected
                                ? 'bg-success/10 text-success'
                                : 'bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted dark:text-text-muted-dark',
                        )}
                    >
                        {isConnected ? (
                            avatarUrl ? (
                                <div className="relative w-10 h-10 rounded-full overflow-hidden">
                                    <Image
                                        src={avatarUrl}
                                        alt={username || pluginName}
                                        fill
                                        className="object-cover"
                                        sizes="40px"
                                    />
                                </div>
                            ) : (
                                <Check className="w-5 h-5" />
                            )
                        ) : (
                            <LinkIcon className="w-5 h-5" />
                        )}
                    </div>

                    {/* Connection Info */}
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                            <span className="font-medium text-text dark:text-text-dark">
                                {t('title')}
                            </span>
                            {isConnected ? (
                                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
                                    <span className="w-1.5 h-1.5 rounded-full bg-success" />
                                    {t('connected')}
                                </span>
                            ) : (
                                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-text-muted dark:text-text-muted-dark">
                                    <span className="w-1.5 h-1.5 rounded-full bg-text-muted dark:bg-text-muted-dark" />
                                    {t('notConnected')}
                                </span>
                            )}
                        </div>
                        {isConnected && username && (
                            <div className="flex items-center gap-2 text-xs text-text-secondary dark:text-text-secondary-dark">
                                <span className="truncate">@{username}</span>
                                {email && (
                                    <>
                                        <span className="text-text-muted dark:text-text-muted-dark">
                                            •
                                        </span>
                                        <span className="truncate">{email}</span>
                                    </>
                                )}
                            </div>
                        )}
                        {!isConnected && (
                            <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                {t('connectDescription', { plugin: pluginName })}
                            </p>
                        )}
                    </div>
                </div>

                {/* Action Buttons */}
                <div className="flex items-center gap-2 flex-shrink-0">
                    {isConnected ? (
                        <>
                            <Button
                                onClick={handleReconnect}
                                disabled={isPending}
                                variant="ghost"
                                size="sm"
                                className="gap-1.5 text-sm"
                            >
                                <RefreshCw
                                    className={cn(
                                        'w-4 h-4 stroke-[1.5]',
                                        isPending && 'animate-spin',
                                    )}
                                />
                                {isPending ? t('reconnecting') : t('reconnect')}
                            </Button>
                            {canDisconnect && (
                                <Button
                                    onClick={handleDisconnect}
                                    disabled={isPending}
                                    variant="ghost"
                                    size="sm"
                                    className="gap-1.5 text-sm text-danger hover:text-danger hover:bg-danger/10"
                                >
                                    <Unlink className="w-4 h-4 stroke-[1.5]" />
                                    {t('disconnect')}
                                </Button>
                            )}
                        </>
                    ) : (
                        <Button
                            onClick={handleConnect}
                            disabled={isPending}
                            size="sm"
                            className="gap-1.5 text-sm"
                        >
                            <LinkIcon className="w-4 h-4 stroke-[1.5]" />
                            {isPending ? t('connecting') : t('connect')}
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}
