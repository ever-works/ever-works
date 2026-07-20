'use client';

import { useState, useEffect, useCallback, useMemo, type ComponentType } from 'react';
import { useTranslations } from 'next-intl';
import {
    Loader2,
    Repeat,
    Bot,
    CalendarClock,
    Target,
    ShieldCheck,
    RefreshCw,
    CalendarX,
    ArrowUpRight,
    type LucideProps,
} from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { getSchedules } from '@/app/actions/dashboard/schedules';
import type { ScheduleEntry, ScheduleSourceType, ScheduleStatus } from '@/lib/api/schedules';
import { ActivityTimestamp } from '@/components/activity-log/ActivityTimestamp';

type IconType = ComponentType<LucideProps>;

// Literal union (not `string`) so next-intl can type-check the
// `sourceTypes.${labelKey}` message key at the call sites below.
type SourceLabelKey =
    | 'recurringTask'
    | 'agentHeartbeat'
    | 'workSchedule'
    | 'missionTick'
    | 'sourceValidation'
    | 'dataSync';

const SOURCE_META: Record<ScheduleSourceType, { icon: IconType; labelKey: SourceLabelKey }> = {
    recurring_task: { icon: Repeat, labelKey: 'recurringTask' },
    agent_heartbeat: { icon: Bot, labelKey: 'agentHeartbeat' },
    work_schedule: { icon: CalendarClock, labelKey: 'workSchedule' },
    mission_tick: { icon: Target, labelKey: 'missionTick' },
    source_validation: { icon: ShieldCheck, labelKey: 'sourceValidation' },
    data_sync: { icon: RefreshCw, labelKey: 'dataSync' },
};

const SOURCE_ORDER: ScheduleSourceType[] = [
    'recurring_task',
    'agent_heartbeat',
    'work_schedule',
    'mission_tick',
    'source_validation',
    'data_sync',
];

const STATUS_STYLES: Record<ScheduleStatus, string> = {
    active: 'bg-success/10 text-success dark:bg-success/15',
    paused: 'bg-warning/10 text-warning dark:bg-warning/15',
    disabled:
        'bg-surface-secondary text-text-muted dark:bg-surface-secondary-dark dark:text-text-muted-dark',
    error: 'bg-danger/10 text-danger dark:bg-danger/15',
    ended: 'bg-surface-secondary text-text-muted dark:bg-surface-secondary-dark dark:text-text-muted-dark',
};

