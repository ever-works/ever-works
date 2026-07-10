'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import type { Task, TaskStatus, TaskPriority } from '@/lib/api/tasks';
import { TasksKanbanView } from './TasksKanbanView';
import { LayoutGrid, Table2, Kanban } from 'lucide-react';

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

const STATUS_DOT: Record<TaskStatus, string> = {
    backlog: 'bg-slate-400',
    todo: 'bg-info',
    in_progress: 'bg-warning',
    in_review: 'bg-violet-500',
    blocked: 'bg-danger',
    done: 'bg-success',
    cancelled: 'bg-text-muted',
};

const VIEW_TABS = [
    { key: 'cards', icon: LayoutGrid, label: 'Cards' },
    { key: 'table', icon: Table2, label: 'Table' },
    { key: 'kanban', icon: Kanban, label: 'Kanban' },
] as const;

type ViewKey = (typeof VIEW_TABS)[number]['key'];

const STATUS_FILTERS: { key: TaskStatus | 'all'; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'backlog', label: 'Backlog' },
    { key: 'todo', label: 'Todo' },
    { key: 'in_progress', label: 'In progress' },
    { key: 'in_review', label: 'In review' },
    { key: 'blocked', label: 'Blocked' },
    { key: 'done', label: 'Done' },
    { key: 'cancelled', label: 'Cancelled' },
];

