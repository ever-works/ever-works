'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import type { ScheduleHealth } from '@/lib/api/schedules';

/**
 * OK / NEVER RUNS for one Schedule.
 *
 * Health is never conveyed by colour alone: the badge always carries the
 * word, and a NEVER RUNS badge puts the reason in its accessible name (and
 * its tooltip), so a screen reader hears why, not just that.
 */
export function ScheduleHealthBadge({
    health,
    className,
}: {
    health?: ScheduleHealth | null;
    className?: string;
}) {
    const t = useTranslations('dashboard.schedules.health');
    if (!health) return null;

    if (health.ok) {
        return (
            <span
                data-testid="schedule-health-badge"
                data-health="ok"
                aria-label={t('badgeLabel', { status: t('ok') })}
                className={cn(
                    'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
                    'bg-success/10 text-success dark:bg-success/15',
                    className,
                )}
            >
                {t('ok')}
            </span>
        );
    }

    const reason = health.reasonKey ? t(`reasons.${health.reasonKey}`) : null;
    const label = t('badgeLabel', { status: t('neverRuns') });
    return (
        <span
            data-testid="schedule-health-badge"
            data-health="never-runs"
            data-reason={health.reason ?? undefined}
            title={reason ?? undefined}
            aria-label={reason ? `${label}. ${reason}` : label}
            className={cn(
                'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
                'bg-danger/10 text-danger dark:bg-danger/15',
                className,
            )}
        >
            {t('neverRuns')}
        </span>
    );
}
