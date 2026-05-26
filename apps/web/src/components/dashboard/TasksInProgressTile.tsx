import { ListChecks } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 18.1. Dashboard tile
 * showing the user's in-flight Task count + a tap-to-go shortcut.
 * "In-flight" = todo / in_progress / in_review / blocked. done +
 * cancelled + backlog excluded.
 */
export function TasksInProgressTile({
    inProgress,
    blocked,
}: {
    inProgress: number;
    blocked: number;
}) {
    return (
        <Link
            href={`${ROUTES.DASHBOARD_TASKS}`}
            className="group block rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 hover:border-info/40 transition-colors"
        >
            <div className="flex items-start gap-3">
                <div className="shrink-0 w-9 h-9 rounded-lg bg-info/10 border border-info/20 flex items-center justify-center">
                    <ListChecks className="w-4 h-4 text-info" />
                </div>
                <div className="min-w-0 flex-1">
                    <h3 className="text-xs text-text-secondary dark:text-text-secondary-dark uppercase tracking-wide">
                        Tasks in flight
                    </h3>
                    <p className="text-2xl font-semibold text-text dark:text-text-dark mt-1">
                        {inProgress}
                    </p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                        {blocked > 0 ? `${blocked} blocked` : 'no blockers'}
                    </p>
                </div>
            </div>
        </Link>
    );
}