export function SchedulesList() {
    const t = useTranslations('dashboard.schedules');
    const [schedules, setSchedules] = useState<ScheduleEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [sourceFilter, setSourceFilter] = useState<ScheduleSourceType | 'all'>('all');
    const [activeOnly, setActiveOnly] = useState(false);

    const fetchSchedules = useCallback(async () => {
        setLoading(true);
        setError(false);
        try {
            const response = await getSchedules();
            if (response.success) {
                setSchedules(response.schedules);
            } else {
                setError(true);
            }
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void fetchSchedules();
    }, [fetchSchedules]);

    const countsByType = useMemo(() => {
        const counts: Partial<Record<ScheduleSourceType, number>> = {};
        for (const schedule of schedules) {
            counts[schedule.sourceType] = (counts[schedule.sourceType] ?? 0) + 1;
        }
        return counts;
    }, [schedules]);

    const visible = useMemo(() => {
        return schedules.filter((schedule) => {
            if (sourceFilter !== 'all' && schedule.sourceType !== sourceFilter) return false;
            if (activeOnly && !schedule.enabled) return false;
            return true;
        });
    }, [schedules, sourceFilter, activeOnly]);

    const availableSources = useMemo(
        () => SOURCE_ORDER.filter((source) => (countsByType[source] ?? 0) > 0),
        [countsByType],
    );

    if (loading) {
        return (
            <div className="flex justify-center py-16" data-testid="schedules-list">
                <Loader2 className="w-6 h-6 animate-spin text-text-muted dark:text-text-muted-dark" />
            </div>
        );
    }

    if (error) {
        return (
            <div
                className="flex flex-col items-center justify-center py-16 text-center"
                data-testid="schedules-list"
            >
                <p className="text-sm text-text-muted dark:text-text-muted-dark mb-3">
                    {t('fetchFailed')}
                </p>
                <button
                    onClick={() => void fetchSchedules()}
                    className="text-sm text-primary hover:underline font-medium"
                >
                    {t('retry')}
                </button>
            </div>
        );
    }

    if (schedules.length === 0) {
        return (
            <div
                className="flex flex-col items-center justify-center py-16 text-center"
                data-testid="schedules-list"
            >
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-secondary dark:bg-surface-secondary-dark">
                    <CalendarX className="h-7 w-7 text-text-muted dark:text-text-muted-dark" />
                </div>
                <h3 className="text-lg font-semibold text-text dark:text-text-dark mb-1">
                    {t('empty.title')}
                </h3>
                <p className="text-sm text-text-muted dark:text-text-muted-dark max-w-sm">
                    {t('empty.description')}
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-4" data-testid="schedules-list">
            {/* Filters — source-type chips + active-only toggle */}
            <div className="flex flex-wrap items-center gap-2">
                <FilterChip
                    active={sourceFilter === 'all'}
                    onClick={() => setSourceFilter('all')}
                    label={t('filters.all')}
                    count={schedules.length}
                />
                {availableSources.map((source) => (
                    <FilterChip
                        key={source}
                        active={sourceFilter === source}
                        onClick={() => setSourceFilter(source)}
                        label={t(`sourceTypes.${SOURCE_META[source].labelKey}`)}
                        count={countsByType[source] ?? 0}
                    />
                ))}
                <label className="ml-auto inline-flex items-center gap-2 text-xs font-medium text-text-secondary dark:text-text-secondary-dark cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={activeOnly}
                        onChange={(event) => setActiveOnly(event.target.checked)}
                        className="rounded border-border dark:border-border-dark"
                    />
                    {t('filters.activeOnly')}
                </label>
            </div>

            {/* Column header — desktop only */}
            <div className="hidden @2xl/main:grid grid-cols-[1.6fr_1fr_1fr_auto] gap-4 px-4 text-xs font-medium uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                <span>{t('columns.owner')}</span>
                <span>{t('columns.cadence')}</span>
                <span>{t('columns.nextRun')}</span>
                <span className="text-right">{t('columns.status')}</span>
            </div>

            <div className="space-y-2">
                {visible.map((schedule) => (
                    <ScheduleRow key={schedule.id} schedule={schedule} />
                ))}
            </div>

            {visible.length === 0 && (
                <p className="py-8 text-center text-sm text-text-muted dark:text-text-muted-dark">
                    {t('empty.noResults')}
                </p>
            )}
        </div>
    );
}

function FilterChip({
    active,
    onClick,
    label,
    count,
}: {
    active: boolean;
    onClick: () => void;
    label: string;
    count: number;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                active
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-border dark:border-border-dark text-text-secondary dark:text-text-secondary-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark'
            }`}
        >
            <span>{label}</span>
            <span className="tabular-nums opacity-70">{count}</span>
        </button>
    );
}

function ScheduleRow({ schedule }: { schedule: ScheduleEntry }) {
    const t = useTranslations('dashboard.schedules');
    const meta = SOURCE_META[schedule.sourceType];
    const Icon = meta.icon;
    const statusStyle = STATUS_STYLES[schedule.status] ?? STATUS_STYLES.disabled;

    return (
        <div
            data-testid={`schedule-row-${schedule.id}`}
            className="grid grid-cols-1 @2xl/main:grid-cols-[1.6fr_1fr_1fr_auto] gap-3 @2xl/main:gap-4 items-center rounded-lg border border-border dark:border-border-dark bg-card dark:bg-card-primary-dark px-4 py-3.5 transition-colors hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark"
        >
            {/* Owner + source type */}
            <div className="flex items-center gap-3 min-w-0">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark">
                    <Icon className="h-4 w-4 text-text-secondary dark:text-text-secondary-dark" />
                </span>
                <div className="min-w-0">
                    <Link
                        href={schedule.ownerLink}
                        className="group inline-flex items-center gap-1 text-sm font-medium text-text dark:text-text-dark hover:text-primary truncate"
                    >
                        <span className="truncate">{schedule.ownerName}</span>
                        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                    </Link>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t(`sourceTypes.${meta.labelKey}`)}
                    </p>
                </div>
            </div>

            {/* Cadence */}
            <div className="text-sm text-text-secondary dark:text-text-secondary-dark">
                <span className="@2xl/main:hidden text-xs text-text-muted dark:text-text-muted-dark mr-1">
                    {t('columns.cadence')}:
                </span>
                {schedule.cadenceHuman || schedule.cadenceRaw || '—'}
            </div>

            {/* Next run */}
            <div className="text-sm text-text-secondary dark:text-text-secondary-dark">
                <span className="@2xl/main:hidden text-xs text-text-muted dark:text-text-muted-dark mr-1">
                    {t('columns.nextRun')}:
                </span>
                {schedule.nextRunAt ? (
                    <ActivityTimestamp value={schedule.nextRunAt} variant="relative" />
                ) : (
                    <span className="text-text-muted dark:text-text-muted-dark">—</span>
                )}
            </div>

            {/* Status */}
            <div className="@2xl/main:text-right">
                <span
                    className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${statusStyle}`}
                >
                    {t(`statuses.${schedule.status}`)}
                </span>
            </div>
        </div>
    );
}
