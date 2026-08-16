'use client';

import { History } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { TaskActivityRow } from '@/lib/api/tasks';

/**
 * Tasks upgrades — the per-Task activity feed.
 *
 * Rows come from `GET /api/tasks/:id/activity`, which filters the
 * activity log to the rows the task-domain writers stamp with
 * `details.resourceType='task'` + `details.resourceId=<taskId>`. This
 * is the audit trail (created / updated / transitioned / scheduled /
 * instantiated-from-template), NOT the chat thread and NOT the run
 * history — the runs get their own section, linked from the header.
 *
 * Read-only and server-hydrated: no client fetch, no polling.
 */
export function TaskActivitySection({
    rows,
    total = rows.length,
    error = null,
}: {
    rows: TaskActivityRow[];
    total?: number;
    error?: string | null;
}) {
    const t = useTranslations('dashboard.tasksPage.activity');

    return (
        <section
            className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5"
            data-testid="task-activity-section"
        >
            <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-medium text-text dark:text-text-dark flex items-center gap-2">
                    <History className="w-4 h-4 text-text-muted" />
                    {t('section')}
                </h2>
                <Link
                    href={ROUTES.DASHBOARD_AGENT_SESSIONS}
                    className="text-[11px] text-text-muted hover:text-text dark:hover:text-text-dark"
                >
                    {t('viewRuns')}
                </Link>
            </div>

            {error && (
                <p className="text-xs text-danger mb-3" role="alert">
                    {error}
                </p>
            )}

            {rows.length === 0 ? (
                <p className="text-xs text-text-muted">{t('empty')}</p>
            ) : (
                <ul className="space-y-2" data-testid="task-activity-list">
                    {rows.map((row) => (
                        <li
                            key={row.id}
                            data-testid="task-activity-row"
                            className="flex items-start justify-between gap-3 border-b border-border/40 dark:border-border-dark/40 pb-2 last:border-b-0 last:pb-0"
                        >
                            <div className="min-w-0">
                                <p className="text-xs text-text dark:text-text-dark break-words">
                                    {row.summary}
                                </p>
                                <span className="text-[10px] font-mono uppercase tracking-wide text-text-muted">
                                    {row.actionType}
                                </span>
                            </div>
                            <time
                                className="shrink-0 text-[10px] text-text-muted"
                                dateTime={row.createdAt}
                            >
                                {new Date(row.createdAt).toLocaleString()}
                            </time>
                        </li>
                    ))}
                </ul>
            )}

            {total > rows.length && (
                <p className="mt-3 text-[10px] text-text-muted">
                    {t('truncated', { shown: rows.length, total })}
                </p>
            )}
        </section>
    );
}
