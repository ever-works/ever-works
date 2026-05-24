'use client';

import { CalendarClock, ChevronRight, GitFork, Target } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { StatusPill } from '@/components/work-agent';
import type { Mission } from '@/lib/api/missions';

/**
 * Phase 6 PR Q — MissionCard.
 *
 * Read-only summary card for a single Mission, rendered in the
 * /missions list grid (this PR) and (Phase 6 PR S) the dashboard
 * Missions preview block above the Ideas block. Whole card is a
 * link to the Mission detail page (Phase 6 PR R).
 *
 * Cap rendering rules (mirrors `MissionTickService.resolveEffectiveCap`):
 *   - per-Mission `outstandingIdeasCap = null`     → "Inherit user default"
 *   - per-Mission `outstandingIdeasCap = -1`       → "Unlimited"
 *   - per-Mission `outstandingIdeasCap = <number>` → that number
 */
export function MissionCard({ mission }: { mission: Mission }) {
    const t = useTranslations('dashboard.missionsPage.card');

    const isScheduled = mission.type === 'scheduled';
    const capLabel =
        mission.outstandingIdeasCap === null
            ? t('capInherit')
            : mission.outstandingIdeasCap < 0
              ? t('capUnlimited')
              : String(mission.outstandingIdeasCap);

    return (
        <Link
            href={ROUTES.DASHBOARD_MISSION(mission.id)}
            className={cn(
                'group relative flex min-h-[12rem] flex-col overflow-hidden rounded-lg p-4 shadow-xs',
                'bg-card dark:bg-card-primary-dark/70',
                'border border-card-border dark:border-white/9',
                'hover:border-primary-500/50 dark:hover:border-white/20',
                'transition-colors',
                'no-underline',
            )}
        >
            <div className="flex items-start gap-3 mb-3 pr-6 min-w-0">
                <div className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center bg-warning/10 border border-warning/20">
                    <Target strokeWidth={1.4} className="w-4 h-4 text-warning" />
                </div>
                <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold text-text dark:text-text-dark leading-snug line-clamp-2">
                        {mission.title}
                    </h3>
                    <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark line-clamp-2">
                        {mission.description}
                    </p>
                </div>
                <ChevronRight className="w-4 h-4 text-text-muted dark:text-text-muted-dark shrink-0 mt-1 opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>

            <div className="mb-3 flex flex-wrap items-center gap-2">
                <StatusPill status={mission.status} />
                {isScheduled ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-info/30 bg-info/5 dark:bg-info/10 px-2 py-0.5 text-[11px] font-medium text-info">
                        <CalendarClock className="w-3 h-3" />
                        {t('scheduled')}
                    </span>
                ) : (
                    <span className="inline-flex items-center rounded-full border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2 py-0.5 text-[11px] font-medium text-text-muted dark:text-text-muted-dark">
                        {t('oneShot')}
                    </span>
                )}
                {mission.sourceMissionId && (
                    <span
                        title={t('clonedFromPrefix')}
                        className="inline-flex items-center gap-1 rounded-full border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2 py-0.5 text-[11px] font-medium text-text-muted dark:text-text-muted-dark"
                    >
                        <GitFork className="w-3 h-3" />
                    </span>
                )}
            </div>

            <div className="mt-auto text-xs text-text-muted dark:text-text-muted-dark space-y-0.5">
                {isScheduled && mission.schedule && (
                    <div>
                        <span className="font-medium text-text-secondary dark:text-text-secondary-dark">
                            {t('schedulePrefix')}
                        </span>{' '}
                        <code className="font-mono">{mission.schedule}</code>
                    </div>
                )}
                <div>
                    <span className="font-medium text-text-secondary dark:text-text-secondary-dark">
                        {t('capPrefix')}
                    </span>{' '}
                    {capLabel}
                </div>
                <div>{mission.autoBuildWorks ? t('autoBuildOn') : t('autoBuildOff')}</div>
            </div>
        </Link>
    );
}
