'use client';

import { useTransition } from 'react';
import { cn } from '@/lib/utils/cn';
import { connectGitHub } from '@/app/actions/dashboard/oauth';
import { toast } from 'sonner';
import { ROUTES } from '@/lib/constants';
import { useTranslations } from 'next-intl';

interface GitHubConnectionAlertProps {
    githubConnected: boolean;
}

export function GitHubConnectionAlert({ githubConnected }: GitHubConnectionAlertProps) {
    const [isPending, startTransition] = useTransition();
    const t = useTranslations('dashboard.github.connection.alert');

    const handleGitHubConnect = () => {
        startTransition(async () => {
            const result = await connectGitHub(ROUTES.DASHBOARD_DIRECTORIES_NEW);

            if (result.success && result.url) {
                window.location.href = result.url;
            } else {
                toast.error(result.error || 'Failed to connect GitHub');
            }
        });
    };

    if (githubConnected) {
        return null;
    }

    return (
        <div
            className={cn(
                'mb-6 p-4 rounded-lg flex items-center justify-between',
                'bg-warning/10 border border-warning/20',
            )}
        >
            <div className="flex items-center gap-3">
                <svg
                    className="w-5 h-5 text-warning"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                </svg>
                <div>
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {t('title')}
                    </p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('subtitle')}
                    </p>
                </div>
            </div>
            <button
                onClick={handleGitHubConnect}
                disabled={isPending}
                className={cn(
                    'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                    'bg-black dark:bg-white text-white dark:text-black',
                    'hover:bg-gray-800 dark:hover:bg-gray-200',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
            >
                {isPending ? t('connectingButton') : t('connectButton')}
            </button>
        </div>
    );
}
