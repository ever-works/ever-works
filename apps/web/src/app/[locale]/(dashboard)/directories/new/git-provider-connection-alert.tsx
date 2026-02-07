'use client';

import { useTransition } from 'react';
import { cn } from '@/lib/utils/cn';
import { connectOAuthProvider } from '@/app/actions/dashboard/oauth';
import { toast } from 'sonner';
import { ROUTES } from '@/lib/constants';
import { useTranslations } from 'next-intl';
import type { GitProviderConnectionInfo } from '@/lib/api';

interface GitProviderConnectionAlertProps {
    connected: boolean;
    provider: GitProviderConnectionInfo | null;
}

export function GitProviderConnectionAlert({
    connected,
    provider,
}: GitProviderConnectionAlertProps) {
    const [isPending, startTransition] = useTransition();
    const t = useTranslations('dashboard.gitProvider.connection.alert');

    const handleConnect = () => {
        if (!provider?.id) {
            toast.error('No provider selected');
            return;
        }

        startTransition(async () => {
            const result = await connectOAuthProvider(
                provider.id,
                ROUTES.DASHBOARD_DIRECTORIES_NEW,
            );

            if (result.success && result.url) {
                window.location.href = result.url;
            } else {
                toast.error(result.error || 'Failed to connect');
            }
        });
    };

    if (connected) {
        return null;
    }

    const providerName = provider?.name || 'Git';

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
                        {t('title', { provider: providerName })}
                    </p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('subtitle', { provider: providerName })}
                    </p>
                </div>
            </div>
            <button
                onClick={handleConnect}
                disabled={isPending}
                className={cn(
                    'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                    'bg-primary text-white',
                    'hover:bg-primary/90',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
            >
                {isPending ? t('connectingButton') : t('connectButton', { provider: providerName })}
            </button>
        </div>
    );
}
