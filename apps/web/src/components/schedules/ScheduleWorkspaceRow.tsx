'use client';

import { useLocale, useTranslations } from 'next-intl';
import { ArrowUpRight } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useMounted } from '@/lib/hooks/use-mounted';
import type { ScheduleEntry, ScheduleSourceType } from '@/lib/api/schedules';
import { ActivityTimestamp } from '@/components/activity-log/ActivityTimestamp';
import { SOURCE_META, STATUS_STYLES } from './SchedulesList';
import { ScheduleCountdown } from './ScheduleCountdown';
import { ScheduleHealthBadge } from './ScheduleHealthBadge';
import { ScheduleRowMenu } from './ScheduleRowMenu';

/** Sources that record when they last fired; the others never populate it. */
const TRACKS_LAST_RUN: ReadonlySet<ScheduleSourceType> = new Set([
    'agent_heartbeat',
    'work_schedule',
    'source_validation',
    'data_sync',
    'inbound_trigger',
]);

/**
 * One row of the workspace list: what it is and where it came from, who runs
 * it, the cadence with its UTC evaluation made explicit, a live countdown to
 * the next fire (or the reason there is none), the last fire, health, status
 * and the control menu.
 *
 * Nothing is guessed: a source that does not record its last fire says so
 * rather than claiming "never", and a row with no next fire states why.
 */
export function ScheduleWorkspaceRow({
    schedule,
    serverOffsetMs,
    onChanged,
}: {
    schedule: ScheduleEntry;
    serverOffsetMs: number;
    onChanged?: (updated?: ScheduleEntry) => void;
}) {
    const t = useTranslations('dashboard.schedules');
    const locale = useLocale();
    const mounted = useMounted();
    const meta = SOURCE_META[schedule.sourceType];
    const Icon = meta.icon;
    const statusStyle = STATUS_STYLES[schedule.status] ?? STATUS_STYLES.disabled;

    const localTime =
        mounted && schedule.nextRunAt && schedule.cadenceRaw
            ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(
                  new Date(schedule.nextRunAt),
              )
            : null;

    return (
        <div
            role="row"
            data-testid={`schedule-workspace-row-${schedule.id}`}
            data-status={schedule.status}
            className="grid grid-cols-1 items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 dark:border-border-dark dark:bg-card-primary-dark @3xl/main:grid-cols-[1.6fr_0.9fr_1.1fr_0.9fr_0.8fr_auto_auto_auto] @3xl/main:gap-4"
        >
            <div role="cell" className="flex min-w-0 items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark">
                    <Icon className="h-4 w-4 text-text-secondary dark:text-text-secondary-dark" />
                </span>
                <div className="min-w-0">
                    <Link
                        href={schedule.ownerLink}
                        className="group inline-flex max-w-full items-center gap-1 text-sm font-medium text-text hover:text-primary dark:text-text-dark"
                    >
                        <span className="truncate">{schedule.ownerName}</span>
                        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                    </Link>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t(`sourceTypes.${meta.labelKey}`)}
                    </p>
                </div>
            </div>

            <div
                role="cell"
                className="truncate text-sm text-text-secondary dark:text-text-secondary-dark"
            >
                <span className="mr-1 text-xs text-text-muted dark:text-text-muted-dark @3xl/main:hidden">
                    {t('columns.agent')}:
                </span>
                {schedule.agentName ?? t('agentNone')}
            </div>

            <div role="cell" className="text-sm text-text-secondary dark:text-text-secondary-dark">
                <span className="mr-1 text-xs text-text-muted dark:text-text-muted-dark @3xl/main:hidden">
                    {t('columns.cadence')}:
                </span>
                {schedule.cadenceHuman || schedule.cadenceRaw || '—'}
                {localTime && (
                    <p className="text-[11px] text-text-muted dark:text-text-muted-dark">
                        {t('timezoneNote', { local: localTime })}
                    </p>
                )}
            </div>

            <div role="cell" className="text-sm text-text-secondary dark:text-text-secondary-dark">
                <span className="mr-1 text-xs text-text-muted dark:text-text-muted-dark @3xl/main:hidden">
                    {t('columns.next')}:
                </span>
                {schedule.nextRunAt ? (
                    <ScheduleCountdown
                        target={schedule.nextRunAt}
                        serverOffsetMs={serverOffsetMs}
                    />
                ) : (
                    <span className="text-text-muted dark:text-text-muted-dark">
                        {schedule.nextRunReasonKey
                            ? t(`nextReasons.${schedule.nextRunReasonKey}`)
                            : '—'}
                    </span>
                )}
            </div>

            <div role="cell" className="text-xs text-text-secondary dark:text-text-secondary-dark">
                <span className="mr-1 text-text-muted dark:text-text-muted-dark @3xl/main:hidden">
                    {t('columns.last')}:
                </span>
                {schedule.lastRunAt ? (
                    <ActivityTimestamp value={schedule.lastRunAt} variant="relative" />
                ) : TRACKS_LAST_RUN.has(schedule.sourceType) ? (
                    <span className="text-text-muted dark:text-text-muted-dark">
                        {t('neverRunYet')}
                    </span>
                ) : (
                    <span
                        className="text-text-muted dark:text-text-muted-dark"
                        title={t('lastNotTracked')}
                    >
                        —
                    </span>
                )}
            </div>

            <div role="cell">
                <ScheduleHealthBadge health={schedule.health} />
            </div>

            <div role="cell">
                <span
                    className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${statusStyle}`}
                >
                    {t(`statuses.${schedule.status}`)}
                </span>
            </div>

            <div role="cell" className="justify-self-end">
                <ScheduleRowMenu schedule={schedule} onChanged={onChanged} />
            </div>
        </div>
    );
}
