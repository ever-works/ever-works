'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';

export function EmptyState() {
    const t = useTranslations('dashboard.workDetail.activity');

    return (
        <div
            className={cn(
                'rounded-lg border border-dashed p-12 text-center',
                'border-border dark:border-border-dark',
                'bg-card/30 dark:bg-card-primary-dark/20',
            )}
        >
            <svg
                className="mx-auto h-12 w-12 text-text-muted dark:text-text-muted-dark/60"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
            >
                <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M3 12h3l3-9 6 18 3-9h3"
                />
            </svg>
            <h3 className="mt-4 text-sm font-semibold text-text dark:text-text-dark">
                {t('empty.title')}
            </h3>
            <p className="mt-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                {t('empty.body')}
            </p>
        </div>
    );
}
