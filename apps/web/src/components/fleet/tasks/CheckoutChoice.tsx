'use client';

import { useTranslations } from 'next-intl';
import type {
    FleetHandoffCheckoutRef,
    FleetHandoffNodeCheckouts,
    FleetHandoffTask,
} from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';
import type { HandoffCheckoutChoice } from './task-handoff.shared';

/**
 * Tasks on computers (FL-15 P1, spec FR-5, U7, §5.2) — the dialog's Checkout
 * section for the chosen computer: a new worktree of each matching checkout
 * on the Task's branch (the default when one exists), each matching checkout
 * as it is, and a fresh clone of the Task's repository. A Task without a
 * repository is offered the computer's other checkouts or the home folder.
 */
export function CheckoutChoice({
    step,
    task,
    value,
    onChange,
    nodeName,
}: {
    step: FleetHandoffNodeCheckouts | undefined;
    task: FleetHandoffTask;
    value: HandoffCheckoutChoice;
    onChange: (choice: HandoffCheckoutChoice) => void;
    nodeName: string;
}) {
    const t = useTranslations('fleet.taskHandoff.checkout');
    const matching = step?.matching ?? [];
    const others = step?.others ?? [];
    const hasRepository = !!task.repoUrl;
    // P3 (FR-20): FL-14's new worktree cuts a NEW branch, so a pull request's head is cloned instead.
    const allowWorktree = !task.pullRequest?.headRef;

    const option = (
        key: string,
        selected: boolean,
        label: string,
        choice: HandoffCheckoutChoice,
        testId: string,
    ) => (
        <button
            key={key}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(choice)}
            className={cn(
                'w-full rounded-md border px-3 py-1.5 text-left text-sm',
                selected ? 'border-primary bg-primary/5' : 'border-border dark:border-border-dark',
            )}
            data-testid={testId}
        >
            <span className="font-mono text-xs break-all">{label}</span>
        </button>
    );

    const worktree = (ref: FleetHandoffCheckoutRef) =>
        option(
            `worktree:${ref.checkoutId}`,
            value.mode === 'worktree' && value.parentCheckoutId === ref.checkoutId,
            task.branch
                ? t('worktree', { path: ref.path, branch: task.branch })
                : t('worktreeNoBranch', { path: ref.path }),
            { mode: 'worktree', parentCheckoutId: ref.checkoutId },
            'fleet-handoff-checkout-worktree',
        );
    const existing = (ref: FleetHandoffCheckoutRef) =>
        option(
            `existing:${ref.checkoutId}`,
            value.mode === 'existing' && value.checkoutId === ref.checkoutId,
            t('existing', { path: ref.path }),
            { mode: 'existing', checkoutId: ref.checkoutId },
            'fleet-handoff-checkout-existing',
        );

    return (
        <div
            role="radiogroup"
            aria-label={t('label')}
            className="space-y-1.5"
            data-testid="fleet-handoff-checkouts"
        >
            {hasRepository ? (
                <>
                    {allowWorktree && matching.map(worktree)}
                    {matching.map(existing)}
                    {option(
                        'clone',
                        value.mode === 'clone',
                        t('clone', { repository: task.repository ?? task.repoUrl ?? '' }),
                        { mode: 'clone' },
                        'fleet-handoff-checkout-clone',
                    )}
                    {matching.length === 0 && (
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('noMatching', { node: nodeName, repository: task.repository ?? '' })}
                        </p>
                    )}
                </>
            ) : (
                <>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('noRepository')}
                    </p>
                    {[...matching, ...others].map(existing)}
                    {option(
                        'none',
                        value.mode === 'none',
                        t('none'),
                        { mode: 'none' },
                        'fleet-handoff-checkout-none',
                    )}
                </>
            )}
            {step?.stale && <p className="text-xs text-warning">{step.stale}</p>}
        </div>
    );
}
