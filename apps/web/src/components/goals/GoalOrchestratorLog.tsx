'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { GoalEvent } from '@/lib/api/goals';
import { formatDateTime } from './goal-ui';
import { EventKindBadge } from './goal-loop-ui';

/**
 * Autonomy layer — the Orchestrator tab.
 *
 * Renders `goal_events` verbatim, newest first. The lines are written by
 * the routing rule itself ("Routed iteration 4 → research-agent: the Goal
 * pins no agent, so the router round-robins over 2 agents…"), which is
 * the whole point: an operator has to be able to audit WHY a decision was
 * made, and a UI that paraphrased the reasoning would be a second source
 * of truth about it.
 */
export function GoalOrchestratorLog({ events }: { events: GoalEvent[] }) {
    const t = useTranslations('dashboard.goalDetail.orchestrator');

    if (events.length === 0) {
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
        <ol className="space-y-2">
            {events.map((event) => (
                <li
                    key={event.id}
                    className="rounded-lg border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-3"
                >
                    <div className="flex flex-wrap items-center gap-2">
                        <EventKindBadge kind={event.kind} />
                        {event.iteration > 0 ? (
                            <span className="text-[11px] text-text-muted dark:text-text-muted-dark">
                                {t('iteration', { n: event.iteration })}
                            </span>
                        ) : null}
                        <time
                            className="ml-auto text-[11px] text-text-muted dark:text-text-muted-dark"
                            dateTime={event.createdAt}
                            suppressHydrationWarning
                        >
                            {formatDateTime(event.createdAt)}
                        </time>
                    </div>
                    <p className="mt-1.5 text-sm text-text dark:text-text-dark">{event.message}</p>
                    {event.taskId ? (
                        <Link
                            href={`/tasks/${event.taskId}`}
                            className="mt-1 inline-block text-[11px] text-info hover:underline"
                        >
                            {t('openTask')}
                        </Link>
                    ) : null}
                </li>
            ))}
        </ol>
    );
}
