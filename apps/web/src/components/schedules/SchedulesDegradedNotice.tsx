'use client';

import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ScheduleSourceType } from '@/lib/api/schedules';
import { SOURCE_META } from './SchedulesList';

/**
 * One source failed to load while the others succeeded: name the missing
 * sources, say the totals exclude them, and offer a retry. The page never
 * blanks because one source is sick.
 */
export function SchedulesDegradedNotice({
    sources,
    onRetry,
}: {
    sources: ScheduleSourceType[];
    onRetry: () => void;
}) {
    const t = useTranslations('dashboard.schedules');
    if (sources.length === 0) return null;
    const names = sources
        .map((source) => t(`sourceTypes.${SOURCE_META[source].labelKey}`))
        .join(', ');

    return (
        <div
            role="status"
            data-testid="schedules-degraded-notice"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3"
        >
            <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <div className="flex-1 text-sm text-text dark:text-text-dark">
                <p>{t('degraded.sourceFailed', { sources: names })}</p>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('degraded.totalsExclude')}
                </p>
            </div>
            <button
                type="button"
                onClick={onRetry}
                className="text-xs font-medium text-primary hover:underline"
            >
                {t('retry')}
            </button>
        </div>
    );
}
