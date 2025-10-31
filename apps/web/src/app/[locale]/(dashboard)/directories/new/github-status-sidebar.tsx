'use client';

import { useTransition } from 'react';
import { cn } from '@/lib/utils/cn';
import { connectGitHub } from '@/app/actions/dashboard';
import { toast } from 'sonner';
import { ROUTES } from '@/lib/constants';
import { AuthUser } from '@/lib/auth';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { ConnectionInfo } from '@/lib/api';
import Link from 'next/link';

interface GitHubStatusSidebarProps {
    user: AuthUser;
    githubConnection: ConnectionInfo | null;
}

export function GitHubStatusSidebar({ user, githubConnection }: GitHubStatusSidebarProps) {
    const [isPending, startTransition] = useTransition();
    const t = useTranslations('dashboard.github.connection.status');

    const handleGitHubConnect = () => {
        startTransition(async () => {
            const result = await connectGitHub(ROUTES.DASHBOARD_DIRECTORIES_NEW);

            if (result.success && result.url) {
                window.location.href = result.url;
            } else {
                toast.error(result.error || t('failedToConnect'));
            }
        });
    };

    const githubConnected = !!githubConnection?.connected;
    const githubUsername = githubConnection?.username || user.username;

    return (
        <aside className="w-80 shrink-0">
            <div
                className={cn(
                    'sticky top-8 p-6 rounded-lg',
                    'bg-card dark:bg-card-dark',
                    'border border-card-border dark:border-card-border-dark',
                )}
            >
                <div className="flex items-center gap-3 mb-4">
                    <svg
                        className="w-8 h-8 text-text dark:text-text-dark"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                    </svg>
                    <div>
                        <h3 className="font-medium text-text dark:text-text-dark">{t('title')}</h3>
                        {githubConnected ? (
                            <p className="text-sm text-success flex items-center gap-1">
                                <span className="w-2 h-2 bg-success rounded-full"></span>
                                {t('connected')}
                            </p>
                        ) : (
                            <p className="text-sm text-warning flex items-center gap-1">
                                <span className="w-2 h-2 bg-warning rounded-full"></span>
                                {t('notConnected')}
                            </p>
                        )}
                    </div>
                </div>

                {githubConnected ? (
                    <div className="space-y-3">
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {t('connectedDescription')}
                        </p>
                        <div className="pt-3 border-t border-border dark:border-border-dark">
                            <p className="text-xs text-text-muted dark:text-text-muted-dark mb-2">
                                {t('connectedAccount')}
                            </p>
                            <div className="inline-flex items-center gap-2 relative group/github">
                                <Link
                                    href={`https://github.com/${githubUsername}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="absolute inset-0 z-10"
                                />

                                {user.avatar && (
                                    <div className="relative w-6 h-6">
                                        <Image
                                            src={user.avatar}
                                            alt={githubUsername}
                                            fill
                                            className="w-6 h-6 rounded-full"
                                            sizes="40px"
                                        />
                                    </div>
                                )}

                                <span className="text-sm text-text dark:text-text-dark group-hover/github:text-primary">
                                    @{githubUsername}
                                </span>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-4">
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {t('notConnectedDescription')}
                        </p>
                        <button
                            onClick={handleGitHubConnect}
                            disabled={isPending}
                            className={cn(
                                'w-full px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                                'bg-black dark:bg-white text-white dark:text-black',
                                'hover:bg-gray-800 dark:hover:bg-gray-200',
                                'disabled:opacity-50 disabled:cursor-not-allowed',
                                'flex items-center justify-center gap-2',
                            )}
                        >
                            {isPending ? (
                                <>
                                    <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                                    {t('connectingButton')}
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
                                    {t('connectButton')}
                                </>
                            )}
                        </button>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark text-center">
                            {t('requiredNote')}
                        </p>
                    </div>
                )}
            </div>
        </aside>
    );
}
