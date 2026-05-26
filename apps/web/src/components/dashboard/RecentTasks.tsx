import { ListChecks } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
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
 * Agents/Skills/Tasks PR #1017 — Phase 18.2. Dashboard "Recent
 * Tasks" block. Server-fetches the user's 5 most-recent in-flight
 * Tasks (ordered by `updatedAt DESC`) and renders a compact list
 * with the same priority/status chip vocabulary used in /tasks.
 * Designed to sit directly below "Recent Works" per spec §18.2.
 */
export function RecentTasks({ tasks }: { tasks: Task[] }) {
    if (tasks.length === 0) {
        return (
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
                <div className="flex items-center justify-between mb-3">
                    <h2 className="text-sm font-medium text-text dark:text-text-dark flex items-center gap-2">
                        <ListChecks className="w-4 h-4 text-info" />
                        Recent Tasks
                    </h2>
                    <Link
                        href={ROUTES.DASHBOARD_TASKS}
                        className="text-xs text-text-muted hover:text-primary"
                    >
                        View all →
                    </Link>
                </div>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    No Tasks yet. Create one to start tracking work.
                </p>
            </section>
        );
    }
    return (
        <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
            <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-medium text-text dark:text-text-dark flex items-center gap-2">
                    <ListChecks className="w-4 h-4 text-info" />
                    Recent Tasks
                </h2>
                <Link
                    href={ROUTES.DASHBOARD_TASKS}
                    className="text-xs text-text-muted hover:text-primary"
                >
                    View all →
                </Link>
            </div>
            <ul className="divide-y divide-border/40 dark:divide-border-dark/40">
                {tasks.map((t) => (
                    <li key={t.id} className="py-2 first:pt-0 last:pb-0">
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
        </section>
    );
}
