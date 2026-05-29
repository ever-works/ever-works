'use client';

import { ListChecks, Plus } from 'lucide-react';
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

export function RecentTasks({ tasks, total }: { tasks: Task[]; total?: number }) {
    const t = useTranslations('dashboard.recentTasks');
    const totalCount = total ?? tasks.length;

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
            ) : (
                <ul className="rounded-xl overflow-hidden border border-card-border dark:border-white/8 divide-y divide-border/40 dark:divide-white/6">
                    {tasks.map((task) => (
                        <li key={task.id} className="bg-card dark:bg-card-primary-dark/60 first:rounded-t-xl last:rounded-b-xl">
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
                                    <span
                                        className={cn(
                                            'text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded-md',
                                            PRIORITY_TONES[task.priority],
                                        )}
                                    >
                                        {task.priority}
                                    </span>
                                    <span
                                        className={cn(
                                            'text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded-md',
                                            STATUS_TONES[task.status],
                                        )}
                                    >
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
