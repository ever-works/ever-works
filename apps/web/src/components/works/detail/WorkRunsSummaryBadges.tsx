'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import type { WorkRunsSummary } from '@/lib/api/types-only';

/**
 * Run orchestration (Wave 4 M4) — per-Work fleet summary badges fed by
 * `GET /api/works/:id/runs-summary`. A small always-scannable row
 * (running / queued / failed in 24h) on the Work's Tasks tab header;
 * zero-count badges stay hidden so a quiet Work shows nothing.
 */
export function WorkRunsSummaryBadges({ summary }: { summary: WorkRunsSummary }) {
    const t = useTranslations('dashboard.workDetail.runsSummary');

    const allBadges: Array<{
        key: 'running' | 'queued' | 'awaiting' | 'failedLast24h';
        count: number;
        className: string;
    }> = [
        {
            key: 'running',
            count: summary.running,
            className: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
        },
        {
            key: 'queued',
            count: summary.queued,
            className: 'bg-slate-100 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300',
        },
        {
            key: 'awaiting',
            count: summary.awaiting,
            className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300',
        },
        {
            key: 'failedLast24h',
            count: summary.failedLast24h,
            className: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
        },
    ];
    const badges = allBadges.filter((badge) => badge.count > 0);

    if (badges.length === 0) return null;

    return (
        <span
            className="inline-flex items-center gap-1.5 flex-wrap"
            data-testid="work-runs-summary"
        >
            {badges.map((badge) => (
                <span
                    key={badge.key}
                    className={cn(
                        'inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded',
                        badge.className,
                    )}
                    data-testid={`work-runs-summary-${badge.key}`}
                >
                    <span className="font-mono">{badge.count}</span>
                    {t(badge.key)}
                </span>
            ))}
        </span>
    );
}
