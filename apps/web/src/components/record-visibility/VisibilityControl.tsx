'use client';

import { useEffect, useId, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Building2, Lock, Users } from 'lucide-react';
import {
    getRecordVisibilityAction,
    setRecordVisibilityResultAction,
} from '@/app/actions/record-visibility';
import {
    VISIBILITY_CHOICES,
    currentChoice,
    type RecordAggregate,
    type RecordVisibility,
    type RecordVisibilityView,
    type VisibilityChoice,
} from '@/lib/record-visibility';

const VISIBILITY_ICON: Record<RecordVisibility, typeof Lock> = {
    private: Lock,
    team: Users,
    organization: Building2,
};

/**
 * Record visibility (EW-P1-3, spec §7) — the visibility control on the task, goal,
 * mission, idea and agent forms: a lock / team / organization icon for who can see the
 * record, "Automatic" until somebody picks a value by hand.
 *
 * Reads `GET /api/record-visibility/:aggregate/:id` (anyone who may read the record);
 * only the owner gets the picker. Changing it calls `PUT` and re-renders the answer.
 */
export function VisibilityControl({
    aggregate,
    id,
    initial,
    onChange,
}: {
    aggregate: RecordAggregate;
    id: string;
    /** Server-fetched state, when the page already has it. */
    initial?: RecordVisibilityView | null;
    onChange?: (view: RecordVisibilityView) => void;
}) {
    const t = useTranslations('recordVisibility.control');
    const selectId = useId();
    const [view, setView] = useState<RecordVisibilityView | null>(initial ?? null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        if (initial !== undefined) return;
        let cancelled = false;
        getRecordVisibilityAction(aggregate, id)
            .then((loaded) => {
                if (!cancelled) setView(loaded);
            })
            .catch(() => {
                if (!cancelled) setError(t('loadError'));
            });
        return () => {
            cancelled = true;
        };
    }, [aggregate, id, initial, t]);

    if (!view) {
        return error ? (
            <p className="text-xs text-red-600 dark:text-red-400" role="alert">
                {error}
            </p>
        ) : null;
    }

    const Icon = VISIBILITY_ICON[view.visibility];
    const choice = currentChoice(view);

    const change = (next: VisibilityChoice) => {
        setError(null);
        startTransition(async () => {
            // Review 2026-10-17 U9: a refusal comes back as a value (its reason shows).
            try {
                const result = await setRecordVisibilityResultAction(aggregate, id, next);
                if (!result.ok) {
                    setError(result.message || t('error'));
                    return;
                }
                setView((previous) => ({ ...previous, ...result.view }) as RecordVisibilityView);
                onChange?.(result.view);
            } catch {
                setError(t('error'));
            }
        });
    };

    return (
        <div className="flex flex-col gap-1" data-testid="visibility-control">
            <div className="flex flex-wrap items-center gap-2 text-sm">
                <Icon
                    className="h-4 w-4 text-text-secondary dark:text-text-secondary-dark"
                    aria-hidden="true"
                />
                {view.canEdit ? (
                    <>
                        <label htmlFor={selectId} className="font-medium">
                            {t('label')}
                        </label>
                        <select
                            id={selectId}
                            value={choice}
                            disabled={pending}
                            onChange={(event) => change(event.target.value as VisibilityChoice)}
                            className="rounded-md border border-border bg-transparent px-2 py-1 text-sm dark:border-border-dark"
                            data-testid="visibility-control-select"
                        >
                            {VISIBILITY_CHOICES.map((option) => (
                                <option key={option} value={option}>
                                    {/* Review 2026-10-17 U4: "Automatic (Private)" on a record set to
                                        Private by hand promised what choosing it does not do (an
                                        organization record's automatic value is Team or Organization).
                                        The current value is the automatic one only while nobody
                                        picked one by hand. */}
                                    {option === 'automatic'
                                        ? view.visibilityExplicit
                                            ? t('automatic')
                                            : t('automaticWith', { value: t(view.visibility) })
                                        : t(option)}
                                </option>
                            ))}
                        </select>
                    </>
                ) : (
                    <span>
                        <span className="font-medium">{t('label')}:</span> {t(view.visibility)}
                        {view.visibilityExplicit ? null : ` (${t('automatic')})`}
                    </span>
                )}
                {pending ? (
                    <span className="text-xs text-text-secondary dark:text-text-secondary-dark">
                        {t('saving')}
                    </span>
                ) : null}
            </div>
            <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                {choice === 'automatic' ? t('automaticHint') : t(`${view.visibility}Hint`)}
            </p>
            {error ? (
                <p className="text-xs text-red-600 dark:text-red-400" role="alert">
                    {error}
                </p>
            ) : null}
        </div>
    );
}
