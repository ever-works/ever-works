'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Link, useRouter } from '@/i18n/navigation';
import { WorkSelect } from '@/components/tasks/WorkSelect';
import type { Goal } from '@/lib/api/goals';
import { updateGoalAction } from './actions';

const sectionCard =
    'rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5';

/**
 * APW-08 T33 (FR-45, S10) — the Goal page's **Work** section: the Work the loop files its
 * iterations on, as a link, and the control that changes it.
 *
 * The control is locked while the loop runs: the API answers `409 loopRunning` to any change
 * then (a running loop keeps the Work its iterations, branches and pull requests point at), so
 * the page says "pause the loop" instead of offering a change that would be refused. Choosing
 * "No Work" clears it (`workId: null`).
 */
export function GoalWorkSection({
    goal,
    onGoalChange,
}: {
    goal: Goal;
    onGoalChange: (goal: Goal) => void;
}) {
    const t = useTranslations('dashboard.goalDetail');
    const router = useRouter();
    const [pending, startChange] = useTransition();
    const loopRunning = goal.loopStatus === 'running';

    const changeWork = (value: string) => {
        const next = value === '' ? null : value;
        if (next === (goal.workId ?? null)) return;
        startChange(async () => {
            try {
                const updated = await updateGoalAction(goal.id, { workId: next });
                // The PATCH answer carries no name; the refresh re-reads it.
                onGoalChange({ ...updated, workName: next ? (updated.workName ?? null) : null });
                toast.success(t('work.saved'));
                router.refresh();
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('work.saveError'));
            }
        });
    };

    return (
        <section className={sectionCard} data-testid="goal-work-section">
            <h2 className="text-sm font-semibold text-text dark:text-text-dark mb-1">
                {t('work.title')}
            </h2>
            <p className="text-xs text-text-muted dark:text-text-muted-dark mb-3">
                {goal.workId ? (
                    <Link
                        href={`/works/${goal.workId}`}
                        className="font-medium text-primary hover:underline dark:text-primary-dark"
                        data-testid="goal-work-chip"
                    >
                        {goal.workName ?? t('work.unnamed')}
                    </Link>
                ) : (
                    t('work.none')
                )}
            </p>
            <label
                className="block text-xs font-medium text-text dark:text-text-dark mb-2"
                htmlFor="goal-detail-work"
            >
                {t('work.changeLabel')}
            </label>
            <WorkSelect
                id="goal-detail-work"
                value={goal.workId ?? ''}
                onValueChange={changeWork}
                disabled={pending || loopRunning}
                noneLabel={t('work.none')}
                testId="goal-detail-work-select"
            />
            <p
                className="mt-2 text-[11px] text-text-muted dark:text-text-muted-dark"
                data-testid="goal-work-hint"
            >
                {loopRunning ? t('work.lockedWhileRunning') : t('work.hint')}
            </p>
        </section>
    );
}
