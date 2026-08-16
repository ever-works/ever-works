'use client';

import { useState, useTransition } from 'react';
import { Check, CircleSlash, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
// Runtime values from the client-safe module — see GoalLimitsDialog.tsx.
import {
    MAX_DOD_NOTE_CHARS,
    MAX_DOD_TEXT_CHARS,
    MAX_GOAL_DOD_CRITERIA,
} from '@/lib/api/goals.shared';
import { type Goal, type GoalDoDCriterion } from '@/lib/api/goals';
import { cn } from '@/lib/utils/cn';
import { DodProgressBar, DodRollup } from './goal-loop-ui';
import { approveGoalDodAction, patchGoalDodCriterionAction, setGoalDodAction } from './actions';

interface GoalDodPanelProps {
    goal: Goal;
    onGoalChange: (goal: Goal) => void;
}

/**
 * Literal union rather than `string`: next-intl's typed message keys
 * reject an arbitrary string, and the compile error is exactly the
 * guard we want against a toast key that no locale file defines.
 */
type DodToastKey =
    | 'toasts.added'
    | 'toasts.removed'
    | 'toasts.statusSaved'
    | 'toasts.waived'
    | 'toasts.approved';

/** Slugify a criterion's text into a stable, unique id within the Goal. */
function nextCriterionId(text: string, taken: Set<string>): string {
    const base =
        text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 48) || 'criterion';
    if (!taken.has(base)) return base;
    let suffix = 2;
    while (taken.has(`${base}-${suffix}`)) suffix += 1;
    return `${base}-${suffix}`;
}

/**
 * Autonomy layer — the Definition-of-Done tab.
 *
 * The checklist an operator actually works: add a criterion, tick it off
 * with evidence, waive it with a note, or reopen it. Waiving is a
 * FIRST-CLASS action beside done rather than a hidden menu item, because
 * the honest answer to "this no longer applies" must be as easy to record
 * as "we did it" — otherwise operators tick things done that were not.
 *
 * Planner-proposed criteria render greyed with an Approve control and are
 * excluded from the rollup until approved (the server enforces that; this
 * only shows it).
 */
