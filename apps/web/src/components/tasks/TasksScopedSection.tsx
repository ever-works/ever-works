import { ListChecks, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { Task } from '@/lib/api/tasks';
import type { TaskScopeKey } from '@/lib/api/tasks.shared';
import type { WorkRunsSummary } from '@/lib/api/types-only';
import { WorkRunsSummaryBadges } from '@/components/works/detail/WorkRunsSummaryBadges';
import { AddExistingTaskButton } from './AddExistingTaskButton';
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
    runsSummary = null,
}: {
    tasks: Task[];
    scopeLabel: 'Work' | 'Mission' | 'Idea';
    scopeId: string;
    /** Wave 4 M4 — per-Work AgentRun summary counts (Work scope only). */
    runsSummary?: WorkRunsSummary | null;
}) {
    // Shared with `AddExistingTaskButton` next to it in the header: the
    // two CTAs sit side by side, so they have to speak the same language.
    const t = useTranslations('dashboard.tasksPage.scopedSection');
    const doneCount = tasks.filter((task) => task.status === 'done').length;
    const openCount = tasks.filter((task) => !['done', 'cancelled'].includes(task.status)).length;
    const progressPct = tasks.length > 0 ? Math.round((doneCount / tasks.length) * 100) : 0;
    const scopeParam: TaskScopeKey =
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
                            {/* Wave 4 M4 — per-Work fleet summary chips. */}
                            {runsSummary && <WorkRunsSummaryBadges summary={runsSummary} />}
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

                {/* Two on-ramps, because "create another one" is the wrong
                    default for an operator who already has a backlog: most of
                    what a scope wants was raised elsewhere long before the
                    scope existed. "Add existing" opens a picker of it. */}
                <div className="flex items-center gap-2 shrink-0">
                    <AddExistingTaskButton scopeKey={scopeParam} scopeId={scopeId} />
                    <Link
                        href={newTaskHref}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-button-primary dark:bg-button-primary-dark text-button-primary-foreground dark:text-button-primary-foreground-dark hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark transition-colors whitespace-nowrap shrink-0"
                    >
                        <Plus className="w-3.5 h-3.5" />
                        {t('newTask')}
                    </Link>
                </div>
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
            {/* `scope` turns on the per-row detach — the inverse of the
                "Add existing" button above, and only meaningful here. */}
            <TasksList tasks={tasks} scope={{ key: scopeParam, id: scopeId }} />
        </div>
    );
}
