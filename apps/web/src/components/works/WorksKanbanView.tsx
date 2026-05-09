'use client';

import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils/cn';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { useTranslations } from 'next-intl';
import type { Work } from '@/lib/api/work';
import { GenerateStatusType, WorkScheduleStatus } from '@/lib/api/enums';
import {
    CircleDashed,
    Clock,
    Loader2,
    CheckCircle2,
    XCircle,
    AlertTriangle,
    ChevronDown,
    type LucideIcon,
} from 'lucide-react';
import { ShowDateTime } from '@/components/ui/show-datetime';

const MAX_VISIBLE = 15;

// ─── Column definitions ────────────────────────────────────────────────────

type ColumnKey = 'not_started' | 'scheduled' | 'generating' | 'completed' | 'failed';

interface ColumnDef {
    key: ColumnKey;
    icon: LucideIcon;
    dotClass: string;
    headerClass: string;
    countClass: string;
    cardBorderClass: string;
    iconColorClass: string;
}

const COLUMNS: ColumnDef[] = [
    {
        key: 'not_started',
        icon: CircleDashed,
        dotClass: 'bg-slate-400 dark:bg-slate-500',
        headerClass: 'bg-slate-50 dark:bg-slate-900/30 border-slate-200 dark:border-slate-700/40',
        countClass: 'bg-slate-100 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400',
        cardBorderClass:
            'border-slate-200 dark:border-white/8 hover:border-slate-300 dark:hover:border-white/14',
        iconColorClass: 'text-slate-400 dark:text-slate-500',
    },
    {
        key: 'scheduled',
        icon: Clock,
        dotClass: 'bg-blue-400 dark:bg-blue-400',
        headerClass: 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800/40',
        countClass: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
        cardBorderClass:
            'border-blue-200/60 dark:border-blue-800/30 hover:border-blue-300 dark:hover:border-blue-700/50',
        iconColorClass: 'text-blue-500 dark:text-blue-400',
    },
    {
        key: 'generating',
        icon: Loader2,
        dotClass: 'bg-primary animate-pulse',
        headerClass: 'bg-gray-50 dark:bg-white/[0.02] border-gray-200 dark:border-white/10',
        countClass: 'bg-gray-100 dark:bg-white/8 text-gray-700 dark:text-white/70',
        cardBorderClass:
            'border-primary/20 dark:border-white/10 hover:border-primary/40 dark:hover:border-white/20',
        iconColorClass: 'text-gray-500 dark:text-white/60',
    },
    {
        key: 'completed',
        icon: CheckCircle2,
        dotClass: 'bg-emerald-500 dark:bg-emerald-400',
        headerClass:
            'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800/40',
        countClass: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
        cardBorderClass:
            'border-emerald-200/60 dark:border-emerald-800/30 hover:border-emerald-300 dark:hover:border-emerald-700/50',
        iconColorClass: 'text-emerald-500 dark:text-emerald-400',
    },
    {
        key: 'failed',
        icon: XCircle,
        dotClass: 'bg-red-500 dark:bg-red-400',
        headerClass: 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800/40',
        countClass: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
        cardBorderClass:
            'border-red-200/60 dark:border-red-800/30 hover:border-red-300 dark:hover:border-red-700/50',
        iconColorClass: 'text-red-500 dark:text-red-400',
    },
];

// ─── Work → column assignment ──────────────────────────────────────────────

function getWorkColumn(work: Work): ColumnKey {
    const status = work.generateStatus?.status;

    if (status === GenerateStatusType.GENERATING) return 'generating';
    if (status === GenerateStatusType.GENERATED) return 'completed';
    if (status === GenerateStatusType.ERROR) return 'failed';
    if (status === GenerateStatusType.CANCELLED) return 'failed';
    if (work.scheduledStatus === WorkScheduleStatus.ACTIVE) return 'scheduled';
    return 'not_started';
}

// ─── Date formatter ────────────────────────────────────────────────────────

const formatDate = (date: string, locale: string) =>
    new Date(date).toLocaleDateString(locale, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    });

// ─── Kanban card ───────────────────────────────────────────────────────────

interface KanbanCardProps {
    work: Work;
    col: ColumnDef;
}

