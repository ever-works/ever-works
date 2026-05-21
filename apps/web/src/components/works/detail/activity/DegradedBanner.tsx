'use client';

import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils/cn';
import type { FeedDegradedReason } from '@/lib/api/works/activity-feed.types';

interface DegradedBannerProps {
    degraded: FeedDegradedReason;
}

export function DegradedBanner({ degraded }: DegradedBannerProps) {
    const t = useTranslations('dashboard.workDetail.activity.degraded');

    const actionLabel = t(`action.${degraded.reason}`);
    const lastSuccessLabel = degraded.lastSuccessAt
        ? t('lastSuccess', {
              time: formatDistanceToNow(new Date(degraded.lastSuccessAt), { addSuffix: true }),
          })
        : t('lastSuccessNever');

    return (
        <div
            role="status"
            className={cn(
                'rounded-md border p-3 mb-4',
                'border-warning/30 bg-warning/10',
                'text-warning-foreground dark:text-text-dark',
            )}
        >
            <div className="flex items-start gap-3">
                <svg
                    className="h-5 w-5 shrink-0 text-warning"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z"
                    />
                </svg>
                <div className="flex-1 text-xs">
                    <div className="font-medium">{t(`title.${degraded.reason}`)}</div>
                    <div className="mt-0.5 text-text-secondary dark:text-text-secondary-dark">
                        {lastSuccessLabel}
                    </div>
                    <div className="mt-1 text-text-secondary dark:text-text-secondary-dark">
                        {actionLabel}
                    </div>
                    {degraded.detail && (
                        <code className="mt-1 block max-w-full truncate rounded bg-warning/10 px-1 py-0.5 text-[11px] text-warning-foreground dark:text-text-dark">
                            {degraded.detail}
                        </code>
                    )}
                </div>
            </div>
        </div>
    );
}
