import { ListChecks, Plus } from 'lucide-react';
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

/**
 * Agents/Skills/Tasks PR #1017 — Phase 18.2. Dashboard "Tasks"
 * block. Server-fetches the user's 5 most-recent in-flight Tasks
 * (ordered by `updatedAt DESC`) and renders a compact list with
 * the same priority/status chip vocabulary used in /tasks.
 * Designed to sit directly below "Recent Works".
 *
 * Dashboard polish (2026-05-27) — header now matches Missions /
 * Ideas / Works sections: large icon tile, `text-xl` title,
 * `+ Add` button and `View all (N) →` link in a single non-wrapping
 * row on the right.
 */
export function RecentTasks({ tasks, total }: { tasks: Task[]; total?: number }) {
    const totalCount = total ?? tasks.length;
    return (
        <section className="mt-8" aria-labelledby="recent-tasks-heading">
            <div className="flex flex-nowrap items-center justify-between gap-3 mb-4">
                <div className="flex items-center gap-2 min-w-0">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-info/10 border border-info/20 flex items-center justify-center">
                        <ListChecks className="w-4 h-4 text-info" />
                    </div>
                    <h2
                        id="recent-tasks-heading"
                        className="text-xl font-semibold text-text dark:text-text-dark truncate"
                    >
                        Tasks
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
                        Add
                    </Link>
                    {totalCount > 0 && (
                        <Link
                            href={ROUTES.DASHBOARD_TASKS}
                            className="text-sm font-medium text-primary hover:underline inline-flex items-center gap-1 whitespace-nowrap"
                        >
                            View all ({totalCount}) →
                        </Link>
                    )}
                </div>
            </div>

            {tasks.length === 0 ? (
                <div className="rounded-lg p-5 bg-card dark:bg-card-primary-dark/70 border border-card-border dark:border-white/9 text-sm text-text-secondary dark:text-text-secondary-dark">
                    <p>No Tasks yet.</p>
                    <p className="mt-1 text-xs">Create one to start tracking work.</p>
                </div>
            ) : (
                <ul className="rounded-lg bg-card dark:bg-card-primary-dark/70 border border-card-border dark:border-white/9 divide-y divide-border/40 dark:divide-border-dark/40">
                    {tasks.map((t) => (
                        <li key={t.id} className="px-4 py-2.5">
                            <Link
                                href={ROUTES.DASHBOARD_TASK(t.id)}
                                className="flex items-center justify-between gap-3 hover:text-primary"
                            >
                                <div className="min-w-0 flex-1 flex items-center gap-2">
                                    <span className="text-[10px] font-mono text-text-muted shrink-0">
                                        {t.slug}
                                    </span>
                                    <span className="text-sm text-text dark:text-text-dark truncate">
                                        {t.title}
                                    </span>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    <span
                                        className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${PRIORITY_TONES[t.priority]}`}
                                    >
                                        {t.priority}
                                    </span>
                                    <span
                                        className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${STATUS_TONES[t.status]}`}
                                    >
                                        {t.status.replace('_', ' ')}
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
