import { ListChecks, Plus } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { Task } from '@/lib/api/tasks';
import { TasksList } from './TasksList';

/**
 * Tasks feature — Phase 14.3-14.5.
 *
 * Embeds the global TasksList into a per-scope tab (Work / Mission /
 * Idea). Server callers pre-filter the Tasks by scope before
 * passing them; this component owns the section chrome + "New Task"
 * CTA (the New Task page is the same /tasks/new — the scope arg is
 * pre-filled via query param hint, wired in a follow-up sub-tick).
 */
export function TasksScopedSection({
    tasks,
    scopeLabel,
    scopeId,
}: {
    tasks: Task[];
    scopeLabel: 'Work' | 'Mission' | 'Idea';
    scopeId: string;
}) {
    const doneCount = tasks.filter((t) => t.status === 'done').length;
    const openCount = tasks.filter((t) => !['done', 'cancelled'].includes(t.status)).length;
    const progressPct = tasks.length > 0 ? Math.round((doneCount / tasks.length) * 100) : 0;
    const scopeParam =
        scopeLabel === 'Work' ? 'workId' : scopeLabel === 'Mission' ? 'missionId' : 'ideaId';
    const newTaskHref = `${ROUTES.DASHBOARD_TASK_NEW}?${scopeParam}=${encodeURIComponent(scopeId)}`;

    return (
        <div className="space-y-5">
            {/* ── Section header ───────────────────────────────────────────── */}
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-info/10 border border-info/20 flex items-center justify-center">
                        <ListChecks className="w-4 h-4 text-info" />
                    </div>
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <h2 className="text-base font-semibold text-text dark:text-text-dark">
                                Tasks
                            </h2>
                            {tasks.length > 0 && (
                                <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border border-border dark:border-border-dark text-text-muted dark:text-text-muted-dark bg-surface-secondary dark:bg-surface-secondary-dark">
                                    <span className="text-success font-semibold">{doneCount}</span>
                                    <span>/</span>
                                    <span>{tasks.length}</span>
                                    <span>done</span>
                                </span>
                            )}
                        </div>
                        <p className="text-xs text-text-secondary dark:text-text-secondary-dark mt-0.5">
                            {openCount > 0
                                ? `${openCount} open task${openCount !== 1 ? 's' : ''} · ${scopeLabel}-scoped`
                                : tasks.length === 0
                                  ? `No tasks yet · ${scopeLabel}-scoped`
                                  : `All tasks complete · ${scopeLabel}-scoped`}
                        </p>
                    </div>
                </div>

                <Link
                    href={newTaskHref}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border dark:border-border-dark text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors whitespace-nowrap shrink-0"
                >
                    <Plus className="w-3.5 h-3.5" />
                    New Task
                </Link>
            </div>

            {/* ── Progress bar ─────────────────────────────────────────────── */}
            {tasks.length > 0 && (
                <div className="flex items-center gap-3 mt-6">
                    <div className="flex-1 h-0.5 bg-surface-secondary dark:bg-surface-secondary-dark rounded-full overflow-hidden">
                        <div
                            className="h-full bg-success rounded-full transition-all duration-500"
                            style={{ width: `${progressPct}%` }}
                        />
                    </div>
                    <span className="text-[11px] font-medium tabular-nums text-text-muted dark:text-text-muted-dark shrink-0">
                        {progressPct}%
                    </span>
                </div>
            )}

            {/* ── Divider ──────────────────────────────────────────────────── */}
            <div className="border-t border-border/60 dark:border-border-dark/60" />

            {/* ── Tasks list ───────────────────────────────────────────────── */}
            <TasksList tasks={tasks} />
        </div>
    );
}
