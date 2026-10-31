'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import type { Task } from '@/lib/api/tasks';
import { listMissionTasksOnWorksAction } from '@/app/actions/dashboard/missions';

const sectionCard =
    'rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5';

/** FR-55 — 20 rows per page. */
export const MISSION_TASKS_PAGE_SIZE = 20;

type Load =
    | { kind: 'loading' }
    | { kind: 'unavailable' }
    | { kind: 'ready'; rows: Task[]; total: number };

/**
 * APW-08 T36 (FR-55) — **Tasks on attached Works**: the Tasks this Mission filed on its App
 * Works (the `mission-task` label), most recent activity first, 20 per page.
 */
export function MissionTasksOnWorksPanel({ missionId }: { missionId: string }) {
    const t = useTranslations('dashboard.missionDetail.output');
    const [offset, setOffset] = useState(0);
    const [load, setLoad] = useState<Load>({ kind: 'loading' });

    useEffect(() => {
        let cancelled = false;
        setLoad({ kind: 'loading' });
        listMissionTasksOnWorksAction(missionId, offset)
            .then((page) => {
                if (!cancelled) setLoad({ kind: 'ready', rows: page.rows, total: page.total });
            })
            .catch(() => {
                if (!cancelled) setLoad({ kind: 'unavailable' });
            });
        return () => {
            cancelled = true;
        };
    }, [missionId, offset]);

    const total = load.kind === 'ready' ? load.total : 0;
    const hasPrevious = offset > 0;
    const hasNext = offset + MISSION_TASKS_PAGE_SIZE < total;

    return (
        <section className={sectionCard} data-testid="mission-tasks-on-works">
            <h2 className="text-sm font-semibold text-text dark:text-text-dark mb-3">
                {t('tasksOnWorks')}
                {load.kind === 'ready' ? (
                    <span className="ms-2 text-xs font-normal text-text-muted dark:text-text-muted-dark">
                        {total}
                    </span>
                ) : null}
            </h2>
            {load.kind === 'loading' ? (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('loading')}</p>
            ) : load.kind === 'unavailable' ? (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('unavailable')}
                </p>
            ) : load.rows.length === 0 ? (
                <p
                    className="text-xs text-text-muted dark:text-text-muted-dark"
                    data-testid="mission-tasks-empty"
                >
                    {t('tasksOnWorksEmpty')}
                </p>
            ) : (
                <ul className="divide-y divide-border/40 dark:divide-border-dark/40">
                    {load.rows.map((task) => (
                        <li
                            key={task.id}
                            className="flex items-center justify-between gap-3 py-2 text-xs"
                            data-testid="mission-task-row"
                        >
                            <Link
                                href={`/tasks/${task.id}`}
                                className="truncate font-medium text-text hover:text-primary hover:underline dark:text-text-dark"
                            >
                                {task.title}
                            </Link>
                            <span className="shrink-0 text-text-muted dark:text-text-muted-dark">
                                {task.status}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            {hasPrevious || hasNext ? (
                <div className="mt-3 flex items-center justify-between gap-2">
                    <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={!hasPrevious}
                        onClick={() => setOffset(Math.max(0, offset - MISSION_TASKS_PAGE_SIZE))}
                        data-testid="mission-tasks-previous"
                    >
                        {t('previous')}
                    </Button>
                    <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={!hasNext}
                        onClick={() => setOffset(offset + MISSION_TASKS_PAGE_SIZE)}
                        data-testid="mission-tasks-next"
                    >
                        {t('next')}
                    </Button>
                </div>
            ) : null}
        </section>
    );
}
