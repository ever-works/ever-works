'use client';

import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils/cn';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { useTranslations } from 'next-intl';
import type { ActivityLogEntry } from '@/lib/api/activity-log';
import {
    Clock,
    Loader2,
    CheckCircle2,
    XCircle,
    OctagonMinus,
    ChevronDown,
    type LucideIcon,
} from 'lucide-react';
import { ShowDateTime } from '@/components/ui/show-datetime';
import { ActivityStatusBadge } from './ActivityStatusBadge';
import { ActivityTypeBadge } from './ActivityTypeBadge';

const MAX_VISIBLE = 15;

// ─── Column definitions ────────────────────────────────────────────────────

type ColumnKey = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

interface ColumnDef {
    key: ColumnKey;
    icon: LucideIcon;
    dotClass: string;
    headerClass: string;
    countClass: string;
    cardBorderClass: string;
    iconBgClass: string;
    iconColorClass: string;
}

const COLUMNS: ColumnDef[] = [
    {
        key: 'pending',
        icon: Clock,
        dotClass: 'bg-warning',
        headerClass: 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800/40',
        countClass: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300',
        cardBorderClass:
            'border-amber-200/60 dark:border-amber-800/30 hover:border-amber-300 dark:hover:border-amber-700/50',
        iconBgClass: 'bg-amber-50 dark:bg-amber-900/20',
        iconColorClass: 'text-warning dark:text-amber-400',
    },
    {
        key: 'in_progress',
        icon: Loader2,
        dotClass: 'bg-info animate-pulse',
        headerClass: 'bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800/40',
        countClass: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
        cardBorderClass:
            'border-blue-200/60 dark:border-blue-800/30 hover:border-blue-300 dark:hover:border-blue-700/50',
        iconBgClass: 'bg-blue-50 dark:bg-blue-900/20',
        iconColorClass: 'text-info dark:text-blue-400',
    },
    {
        key: 'completed',
        icon: CheckCircle2,
        dotClass: 'bg-success',
        headerClass:
            'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/40',
        countClass: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
        cardBorderClass:
            'border-emerald-200/60 dark:border-emerald-800/30 hover:border-emerald-300 dark:hover:border-emerald-700/50',
        iconBgClass: 'bg-emerald-50 dark:bg-emerald-900/20',
        iconColorClass: 'text-success dark:text-emerald-400',
    },
    {
        key: 'failed',
        icon: XCircle,
        dotClass: 'bg-danger',
        headerClass: 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800/40',
        countClass: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
        cardBorderClass:
            'border-red-200/60 dark:border-red-800/30 hover:border-red-300 dark:hover:border-red-700/50',
        iconBgClass: 'bg-red-50 dark:bg-red-900/20',
        iconColorClass: 'text-danger dark:text-red-400',
    },
    {
        key: 'cancelled',
        icon: OctagonMinus,
        dotClass: 'bg-amber-500',
        headerClass:
            'bg-orange-50 dark:bg-orange-950/20 border-orange-200 dark:border-orange-800/40',
        countClass: 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300',
        cardBorderClass:
            'border-orange-200/60 dark:border-orange-800/30 hover:border-orange-300 dark:hover:border-orange-700/50',
        iconBgClass: 'bg-orange-50 dark:bg-orange-900/20',
        iconColorClass: 'text-amber-600 dark:text-orange-400',
    },
];

// ─── Date formatter ────────────────────────────────────────────────────────

const formatDate = (date: string, locale: string) =>
    new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    }).format(new Date(date));

// ─── Kanban card ───────────────────────────────────────────────────────────

interface ActivityCardProps {
    entry: ActivityLogEntry;
    col: ColumnDef;
}