export function TasksList({
    tasks,
    enableStatusFilter = true,
}: {
    tasks: Task[];
    enableStatusFilter?: boolean;
}) {
    const t = useTranslations('dashboard.tasksPage');
    const [view, setView] = useState<ViewKey>('cards');
    const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('all');

    const filtered = useMemo(
        () =>
            !enableStatusFilter || statusFilter === 'all'
                ? tasks
                : tasks.filter((t) => t.status === statusFilter),
        [enableStatusFilter, tasks, statusFilter],
    );

    return (
        <div className="space-y-4">
            {/* ── Toolbar ─────────────────────────────────────────────────── */}
            <div className="flex flex-col gap-3 @sm/main:flex-row @sm/main:items-center @sm/main:justify-between">
                {/* View mode segmented control */}
                <div className="flex items-center gap-0.5 rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-0.5 self-start">
                    {VIEW_TABS.map(({ key, icon: Icon, label }) => (
                        <button
                            key={key}
                            type="button"
                            onClick={() => setView(key)}
                            aria-pressed={view === key}
                            title={label}
                            className={cn(
                                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all duration-150',
                                view === key
                                    ? 'bg-card dark:bg-card-primary-dark text-text dark:text-text-dark shadow-sm'
                                    : 'text-text-muted dark:text-text-muted-dark hover:text-text-secondary dark:hover:text-text-secondary-dark',
                            )}
                        >
                            <Icon className="w-3.5 h-3.5 shrink-0" />
                            <span className="hidden @xs/main:inline">{label}</span>
                        </button>
                    ))}
                </div>

                {/* Count badge — kanban shows all tasks across columns, so
                    only the list-level filter ratio is meaningful in
                    cards/table. */}
                <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium border border-border dark:border-border-dark text-text-muted dark:text-text-muted-dark bg-card dark:bg-card-primary-dark self-start @sm/main:self-auto">
                    {view === 'kanban' || !enableStatusFilter
                        ? tasks.length
                        : `${filtered.length} / ${tasks.length}`}
                </span>
            </div>

            {/* ── Status filter pills ──────────────────────────────────────── */}
            {/* Hidden in kanban view — the columns already group by status, so
                the pills would just empty most columns when one is selected. */}
            {view !== 'kanban' && enableStatusFilter && (
                <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
                    {STATUS_FILTERS.map(({ key, label }) => {
                        const isActive = statusFilter === key;
                        return (
                            <button
                                key={key}
                                type="button"
                                onClick={() => setStatusFilter(key)}
                                className={cn(
                                    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border whitespace-nowrap transition-colors shrink-0',
                                    isActive
                                        ? 'border-border dark:border-border-dark bg-white dark:bg-card-primary-dark text-text dark:text-text-dark shadow-sm'
                                        : 'border-border/60 dark:border-border-dark/60 text-text-muted dark:text-text-muted-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark hover:text-text dark:hover:text-text-dark',
                                )}
                            >
                                {key !== 'all' && (
                                    <span
                                        className={cn(
                                            'w-1.5 h-1.5 rounded-full shrink-0',
                                            STATUS_DOT[key as TaskStatus],
                                        )}
                                    />
                                )}
                                {label}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* ── Content ─────────────────────────────────────────────────── */}
            {view === 'kanban' ? (
                // Kanban always gets the full set — its own columns are the
                // status filter. The list-level `statusFilter` only governs
                // cards/table.
                <TasksKanbanView tasks={tasks} />
            ) : filtered.length === 0 ? (
                <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-8 text-center">
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {statusFilter === 'all'
                            ? t('empty.title')
                            : `${t('empty.title')} (${statusFilter.replace('_', ' ')})`}
                    </p>
                </div>
            ) : view === 'cards' ? (
                <div className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4">
                    {filtered.map((t) => (
                        <TaskCard key={t.id} task={t} />
                    ))}
                </div>
            ) : (
                <TaskTable tasks={filtered} />
            )}
        </div>
    );
}

function TaskCard({ task }: { task: Task }) {
    const t = useTranslations('dashboard.tasksPage');
    return (
        <Link
            href={ROUTES.DASHBOARD_TASK(task.id)}
            className="block rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 hover:border-border transition-colors"
        >
            <div className="flex items-center justify-between gap-2 text-[11px] font-mono text-text-muted">
                <span>{task.slug}</span>
                <span
                    className={`uppercase tracking-wide px-1.5 py-0.5 rounded ${PRIORITY_TONES[task.priority]}`}
                >
                    {task.priority}
                </span>
            </div>
            <h3 className="text-sm font-semibold text-text dark:text-text-dark mt-2 truncate">
                {task.title}
            </h3>
            {task.description ? (
                <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1 line-clamp-2">
                    {task.description}
                </p>
            ) : (
                <p className="text-xs text-text-muted/70 dark:text-text-muted-dark/70 mt-1 italic">
                    {t('list.noDescription')}
                </p>
            )}
            <div className="flex items-center gap-2 mt-3 flex-wrap">
                <span
                    className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${STATUS_TONES[task.status]}`}
                >
                    {task.status.replace('_', ' ')}
                </span>
                {(task.labels ?? []).slice(0, 3).map((label) => (
                    <span
                        key={label}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary"
                    >
                        {label}
                    </span>
                ))}
            </div>
        </Link>
    );
}

function TaskTable({ tasks }: { tasks: Task[] }) {
    return (
        <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark overflow-hidden">
            <table className="w-full text-sm">
                <thead className="bg-surface-secondary/50 dark:bg-surface-secondary-dark/50 text-xs text-text-secondary">
                    <tr>
                        <th className="text-left px-4 py-2.5 font-medium">Slug</th>
                        <th className="text-left px-4 py-2.5 font-medium">Title</th>
                        <th className="text-left px-4 py-2.5 font-medium">Status</th>
                        <th className="text-left px-4 py-2.5 font-medium">Priority</th>
                        <th className="text-left px-4 py-2.5 font-medium">Updated</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border/60 dark:divide-border-dark/60">
                    {tasks.map((t) => (
                        <tr
                            key={t.id}
                            className="hover:bg-surface-secondary/30 dark:hover:bg-surface-secondary-dark/20 transition-colors"
                        >
                            <td className="px-4 py-2.5 font-mono text-xs text-text-muted">
                                {t.slug}
                            </td>
                            <td className="px-4 py-2.5">
                                <Link
                                    href={ROUTES.DASHBOARD_TASK(t.id)}
                                    className="text-text dark:text-text-dark hover:text-primary transition-colors"
                                >
                                    {t.title}
                                </Link>
                            </td>
                            <td className="px-4 py-2.5">
                                <span
                                    className={cn(
                                        'inline-flex items-center gap-1 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded',
                                        STATUS_TONES[t.status],
                                    )}
                                >
                                    <span
                                        className={cn(
                                            'w-1.5 h-1.5 rounded-full shrink-0',
                                            STATUS_DOT[t.status],
                                        )}
                                    />
                                    {t.status.replace('_', ' ')}
                                </span>
                            </td>
                            <td className="px-4 py-2.5">
                                <span
                                    className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${PRIORITY_TONES[t.priority]}`}
                                >
                                    {t.priority}
                                </span>
                            </td>
                            <td className="px-4 py-2.5 text-xs text-text-muted">
                                {new Date(t.updatedAt).toLocaleDateString()}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
