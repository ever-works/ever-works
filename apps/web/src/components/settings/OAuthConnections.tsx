'use client';

import { useTransition } from 'react';
import { connectGitHub, reconnectGitHub } from '@/app/actions/dashboard/oauth';
import { disconnectGitHub } from '@/app/actions/settings';
import { toast } from 'sonner';
import { ROUTES } from '@/lib/constants';
import { useTranslations } from 'next-intl';
import { ConnectionInfo, GitHubOrganization } from '@/lib/api';
import Link from 'next/link';
import Image from 'next/image';
import { cn } from '@/lib/utils/cn';

interface OAuthConnectionsProps {
    user: {
        id: string;
        email: string;
        username?: string;
        avatar?: string;
    };
    githubConnection: ConnectionInfo | null;
    googleConnection: ConnectionInfo | null;
    organizations?: GitHubOrganization[];
}

export function OAuthConnections({
    user,
    githubConnection,
    organizations = [],
}: OAuthConnectionsProps) {
    const [isPending, startTransition] = useTransition();
    const t = useTranslations('dashboard.settings.oauth');

    const githubConnected = !!githubConnection?.connected;
    const githubUsername = githubConnection?.username || user.username || 'Unknown';
    const githubScopes = githubConnection?.scopes || [];

    const handleGitHubConnect = () => {
        startTransition(async () => {
            const result = await connectGitHub(ROUTES.DASHBOARD_SETTINGS_OAUTH);

            if (result.success && result.url) {
                window.location.href = result.url;
            } else {
                toast.error(result.error || t('github.messages.connectError'));
            }
        });
    };

    const handleGitHubReconnect = () => {
        startTransition(async () => {
            const result = await reconnectGitHub(ROUTES.DASHBOARD_SETTINGS_OAUTH);

            if (result.success && result.url) {
                window.location.href = result.url;
            } else {
                toast.error(result.error || t('github.messages.connectError'));
            }
        });
    };

    const handleGitHubDisconnect = () => {
        if (!confirm(t('github.actions.confirmDisconnect'))) {
            return;
        }

        startTransition(async () => {
            const result = await disconnectGitHub();

            if (result.success) {
                toast.success(t('github.messages.disconnected'));
            } else {
                toast.error(result.error || t('github.messages.disconnectError'));
            }
        });
    };

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-4">
                    {t('title')}
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark text-sm">{t('subtitle')}</p>
            </div>

            {/* GitHub Connection */}
            <div
                className={cn(
                    'p-6 rounded-lg',
                    'bg-card dark:bg-card-dark',
                    'border border-card-border dark:border-card-border-dark',
                )}
            >
                <div className="flex items-start justify-between">
                    <div className="flex items-start gap-4">
                        <div className="w-12 h-12 rounded-lg bg-surface dark:bg-surface-dark flex items-center justify-center">
                            <svg
                                className="w-7 h-7 text-text dark:text-text-dark"
                                fill="currentColor"
                                viewBox="0 0 24 24"
                            >
                                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                            </svg>
                        </div>

                        <div className="flex-1">
                            <h3 className="font-medium text-text dark:text-text-dark text-lg">
                                {t('github.name')}
                            </h3>

                            {githubConnected ? (
                                <>
                                    <p className="text-sm text-success flex items-center gap-1.5 mt-1">
                                        <span className="w-2 h-2 bg-success rounded-full"></span>
                                        {t('github.connected')}
                                    </p>

                                    <div className="mt-3 space-y-2">
                                        <div className="inline-flex items-center gap-2 relative group/github">
                                            <Link
                                                href={`https://github.com/${githubUsername}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="absolute inset-0 z-10"
                                            />

                                            {user.avatar && (
                                                <div className="relative w-5 h-5">
                                                    <Image
                                                        src={user.avatar}
                                                        alt={githubUsername}
                                                        fill
                                                        className="rounded-full"
                                                        sizes="20px"
                                                    />
                                                </div>
                                            )}

                                            <span className="text-sm text-text dark:text-text-dark group-hover/github:text-primary transition-colors">
                                                @{githubUsername}
                                            </span>
                                        </div>

                                        {githubScopes.length > 0 && (
                                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                                {t('github.scopes')}: {githubScopes.join(', ')}
                                            </p>
                                        )}
                                    </div>
                                </>
                            ) : (
                                <>
                                    <p className="text-sm text-warning flex items-center gap-1.5 mt-1">
                                        <span className="w-2 h-2 bg-warning rounded-full"></span>
                                        {t('github.disconnected')}
                                    </p>
                                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-3">
                                        Connect your GitHub account to import repositories and
                                        manage your projects.
                                    </p>
                                </>
                            )}
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        {githubConnected ? (
                            <>
                                <button
                                    onClick={handleGitHubReconnect}
                                    disabled={isPending}
                                    className={cn(
                                        'px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer',
                                        'bg-surface dark:bg-surface-dark',
                                        'text-text dark:text-text-dark',
                                        'border border-card-border dark:border-card-border-dark',
                                        'hover:bg-surface-hover dark:hover:bg-surface-hover-dark',
                                        'disabled:opacity-50 disabled:cursor-not-allowed',
                                    )}
                                >
                                    {isPending ? 'Reconnecting...' : t('github.actions.reconnect')}
                                </button>
                                <button
                                    onClick={handleGitHubDisconnect}
                                    disabled={isPending}
                                    className={cn(
                                        'px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer',
                                        'bg-red-500/10 text-red-600 dark:text-red-400',
                                        'hover:bg-red-500/20',
                                        'disabled:opacity-50 disabled:cursor-not-allowed',
                                    )}
                                >
                                    {isPending
                                        ? 'Disconnecting...'
                                        : t('github.actions.disconnect')}
                                </button>
                            </>
                        ) : (
                            <button
                                onClick={handleGitHubConnect}
                                disabled={isPending}
                                className={cn(
                                    'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                                    'bg-black dark:bg-white text-white dark:text-black',
                                    'hover:bg-gray-800 dark:hover:bg-gray-200',
                                    'disabled:opacity-50 disabled:cursor-not-allowed',
                                    'flex items-center gap-2',
                                )}
                            >
                                {isPending ? (
                                    <>
                                        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                                        Connecting...
                                    </>
                                ) : (
                                    <>
                                        <svg
                                            className="w-4 h-4"
                                            fill="currentColor"
                                            viewBox="0 0 24 24"
                                        >
                                            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                                        </svg>
                                        {t('github.actions.connect')}
                                    </>
                                )}
                            </button>
                        )}
                    </div>
                </div>

                {/* Organizations List */}
                {githubConnected && organizations.length > 0 && (
                    <div className="mt-6 pt-6 border-t border-card-border dark:border-card-border-dark">
                        <h4 className="text-sm font-medium text-text dark:text-text-dark mb-3">
                            {t('github.organizations')}
                        </h4>
                        <div className="grid gap-3 sm:grid-cols-2">
                            {organizations.map((org) => (
                                <Link
                                    key={org.id}
                                    href={`https://github.com/${org.login}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={cn(
                                        'flex items-center gap-3 p-3 rounded-lg',
                                        'bg-surface dark:bg-surface-dark',
                                        'border border-card-border dark:border-card-border-dark',
                                        'hover:border-primary/50 transition-colors',
                                    )}
                                >
                                    <div className="relative w-8 h-8 flex-shrink-0">
                                        <Image
                                            src={org.avatar_url}
                                            alt={org.login}
                                            fill
                                            className="rounded-md"
                                            sizes="32px"
                                        />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm font-medium text-text dark:text-text-dark truncate">
                                            {org.login}
                                        </p>
                                        {org.description && (
                                            <p className="text-xs text-text-muted dark:text-text-muted-dark truncate">
                                                {org.description}
                                            </p>
                                        )}
                                    </div>
                                </Link>
                            ))}
                        </div>
                        <p className="mt-3 text-xs text-text-muted dark:text-text-muted-dark">
                            {t('github.organizationsHint')}
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}