export function GoalDodPanel({ goal, onGoalChange }: GoalDodPanelProps) {
    const t = useTranslations('dashboard.goalDetail.dod');
    const [pending, startTransition] = useTransition();
    const [draft, setDraft] = useState('');
    const [waivingId, setWaivingId] = useState<string | null>(null);
    const [waiveNote, setWaiveNote] = useState('');

    const criteria = goal.dodCriteria ?? [];
    const summary = goal.dodSummary;
    const atCap = criteria.length >= MAX_GOAL_DOD_CRITERIA;

    const run = (action: () => Promise<Goal>, successKey: DodToastKey) => {
        startTransition(async () => {
            try {
                onGoalChange(await action());
                toast.success(t(successKey));
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.error'));
            }
        });
    };

    const addCriterion = () => {
        const text = draft.trim();
        if (!text) return;
        const taken = new Set(criteria.map((entry) => entry.id));
        const next: GoalDoDCriterion[] = [
            ...criteria,
            { id: nextCriterionId(text, taken), text, status: 'open', source: 'operator' },
        ];
        setDraft('');
        run(() => setGoalDodAction(goal.id, next), 'toasts.added');
    };

    const removeCriterion = (criterionId: string) => {
        if (!window.confirm(t('confirmRemove'))) return;
        run(
            () =>
                setGoalDodAction(
                    goal.id,
                    criteria.filter((entry) => entry.id !== criterionId),
                ),
            'toasts.removed',
        );
    };

    const setStatus = (criterion: GoalDoDCriterion, status: GoalDoDCriterion['status']) => {
        run(
            () => patchGoalDodCriterionAction(goal.id, criterion.id, { status }),
            'toasts.statusSaved',
        );
    };

    const confirmWaive = (criterion: GoalDoDCriterion) => {
        const note = waiveNote.trim();
        setWaivingId(null);
        setWaiveNote('');
        run(
            () =>
                patchGoalDodCriterionAction(goal.id, criterion.id, {
                    status: 'waived',
                    note: note.length > 0 ? note : null,
                }),
            'toasts.waived',
        );
    };

    return (
        <div className="space-y-5">
            <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h2>
                    <DodRollup summary={summary} />
                </div>
                <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                    {t('hint')}
                </p>
                {summary.total > 0 ? (
                    <div className="mt-3">
                        <DodProgressBar summary={summary} />
                    </div>
                ) : null}

                {summary.proposed > 0 ? (
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2">
                        <p className="text-xs text-text dark:text-text-dark">
                            {t('proposalBanner', { count: summary.proposed })}
                        </p>
                        <Button
                            size="sm"
                            disabled={pending}
                            onClick={() =>
                                run(() => approveGoalDodAction(goal.id), 'toasts.approved')
                            }
                        >
                            {t('approveAll')}
                        </Button>
                    </div>
                ) : null}
            </div>

            <ul className="space-y-2">
                {criteria.length === 0 ? (
                    <li className="rounded-lg border border-dashed border-border/70 dark:border-border-dark/70 p-6 text-center text-xs text-text-muted dark:text-text-muted-dark">
                        {t('empty')}
                    </li>
                ) : null}

                {criteria.map((criterion) => {
                    const isProposed = criterion.proposed === true;
                    return (
                        <li
                            key={criterion.id}
                            className={cn(
                                'rounded-lg border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-3',
                                isProposed && 'opacity-70 border-dashed',
                            )}
                        >
                            <div className="flex items-start gap-3">
                                <span
                                    className={cn(
                                        'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[10px] font-semibold',
                                        criterion.status === 'done'
                                            ? 'border-success/30 bg-success/10 text-success'
                                            : criterion.status === 'waived'
                                              ? 'border-border/70 dark:border-border-dark/70 bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted'
                                              : 'border-border/70 dark:border-border-dark/70',
                                    )}
                                    aria-hidden
                                >
                                    {criterion.status === 'done' ? '✓' : null}
                                    {criterion.status === 'waived' ? '–' : null}
                                </span>
                                <div className="min-w-0 flex-1">
                                    <p
                                        className={cn(
                                            'text-sm text-text dark:text-text-dark',
                                            criterion.status !== 'open' &&
                                                'text-text-muted dark:text-text-muted-dark',
                                        )}
                                    >
                                        {criterion.text}
                                    </p>
                                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-text-muted dark:text-text-muted-dark">
                                        <span>{t(`statuses.${criterion.status}`)}</span>
                                        {criterion.source === 'planner' ? (
                                            <span>· {t('bySource.planner')}</span>
                                        ) : null}
                                        {isProposed ? <span>· {t('awaitingApproval')}</span> : null}
                                        {criterion.evidence ? (
                                            <span className="truncate">
                                                · {t('evidenceLabel')}: {criterion.evidence}
                                            </span>
                                        ) : null}
                                        {criterion.note ? (
                                            <span className="truncate">
                                                · {t('noteLabel')}: {criterion.note}
                                            </span>
                                        ) : null}
                                    </div>

                                    {waivingId === criterion.id ? (
                                        <div className="mt-2 flex flex-wrap items-center gap-2">
                                            <Input
                                                value={waiveNote}
                                                maxLength={MAX_DOD_NOTE_CHARS}
                                                placeholder={t('waiveNotePlaceholder')}
                                                onChange={(e) => setWaiveNote(e.target.value)}
                                                className="max-w-md"
                                            />
                                            <Button
                                                size="sm"
                                                disabled={pending}
                                                onClick={() => confirmWaive(criterion)}
                                            >
                                                {t('confirmWaive')}
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => setWaivingId(null)}
                                            >
                                                {t('cancel')}
                                            </Button>
                                        </div>
                                    ) : null}
                                </div>

                                <div className="flex shrink-0 items-center gap-1">
                                    {isProposed ? (
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            disabled={pending}
                                            onClick={() =>
                                                run(
                                                    () =>
                                                        approveGoalDodAction(goal.id, [
                                                            criterion.id,
                                                        ]),
                                                    'toasts.approved',
                                                )
                                            }
                                        >
                                            {t('approve')}
                                        </Button>
                                    ) : null}
                                    {criterion.status !== 'done' ? (
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            aria-label={t('markDone')}
                                            title={t('markDone')}
                                            disabled={pending}
                                            onClick={() => setStatus(criterion, 'done')}
                                        >
                                            <Check className="h-4 w-4" />
                                        </Button>
                                    ) : null}
                                    {criterion.status !== 'waived' ? (
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            aria-label={t('waive')}
                                            title={t('waive')}
                                            disabled={pending}
                                            onClick={() => {
                                                setWaivingId(criterion.id);
                                                setWaiveNote(criterion.note ?? '');
                                            }}
                                        >
                                            <CircleSlash className="h-4 w-4" />
                                        </Button>
                                    ) : null}
                                    {criterion.status !== 'open' ? (
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            aria-label={t('reopen')}
                                            title={t('reopen')}
                                            disabled={pending}
                                            onClick={() => setStatus(criterion, 'open')}
                                        >
                                            <RotateCcw className="h-4 w-4" />
                                        </Button>
                                    ) : null}
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        aria-label={t('remove')}
                                        title={t('remove')}
                                        disabled={pending}
                                        onClick={() => removeCriterion(criterion.id)}
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                            </div>
                        </li>
                    );
                })}
            </ul>

            <div className="flex flex-wrap items-end gap-2">
                <Input
                    label={t('addLabel')}
                    value={draft}
                    maxLength={MAX_DOD_TEXT_CHARS}
                    placeholder={t('addPlaceholder')}
                    disabled={atCap}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            addCriterion();
                        }
                    }}
                    className="max-w-xl"
                />
                <Button
                    size="sm"
                    disabled={pending || atCap || draft.trim().length === 0}
                    onClick={addCriterion}
                >
                    <Plus className="h-4 w-4" />
                    {t('add')}
                </Button>
            </div>
            {atCap ? (
                <p className="text-[11px] text-warning">
                    {t('atCap', { max: MAX_GOAL_DOD_CRITERIA })}
                </p>
            ) : null}
        </div>
    );
}
