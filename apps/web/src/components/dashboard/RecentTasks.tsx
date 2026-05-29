'use client';

import { useEffect, useState } from 'react';
import { LayoutGrid, List, ListChecks, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import type { Task, TaskStatus, TaskPriority } from '@/lib/api/tasks';

const STATUS_TONES: Record<TaskStatus, string> = {
    backlog: 'bg-surface-secondary text-text-secondary',
    todo: 'bg-info/10 text-info',
    in_progress: 'bg-warning/10 text-warning',
    in_review: 'bg-warning/10 text-warning',
    blocked: 'bg-danger/10 text-danger',
    done: 'bg-success/10 text-success',
    cancelled: 'bg-text-muted/10 text-text-muted',
};

const PRIORITY_TONES: Record<TaskPriority, string> = {
    p0: 'bg-danger/20 text-danger',
    p1: 'bg-danger/10 text-danger',
    p2: 'bg-warning/10 text-warning',
    p3: 'bg-surface-secondary text-text-secondary',
    p4: 'bg-text-muted/10 text-text-muted',
};

const PILL_BASE =
    'text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded-md whitespace-nowrap';

type ViewMode = 'list' | 'cards';
// Persist between visits so a user who prefers cards doesn't have to retoggle.
const VIEW_STORAGE_KEY = 'dashboard.recentTasks.view';

export function RecentTasks({ tasks, total }: { tasks: Task[]; total?: number }) {
    const t = useTranslations('dashboard.recentTasks');
    const totalCount = total ?? tasks.length;

    // Default to list on first paint to avoid SSR/CSR mismatch; hydrate preference
    // from localStorage after mount.
    const [view, setView] = useState<ViewMode>('list');
    useEffect(() => {
        try {
            const saved = window.localStorage.getItem(VIEW_STORAGE_KEY);
            if (saved === 'list' || saved === 'cards') setView(saved);
        } catch {
            // localStorage unavailable (private mode, SSR snapshot, etc.) — fall back to default.
        }
    }, []);

    const handleViewChange = (next: ViewMode) => {
        setView(next);
        try {
            window.localStorage.setItem(VIEW_STORAGE_KEY, next);
        } catch {
            // ignore storage failure
        }
    };

    return (
        <section aria-labelledby="recent-tasks-heading">
            <div className="flex flex-nowrap items-center justify-between gap-3 mb-4">
                <div className="flex items-center gap-2 min-w-0">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-surface-secondary dark:bg-white/6 border border-border/50 dark:border-white/10 flex items-center justify-center">
                        <ListChecks className="w-4 h-4 text-text-secondary dark:text-text-secondary-dark" />
                    </div>
                    <h2
                        id="recent-tasks-heading"
                        className="text-xl font-semibold text-text dark:text-text-dark truncate"
                    >
                        {t('title')}
                    </h2>
                </div>
                <div className="flex flex-nowrap items-center gap-2 shrink-0">
                    {tasks.length > 0 && (
                        <ViewToggle view={view} onChange={handleViewChange} t={t} />
                    )}
                    <Link
                        href={ROUTES.DASHBOARD_TASK_NEW}
                        className={cn(
                            'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap',
                            'border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark',
                            'text-text-secondary dark:text-text-secondary-dark',
                            'hover:border-primary/40 hover:text-primary',
                        )}
                    >
                        <Plus className="w-3.5 h-3.5" />
                        {t('add')}
                    </Link>
                    {totalCount > 0 && (
                        <Link
                            href={ROUTES.DASHBOARD_TASKS}
                            className="text-xs font-medium text-primary hover:underline inline-flex items-center gap-1 whitespace-nowrap"
                        >
                            {t('viewAll', { n: totalCount })}
                        </Link>
                    )}
                </div>
            </div>

            {tasks.length === 0 ? (
                <div className="rounded-lg p-5 bg-card dark:bg-card-primary-dark/70 border border-card-border dark:border-white/9 text-sm text-text-secondary dark:text-text-secondary-dark">
                    <p>{t('empty.title')}</p>
                    <p className="mt-1 text-xs">{t('empty.subtitle')}</p>
                </div>
            ) : view === 'cards' ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {tasks.map((task) => (
                        <TaskCard key={task.id} task={task} />
                    ))}
                </div>
            ) : (
                <ul className="rounded-xl overflow-hidden border border-card-border dark:border-white/8 divide-y divide-border/40 dark:divide-white/6">
                    {tasks.map((task) => (
                        <li
                            key={task.id}
                            className="bg-card dark:bg-card-primary-dark/60 first:rounded-t-xl last:rounded-b-xl"
                        >
                            <Link
                                href={ROUTES.DASHBOARD_TASK(task.id)}
                                className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-card-hover dark:hover:bg-white/3 transition-colors no-underline"
                            >
                                <div className="min-w-0 flex-1 flex items-center gap-2.5">
                                    <span className="text-[10px] font-mono text-text-muted dark:text-text-muted-dark shrink-0">
                                        {task.slug}
                                    </span>
                                    <span className="text-xs text-text dark:text-text-dark truncate">
                                        {task.title}
                                    </span>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                    <span className={cn(PILL_BASE, PRIORITY_TONES[task.priority])}>
                                        {task.priority}
                                    </span>
                                    <span className={cn(PILL_BASE, STATUS_TONES[task.status])}>
                                        {task.status.replace('_', ' ')}
                                    </span>
                                </div>
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

function ViewToggle({
    view,
    onChange,
    t,
}: {
    view: ViewMode;
    onChange: (next: ViewMode) => void;
    t: ReturnType<typeof useTranslations>;
}) {
    const buttonBase = 'p-1.5 transition-colors flex items-center justify-center';
    const active = 'bg-surface-secondary text-text dark:bg-white/8 dark:text-text-dark';
    const inactive =
        'text-text-secondary hover:text-text dark:text-text-secondary-dark dark:hover:text-text-dark';

    return (
        <div
            role="group"
            aria-label={t('view.label')}
            className="inline-flex rounded-md border border-border/60 dark:border-border-dark/60 overflow-hidden"
        >
            <button
                type="button"
                onClick={() => onChange('list')}
                aria-pressed={view === 'list'}
                aria-label={t('view.list')}
                className={cn(buttonBase, view === 'list' ? active : inactive)}
            >
                <List className="w-3.5 h-3.5" />
            </button>
            <button
                type="button"
                onClick={() => onChange('cards')}
                aria-pressed={view === 'cards'}
                aria-label={t('view.cards')}
                className={cn(buttonBase, view === 'cards' ? active : inactive)}
            >
                <LayoutGrid className="w-3.5 h-3.5" />
            </button>
        </div>
    );
}

function TaskCard({ task }: { task: Task }) {
    return (
        <Link
            href={ROUTES.DASHBOARD_TASK(task.id)}
            className={cn(
                'flex flex-col gap-2 rounded-lg p-3 no-underline transition-colors h-full',
                'bg-card dark:bg-card-primary-dark/60',
                'border border-card-border dark:border-white/8',
                'hover:border-primary/40 hover:bg-card-hover dark:hover:bg-white/3',
            )}
        >
            <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-mono text-text-muted dark:text-text-muted-dark truncate">
                    {task.slug}
                </span>
                <span className={cn(PILL_BASE, STATUS_TONES[task.status])}>
                    {task.status.replace('_', ' ')}
                </span>
            </div>
            <h3 className="text-sm font-medium text-text dark:text-text-dark line-clamp-2">
                {task.title}
            </h3>
            {task.description && (
                <p className="text-xs text-text-secondary dark:text-text-secondary-dark line-clamp-2">
                    {task.description}
                </p>
            )}
            <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                <span className={cn(PILL_BASE, PRIORITY_TONES[task.priority])}>
                    {task.priority}
                </span>
                {task.labels?.slice(0, 3).map((label) => (
                    <span
                        key={label}
                        className="text-[10px] px-1.5 py-0.5 rounded-md bg-surface-secondary text-text-secondary dark:bg-white/6 dark:text-text-secondary-dark truncate max-w-[8rem]"
                    >
                        {label}
                    </span>
                ))}
            </div>
        </Link>
    );
}