function KanbanCard({ work, col }: KanbanCardProps) {
    const t = useTranslations('dashboard.works.kanban');
    const status = work.generateStatus?.status;
    const isGenerating = status === GenerateStatusType.GENERATING;
    const hasWarnings = !!work.generateStatus?.warnings?.length;

    return (
        <Link
            href={ROUTES.DASHBOARD_WORK(work.id)}
            className={cn(
                'group flex flex-col gap-2.5 p-3.5 rounded-lg border',
                'bg-card dark:bg-card-primary-dark/70',
                'transition-all duration-150',
                col.cardBorderClass,
                isGenerating &&
                    'before:absolute before:inset-0 before:rounded-lg before:border before:border-primary/40 before:animate-pulse before:pointer-events-none relative overflow-hidden',
            )}
        >
            {/* Header row */}
            <div className="flex items-start gap-2.5">
                <div className="flex-1 min-w-0">
                    <h4 className="text-xs font-semibold text-text dark:text-text-dark leading-snug line-clamp-2">
                        {work.name}
                    </h4>
                    {work.slug && (
                        <p className="text-[10px] text-text-muted dark:text-text-muted-dark mt-0.5 truncate">
                            {work.owner ? `${work.owner}/` : ''}
                            {work.slug}
                        </p>
                    )}
                </div>
                <span className="shrink-0 text-[10px] font-medium text-text-muted dark:text-text-muted-dark bg-surface dark:bg-white/5 px-1.5 py-0.5 rounded-full">
                    {t('items', { count: work.itemsCount || 0 })}
                </span>
            </div>

            {/* Description */}
            {work.description ? (
                <p className="text-[11px] leading-4.5 text-text-secondary dark:text-text-secondary-dark line-clamp-2">
                    {work.description}
                </p>
            ) : (
                <p className="text-[11px] text-text-muted dark:text-text-muted-dark italic">
                    {t('noDescription')}
                </p>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between pt-2 border-t border-border dark:border-border-dark mt-auto">
                <StatusBadge work={work} col={col} />
                {work.updatedAt && (
                    <span className="text-[10px] text-text-muted dark:text-text-muted-dark shrink-0 ml-2">
                        <ShowDateTime value={work.updatedAt} customFormatter={formatDate} />
                    </span>
                )}
            </div>

            {/* Generating progress bar */}
            {isGenerating && work.generateStatus?.progress != null && (
                <div className="h-0.5 w-full bg-gray-100 dark:bg-white/8 rounded-full overflow-hidden -mt-1">
                    <div
                        className="h-full bg-primary transition-all duration-500 rounded-full"
                        style={{ width: `${work.generateStatus.progress}%` }}
                    />
                </div>
            )}
        </Link>
    );
}

// ─── Status badge ──────────────────────────────────────────────────────────

interface StatusBadgeProps {
    work: Work;
    col: ColumnDef;
}

function StatusBadge({ work, col }: StatusBadgeProps) {
    const t = useTranslations('dashboard.works.kanban.status');
    const status = work.generateStatus?.status;
    const isGenerating = status === GenerateStatusType.GENERATING;
    const hasWarnings = !!work.generateStatus?.warnings?.length;
    const Icon = col.icon;

    const label = (() => {
        if (isGenerating) return work.generateStatus?.stepName ?? t('generating');
        if (status === GenerateStatusType.GENERATED)
            return hasWarnings ? t('completedWithWarnings') : t('completed');
        if (status === GenerateStatusType.ERROR) return t('failed');
        if (status === GenerateStatusType.CANCELLED) return t('cancelled');
        if (work.scheduledStatus === WorkScheduleStatus.ACTIVE) return t('scheduled');
        return t('notStarted');
    })();

    return (
        <span
            className={cn(
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium truncate max-w-[140px]',
                isGenerating
                    ? 'bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-white/80 animate-pulse'
                    : status === GenerateStatusType.GENERATED
                      ? hasWarnings
                          ? 'bg-amber-100/70 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                          : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
                      : status === GenerateStatusType.ERROR
                        ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                        : status === GenerateStatusType.CANCELLED
                          ? 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300'
                          : work.scheduledStatus === WorkScheduleStatus.ACTIVE
                            ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                            : 'bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-400',
            )}
        >
            <Icon className={cn('w-2.5 h-2.5 shrink-0', isGenerating && 'animate-spin')} />
            <span className="truncate">{label}</span>
            {status === GenerateStatusType.GENERATED && hasWarnings && (
                <AlertTriangle className="w-2.5 h-2.5 shrink-0 text-amber-600 dark:text-amber-400" />
            )}
        </span>
    );
}

// ─── Column ────────────────────────────────────────────────────────────────

interface KanbanColumnProps {
    col: ColumnDef;
    works: Work[];
}

function KanbanColumn({ col, works }: KanbanColumnProps) {
    const [visibleCount, setVisibleCount] = useState(MAX_VISIBLE);
    const t = useTranslations('dashboard.works.kanban');
    const tCols = useTranslations('dashboard.works.kanban.columns');
    const Icon = col.icon;

    const visibleWorks = works.slice(0, visibleCount);
    const remaining = works.length - visibleCount;
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
                    {works.length}
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
                {works.length === 0 ? (
                    <div className="flex-1 flex items-center justify-center py-6">
                        <p className="text-[11px] text-text-muted dark:text-text-muted-dark text-center">
                            {t('empty')}
                        </p>
                    </div>
                ) : (
                    visibleWorks.map((work) => <KanbanCard key={work.id} work={work} col={col} />)
                )}
            </div>

            {/* Load more button */}
            {hasMore && (
                <button
                    onClick={() => setVisibleCount((v) => v + MAX_VISIBLE)}
                    className={cn(
                        'flex items-center justify-center gap-1.5 w-full px-3 py-2 rounded-b-lg border border-t-0',
                        'border-slate-200/60 dark:border-white/8',
                        'bg-slate-50 dark:bg-white/[0.02]',
                        'text-[11px] font-medium text-text-muted dark:text-text-muted-dark',
                        'hover:bg-slate-100 dark:hover:bg-white/[0.04] hover:text-text-secondary dark:hover:text-text-secondary-dark',
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

interface WorksKanbanViewProps {
    works: Work[];
}

export function WorksKanbanView({ works }: WorksKanbanViewProps) {
    const grouped = useMemo(() => {
        const map = new Map<ColumnKey, Work[]>(COLUMNS.map((c) => [c.key, []]));
        for (const work of works) {
            map.get(getWorkColumn(work))!.push(work);
        }
        return map;
    }, [works]);

    return (
        <div className="w-full overflow-x-auto pb-2">
            <div className="flex gap-3 min-w-[900px]">
                {COLUMNS.map((col) => (
                    <KanbanColumn key={col.key} col={col} works={grouped.get(col.key)!} />
                ))}
            </div>
        </div>
    );
}
