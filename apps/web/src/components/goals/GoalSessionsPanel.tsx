'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { GoalSession } from '@/lib/api/goals';
import { formatDateTime } from './goal-ui';
import { formatCents, formatDuration } from './goal-loop-ui';

/**
 * Autonomy layer — the Sessions tab.
 *
 * One row per iteration Task with its latest agent run. Tasks with NO run
 * are listed too (dash in every run column): hiding them would make a
 * loop that failed to dispatch look idle rather than broken, which is the
 * single most misleading thing this surface could do.
 */
/**
 * Run statuses we have translations for. `runStatus` arrives as a plain
 * string from the run row, and next-intl's typed keys reject an arbitrary
 * template literal — so unknown statuses render raw instead of failing
 * the build (or, worse, throwing at render time on a missing key).
 */
const RUN_STATUS_KEYS = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
type KnownRunStatus = (typeof RUN_STATUS_KEYS)[number];

function isKnownRunStatus(status: string): status is KnownRunStatus {
    return (RUN_STATUS_KEYS as readonly string[]).includes(status);
}

export function GoalSessionsPanel({ sessions }: { sessions: GoalSession[] }) {
    const t = useTranslations('dashboard.goalDetail.sessions');
    const runStatusLabel = (status: string | null) => {
        if (!status) return '—';
        if (!isKnownRunStatus(status)) return status;
        return t(`runStatuses.${status}` as const);
    };

    if (sessions.length === 0) {
        return (
            <div className="rounded-lg border border-dashed border-border/70 dark:border-border-dark/70 p-8 text-center">
                <p className="text-sm font-medium text-text dark:text-text-dark">{t('empty')}</p>
                <p className="mx-auto mt-1 max-w-xl text-xs text-text-muted dark:text-text-muted-dark">
                    {t('emptyHint')}
                </p>
            </div>
        );
    }

    return (
        <div className="overflow-x-auto rounded-xl border border-border/60 dark:border-border-dark/60">
            <table className="w-full min-w-[720px] text-left text-xs">
                <thead className="bg-surface-secondary/60 dark:bg-surface-secondary-dark/40">
                    <tr className="text-text-muted dark:text-text-muted-dark">
                        <th className="px-3 py-2 font-medium">{t('columns.iteration')}</th>
                        <th className="px-3 py-2 font-medium">{t('columns.task')}</th>
                        <th className="px-3 py-2 font-medium">{t('columns.runStatus')}</th>
                        <th className="px-3 py-2 font-medium">{t('columns.started')}</th>
                        <th className="px-3 py-2 font-medium">{t('columns.duration')}</th>
                        <th className="px-3 py-2 font-medium">{t('columns.cost')}</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border/50 dark:divide-border-dark/50">
                    {sessions.map((session) => (
                        <tr key={session.taskId} className="text-text dark:text-text-dark">
                            <td className="px-3 py-2 tabular-nums">{session.iteration ?? '—'}</td>
                            <td className="px-3 py-2">
                                <Link
                                    href={`/tasks/${session.taskId}`}
                                    className="text-info hover:underline"
                                >
                                    {session.taskSlug}
                                </Link>
                                <span className="ml-2 text-text-muted dark:text-text-muted-dark">
                                    {session.taskTitle}
                                </span>
                            </td>
                            <td className="px-3 py-2">{runStatusLabel(session.runStatus)}</td>
                            <td className="px-3 py-2">
                                {session.startedAt ? (
                                    <time dateTime={session.startedAt} suppressHydrationWarning>
                                        {formatDateTime(session.startedAt)}
                                    </time>
                                ) : (
                                    '—'
                                )}
                            </td>
                            <td className="px-3 py-2 tabular-nums">
                                {formatDuration(session.durationMs)}
                            </td>
                            <td className="px-3 py-2 tabular-nums">
                                {formatCents(session.costCents)}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
