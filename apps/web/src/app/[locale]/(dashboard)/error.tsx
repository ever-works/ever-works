'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export default function DashboardError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    const t = useTranslations('errors.dashboard');

    useEffect(() => {
        console.error('Dashboard error:', error);
    }, [error]);

    return (
        <div className="flex flex-1 items-center justify-center p-8">
            <div className="text-center max-w-md animate-fade-in">
                <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-danger/10">
                    <AlertTriangle className="h-8 w-8 text-danger" />
                </div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                    {t('title')}
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark mb-6 leading-relaxed">
                    {t('description')}
                </p>
                {error.digest && (
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mb-6 font-mono bg-surface-secondary dark:bg-surface-secondary-dark px-3 py-1.5 rounded-md inline-block">
                        {t('errorId')}: {error.digest}
                    </p>
                )}
                <div className="flex items-center justify-center gap-3">
                    <button
                        onClick={reset}
                        className="inline-flex items-center justify-center gap-2 px-6 py-2.5 rounded-lg font-medium transition-colors bg-primary text-white hover:bg-primary-hover"
                    >
                        <RefreshCw className="w-4 h-4" />
                        {t('tryAgain')}
                    </button>
                </div>
            </div>
        </div>
    );
}
