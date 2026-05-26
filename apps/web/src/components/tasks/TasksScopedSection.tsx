import { ListChecks, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
}: {
    tasks: Task[];
    scopeLabel: 'Work' | 'Mission' | 'Idea';
}) {
    return (
        <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-info/10 border border-info/20 flex items-center justify-center">
                        <ListChecks className="w-4 h-4 text-info" />
                    </div>
                    <div>
                        <h2 className="text-lg font-semibold text-text dark:text-text-dark">
                            Tasks
                        </h2>
                        <p className="text-xs text-text-secondary dark:text-text-secondary-dark mt-0.5">
                            Tasks scoped to this {scopeLabel}.
                        </p>
                    </div>
                </div>
                <Button asChild size="sm" className="gap-1.5">
                    <Link href={ROUTES.DASHBOARD_TASK_NEW}>
                        <Plus className="w-3.5 h-3.5" />
                        New Task
                    </Link>
                </Button>
            </div>
            <TasksList tasks={tasks} />
        </div>
    );
}
