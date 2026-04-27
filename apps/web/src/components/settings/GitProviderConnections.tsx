'use client';

import { useTransition } from 'react';
import { connectOAuthProvider, disconnectOAuthProvider } from '@/app/actions/dashboard/oauth';
import { toast } from 'sonner';
import { ROUTES } from '@/lib/constants';
import { useTranslations } from 'next-intl';
import { usePathname } from '@/i18n/navigation';
import {
    GitProviderInfo,
    GitProviderConnectionInfo,
    GitOrganization,
} from '@/lib/api/plugins-capabilities/git-providers';
import Link from 'next/link';
import Image from 'next/image';
import { cn } from '@/lib/utils/cn';
import {
    Github,
    GitlabIcon,
    Boxes,
    Check,
    Link as LinkIcon,
    Unlink,
    RefreshCw,
    Building2,
    ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ProviderWithConnection {
    provider: GitProviderInfo;
    connectionInfo: GitProviderConnectionInfo | null;
    organizations: GitOrganization[];
}

interface GitProviderConnectionsProps {
    user: {
        id: string;
        email: string;
        username?: string;
        avatar?: string;
    };
    providers: ProviderWithConnection[];
    /** OAuth return path after connect/reconnect. Defaults to current page via usePathname() */
    returnPath?: string;
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

function renderProviderIcon(providerId: string, className?: string) {
    switch (providerId.toLowerCase()) {
        case 'github':
            return <Github className={className} />;
        case 'gitlab':
            return <GitlabIcon className={className} />;
        default:
            return <Boxes className={className} />;
    }
}

function buildProviderUrl(homepage: string | undefined, path: string): string {
    if (!homepage) return '#';
    return `${homepage.replace(/\/$/, '')}/${path}`;
}

function getProviderBrandColors(providerId: string) {
    switch (providerId.toLowerCase()) {
        case 'github':
            return {
                bg: 'bg-github/10 dark:bg-github/30',
                border: 'border-github/20 dark:border-github/40',
                text: 'text-github dark:text-white',
                icon: 'text-github dark:text-white',
            };
        case 'gitlab':
            return {
                bg: 'bg-gitlab/10 dark:bg-gitlab/20',
                border: 'border-gitlab/20 dark:border-gitlab/30',
                text: 'text-gitlab',
                icon: 'text-gitlab',
            };
        case 'bitbucket':
            return {
                bg: 'bg-bitbucket/10 dark:bg-bitbucket/20',
                border: 'border-bitbucket/20 dark:border-bitbucket/30',
                text: 'text-bitbucket dark:text-bitbucket-light',
                icon: 'text-bitbucket dark:text-bitbucket-light',
            };
        default:
            return {
                bg: 'bg-primary/10',
                border: 'border-primary/20',
                text: 'text-primary',
                icon: 'text-primary',
            };
    }
}

export function GitProviderConnections({
    user,
    providers,
    returnPath,
}: GitProviderConnectionsProps) {
    const t = useTranslations('dashboard.gitProvider.settings');

    const connectedCount = providers.filter((p) => p.connectionInfo?.connected).length;

    return (
        <div className="space-y-6">
            {/* Header */}
            <div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                    {t('title')}
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark text-sm">{t('subtitle')}</p>
            </div>

            {/* Connection Summary */}
            {providers.length > 0 && (
                <div
                    className={cn(
                        'flex items-center gap-3 px-4 py-3 rounded-lg',
                        'bg-surface dark:bg-surface-dark',
                        'border border-border dark:border-border-dark',
                    )}
                >
                    <div
                        className={cn(
                            'w-8 h-8 rounded-full flex items-center justify-center',
                            connectedCount > 0
                                ? 'bg-success/10 text-success'
                                : 'bg-warning/10 text-warning',
                        )}
                    >
                        {connectedCount > 0 ? (
                            <Check className="w-4 h-4" />
                        ) : (
                            <LinkIcon className="w-4 h-4" />
                        )}
                    </div>
                    <div className="flex-1">
                        <p className="text-sm font-medium text-text dark:text-text-dark">
                            {connectedCount > 0
                                ? t('connectedCount', { count: connectedCount })
                                : t('noProvidersConnected')}
                        </p>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {connectedCount > 0 ? t('canImport') : t('connectToStart')}
                        </p>
                    </div>
                </div>
            )}

            {/* Provider Cards */}
            <div className="space-y-4">
                {providers.map(({ provider, connectionInfo, organizations }) => (
                    <GitProviderCard
                        key={provider.id}
                        provider={provider}
                        connectionInfo={connectionInfo}
                        organizations={organizations}
                        userAvatar={user.avatar}
                        returnPath={returnPath}
                    />
                ))}
            </div>

            {/* No Providers Message */}
            {providers.length === 0 && (
                <div
                    className={cn(
                        'text-center py-12 rounded-lg',
                        'bg-card dark:bg-card-primary-dark/30',
                        'border border-card-border dark:border-border-secondary-dark',
                    )}
                >
                    <Boxes className="w-12 h-12 mx-auto text-text-muted dark:text-text-muted-dark mb-4" />
                    <h3 className="text-lg font-medium text-text dark:text-text-dark mb-2">
                        {t('noProvidersTitle')}
                    </h3>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark max-w-md mx-auto">
                        {t('noProvidersSubtitle')}
                    </p>
                </div>
            )}
        </div>
    );
}

interface GitProviderCardProps {
    provider: GitProviderInfo;
    connectionInfo: GitProviderConnectionInfo | null;
    organizations: GitOrganization[];
    userAvatar?: string;
    returnPath?: string;
}

function GitProviderCard({
    provider,
    connectionInfo,
    organizations,
    userAvatar,
    returnPath,
}: GitProviderCardProps) {
    const [isPending, startTransition] = useTransition();
    const t = useTranslations('dashboard.gitProvider.settings');
    const tSelector = useTranslations('dashboard.gitProvider.selector');
    const pathname = usePathname();

    const isConnected = connectionInfo?.connected ?? false;
    const username = connectionInfo?.username;
    const avatarUrl = connectionInfo?.avatarUrl || userAvatar;

    const brandColors = getProviderBrandColors(provider.id);

    // Use provided returnPath or fall back to current page (locale-free via usePathname)
    const getReturnPath = () => returnPath || pathname || ROUTES.DASHBOARD_SETTINGS;

    const handleConnect = () => {
        startTransition(() => {
            void (async () => {
                const result = await connectOAuthProvider(provider.id, getReturnPath());

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
                const result = await connectOAuthProvider(provider.id, getReturnPath(), true);

                if (result.success && result.url) {
                    window.location.href = result.url;
                } else {
                    toast.error(result.error || t('reconnectError'));
                }
            })();
        });
    };

    const handleDisconnect = () => {
        if (!confirm(t('confirmDisconnect', { provider: provider.name }))) {
            return;
        }

        startTransition(() => {
            void (async () => {
                const result = await disconnectOAuthProvider(provider.id);

                if (result.success) {
                    toast.success(t('disconnected', { provider: provider.name }));
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
                'rounded-xl overflow-hidden',
                'bg-card dark:bg-card-primary-dark/30',
                'border border-card-border dark:border-border-secondary-dark',
                'transition-shadow hover:shadow-md',
            )}
        >
            {/* Card Header with Provider Brand */}
            <div className={cn('px-6 py-4', brandColors.bg, 'border-b', brandColors.border)}>
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div
                            className={cn(
                                'w-10 h-10 rounded-lg flex items-center justify-center',
                                'bg-white/80 dark:bg-white/10',
                                'shadow-sm',
                            )}
                        >
                            {renderProviderIcon(provider.id, cn('w-6 h-6', brandColors.icon))}
                        </div>
                        <div>
                            <h3 className="font-semibold text-text dark:text-text-dark">
                                {provider.name}
                            </h3>
                            <div className="flex items-center gap-2">
                                {isConnected ? (
                                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
                                        <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                                        {tSelector('connected')}
                                    </span>
                                ) : (
                                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-text-muted dark:text-text-muted-dark">
                                        <span className="w-1.5 h-1.5 rounded-full bg-text-muted dark:bg-text-muted-dark" />
                                        {tSelector('notConnected')}
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex items-center gap-2">
                        {isConnected ? (
                            <>
                                <Button
                                    onClick={handleReconnect}
                                    disabled={isPending}
                                    variant="ghost"
                                    size="sm"
                                    className="gap-2"
                                >
                                    <RefreshCw
                                        className={cn('w-4 h-4', isPending && 'animate-spin')}
                                    />
                                    {isPending ? t('reconnecting') : t('reconnect')}
                                </Button>
                                <Button
                                    onClick={handleDisconnect}
                                    disabled={isPending}
                                    variant="ghost"
                                    size="sm"
                                    className="gap-2 text-error hover:text-error hover:bg-error/10"
                                >
                                    <Unlink className="w-4 h-4" />
                                    {t('disconnect')}
                                </Button>
                            </>
                        ) : (
                            <Button
                                onClick={handleConnect}
                                disabled={isPending}
                                size="sm"
                                className="gap-2"
                            >
                                <LinkIcon className="w-4 h-4" />
                                {isPending
                                    ? t('connecting')
                                    : t('connect', { provider: provider.name })}
                            </Button>
                        )}
                    </div>
                </div>
            </div>

            {/* Card Body */}
            <div className="px-6 py-4">
                {isConnected && username ? (
                    <div className="space-y-4">
                        {/* Connected User Info */}
                        <div className="flex items-center gap-3">
                            {avatarUrl && (
                                <div className="relative w-10 h-10 rounded-full overflow-hidden border-2 border-border dark:border-border-dark">
                                    <Image
                                        src={avatarUrl}
                                        alt={username}
                                        fill
                                        className="object-cover"
                                        sizes="40px"
                                    />
                                </div>
                            )}
                            <div className="flex-1 min-w-0">
                                <Link
                                    href={buildProviderUrl(provider.homepage, username)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="group flex items-center gap-1.5"
                                >
                                    <span className="font-medium text-text dark:text-text-dark group-hover:text-primary transition-colors truncate">
                                        @{username}
                                    </span>
                                    <ExternalLink className="w-3.5 h-3.5 text-text-muted dark:text-text-muted-dark opacity-0 group-hover:opacity-100 transition-opacity" />
                                </Link>
                                {connectionInfo?.email && (
                                    <p className="text-sm text-text-muted dark:text-text-muted-dark truncate">
                                        {connectionInfo.email}
                                    </p>
                                )}
                            </div>
                        </div>

                        {/* Organizations */}
                        {organizations.length > 0 && (
                            <div className="pt-4 border-t border-border dark:border-border-dark">
                                <div className="flex items-center gap-2 mb-3">
                                    <Building2 className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                                    <h4 className="text-sm font-medium text-text dark:text-text-dark">
                                        {t('organizations', { count: organizations.length })}
                                    </h4>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    {organizations.map((org) => (
                                        <Link
                                            key={org.id}
                                            href={buildProviderUrl(provider.homepage, org.login)}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className={cn(
                                                'inline-flex items-center gap-2 px-3 py-1.5 rounded-lg',
                                                'bg-surface dark:bg-surface-dark',
                                                'border border-border dark:border-border-dark',
                                                'hover:border-primary/50 transition-colors',
                                                'text-sm',
                                            )}
                                        >
                                            {org.avatarUrl ? (
                                                <div className="relative w-5 h-5 rounded overflow-hidden">
                                                    <Image
                                                        src={org.avatarUrl}
                                                        alt={org.login}
                                                        fill
                                                        className="object-cover"
                                                        sizes="20px"
                                                    />
                                                </div>
                                            ) : (
                                                <Building2 className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                                            )}
                                            <span className="text-text dark:text-text-dark">
                                                {org.login}
                                            </span>
                                        </Link>
                                    ))}
                                </div>
                                <p className="mt-2 text-xs text-text-muted dark:text-text-muted-dark">
                                    {t('organizationsNote')}
                                </p>
                            </div>
                        )}
                    </div>
                ) : (
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('connectDescription', { provider: provider.name })}
                    </p>
                )}
            </div>
        </div>
    );
}