function ActivityCard({ entry, col }: ActivityCardProps) {
    const t = useTranslations('dashboard.activity.kanban');
    const isInProgress = entry.status === 'in_progress';
    const Icon = col.icon;

    const cardContent = (
        <div
            className={cn(
                'group flex flex-col gap-2 p-3.5 rounded-lg border',
                'bg-card dark:bg-card-primary-dark/70',
                'transition-all duration-150',
                col.cardBorderClass,
                isInProgress &&
                    'before:absolute before:inset-0 before:rounded-lg before:border before:border-info/30 before:animate-pulse before:pointer-events-none relative overflow-hidden',
            )}
        >
            {/* Header: type badge + status icon */}
            <div className="flex items-start justify-between gap-2">
                <ActivityTypeBadge actionType={entry.actionType} />
                <div
                    className={cn(
                        'shrink-0 w-6 h-6 rounded-md flex items-center justify-center',
                        col.iconBgClass,
                    )}
                >
                    <Icon
                        className={cn(
                            'w-3 h-3',
                            col.iconColorClass,
                            isInProgress && 'animate-spin',
                        )}
                    />
                </div>
            </div>

            {/* Work name */}
            {entry.work?.name ? (
                <p className="text-xs font-semibold text-text dark:text-text-dark leading-snug line-clamp-1">
                    {entry.work.name}
                </p>
            ) : (
                <p className="text-[11px] text-text-muted dark:text-text-muted-dark italic">
                    {t('noWork')}
                </p>
            )}

            {/* Summary */}
            {entry.summary && (
                <p className="text-[11px] leading-4.5 text-text-secondary dark:text-text-secondary-dark line-clamp-2">
                    {entry.summary}
                </p>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between pt-2 border-t border-border dark:border-border-dark mt-auto">
                <ActivityStatusBadge status={entry.status} />
                <span className="text-[10px] text-text-muted dark:text-text-muted-dark shrink-0 ml-2">
                    <ShowDateTime value={entry.createdAt} customFormatter={formatDate} />
                </span>
            </div>
        </div>
    );

    if (entry.workId) {
        return (
            <Link href={ROUTES.DASHBOARD_WORK(entry.workId)} className="block">
                {cardContent}
            </Link>
        );
    }

    return cardContent;
}

// ─── Column ────────────────────────────────────────────────────────────────

interface ActivityColumnProps {
    col: ColumnDef;
    entries: ActivityLogEntry[];
}

function ActivityColumn({ col, entries }: ActivityColumnProps) {
    const [visibleCount, setVisibleCount] = useState(MAX_VISIBLE);
    const t = useTranslations('dashboard.activity.kanban');
    const tCols = useTranslations('dashboard.activity.kanban.columns');
    const Icon = col.icon;

    const visibleEntries = entries.slice(0, visibleCount);
    const remaining = entries.length - visibleCount;
    const hasMore = remaining > 0;

    return (
        <div className="flex flex-col min-w-[220px] w-full flex-1">
            {/* Column header */}
            <div
                className={cn(
                    'flex items-center gap-2 px-3 py-2.5 rounded-t-lg border border-b-0',
                    col.headerClass,
                )}
            >
                <span className={cn('w-2 h-2 rounded-full shrink-0', col.dotClass)} />
                <Icon className={cn('w-3.5 h-3.5 shrink-0', col.iconColorClass)} />
                <span className="text-xs font-semibold text-text dark:text-text-dark flex-1 truncate">
                    {tCols(col.key)}
                </span>
                <span
                    className={cn(
                        'min-w-[20px] text-center text-[10px] font-semibold px-1.5 py-0.5 rounded-full',
                        col.countClass,
                    )}
                >
                    {entries.length}
                </span>
            </div>

            {/* Card list — fixed height, scrollable */}
            <div
                className={cn(
                    'flex flex-col gap-2 p-2 overflow-y-auto border border-t-0',
                    'border-slate-200/60 dark:border-white/8',
                    'bg-slate-50/50 dark:bg-white/[0.015]',
                    'min-h-[120px] h-[600px]',
                    !hasMore && 'rounded-b-lg',
                )}
            >
                {entries.length === 0 ? (
                    <div className="flex-1 flex items-center justify-center py-6">
                        <p className="text-[11px] text-text-muted dark:text-text-muted-dark text-center">
                            {t('empty')}
                        </p>
                    </div>
                ) : (
                    visibleEntries.map((entry) => (
                        <ActivityCard key={entry.id} entry={entry} col={col} />
                    ))
                )}
            </div>

            {/* Load more button */}
            {hasMore && (
                <button
                    onClick={() => setVisibleCount((v) => v + MAX_VISIBLE)}
                    className={cn(
                        'flex items-center justify-center gap-1.5 w-full px-3 py-2 rounded-b-lg border border-t-0',
                        'border-slate-200/60 dark:border-white/8',
                        'bg-slate-50 dark:bg-white/2',
                        'text-[11px] font-medium text-text-muted dark:text-text-muted-dark',
                        'hover:bg-slate-100 dark:hover:bg-white/4 hover:text-text-secondary dark:hover:text-text-secondary-dark',
                        'transition-colors',
                    )}
                >
                    <ChevronDown className="w-3 h-3" />
                    {t('loadMore', { count: Math.min(remaining, MAX_VISIBLE) })}
                </button>
            )}
        </div>
    );
}

// ─── Main export ───────────────────────────────────────────────────────────

interface ActivityKanbanViewProps {
    activities: ActivityLogEntry[];
}

export function ActivityKanbanView({ activities }: ActivityKanbanViewProps) {
    const grouped = useMemo(() => {
        const map = new Map<ColumnKey, ActivityLogEntry[]>(COLUMNS.map((c) => [c.key, []]));
        for (const entry of activities) {
            const col = map.get(entry.status as ColumnKey);
            if (col) col.push(entry);
        }
        return map;
    }, [activities]);

    return (
        <div className="w-full overflow-x-auto pb-2">
            <div className="flex gap-3 min-w-[900px]">
                {COLUMNS.map((col) => (
                    <ActivityColumn key={col.key} col={col} entries={grouped.get(col.key)!} />
                ))}
            </div>
        </div>
    );
}
