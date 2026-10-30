'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { WorkCostRollup } from '@ever-works/contracts';
import { getWorkCostAction } from '@/app/actions/dashboard/app-changes';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

/** Cents as a currency amount in the reader's locale (`$1,234.50`). */
export function formatCents(cents: number, currency: string, locale: string): string {
    try {
        return new Intl.NumberFormat(locale, {
            style: 'currency',
            currency: currency.toUpperCase(),
        }).format(cents / 100);
    } catch {
        return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
    }
}

type State =
    | { kind: 'loading' }
    | { kind: 'unavailable' }
    | { kind: 'ready'; cost: WorkCostRollup };

/**
 * APW-08 T27/T56 (`WorkCostSummary`) — this month's spend for the Work against its own budget,
 * from `GET /api/works/:id/cost`: spent, the monthly budget, what remains and the alert state.
 * Read-only; the budget itself is set where it always was.
 *
 * T56 (FR-62, FR-73, ACC-08-37) — an unknown amount reads **unknown**, never `$0.00` (the API
 * answers `spendCents: null`, and then `remainingCents: null` too). The month's costliest Tasks
 * of this Work link to each Task's own Cost section (its receipts and runs), so the overview
 * points at that section rather than competing with it.
 */
export function WorkCostSummary({ workId }: { workId: string }) {
    const t = useTranslations('dashboard.workDetail.appCost');
    const locale = useLocale();
    const [state, setState] = useState<State>({ kind: 'loading' });

    useEffect(() => {
        let cancelled = false;
        void getWorkCostAction(workId)
            .then((result) => {
                if (cancelled) return;
                setState(
                    result.success && result.data
                        ? { kind: 'ready', cost: result.data }
                        : { kind: 'unavailable' },
                );
            })
            .catch(() => {
                if (!cancelled) setState({ kind: 'unavailable' });
            });
        return () => {
            cancelled = true;
        };
    }, [workId]);

    const money = (cents: number | null | undefined, currency: string) =>
        cents === null || cents === undefined ? t('unknown') : formatCents(cents, currency, locale);

    return (
        <div
            className="rounded-md border border-border dark:border-border-dark p-3 space-y-2"
            data-testid="work-cost-summary"
            data-state={state.kind}
        >
            <h3 className="text-sm font-semibold text-text dark:text-text-dark">{t('title')}</h3>
            {state.kind === 'loading' && (
                <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                    {t('loading')}
                </p>
            )}
            {state.kind === 'unavailable' && (
                <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                    {t('unavailable')}
                </p>
            )}
            {state.kind === 'ready' && (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    <dt className="text-text-secondary dark:text-text-secondary-dark">
                        {t('spend')}
                    </dt>
                    <dd
                        className="font-medium text-text dark:text-text-dark"
                        data-testid="work-cost-spend"
                    >
                        {money(state.cost.spendCents, state.cost.currency)}
                    </dd>
                    {state.cost.capCents === null ? (
                        <dd
                            className="col-span-2 text-xs text-text-secondary dark:text-text-secondary-dark"
                            data-testid="work-cost-no-budget"
                        >
                            {t('noBudget')}
                        </dd>
                    ) : (
                        <>
                            <dt className="text-text-secondary dark:text-text-secondary-dark">
                                {t('cap')}
                            </dt>
                            <dd
                                className="font-medium text-text dark:text-text-dark"
                                data-testid="work-cost-cap"
                            >
                                {formatCents(state.cost.capCents, state.cost.currency, locale)}
                            </dd>
                            <dt className="text-text-secondary dark:text-text-secondary-dark">
                                {t('remaining')}
                            </dt>
                            <dd
                                className="font-medium text-text dark:text-text-dark"
                                data-testid="work-cost-remaining"
                            >
                                {/* Unknown while the spend is unknown — never the whole cap. */}
                                {money(state.cost.remainingCents, state.cost.currency)}
                            </dd>
                            <dd
                                className="col-span-2 text-xs text-text-secondary dark:text-text-secondary-dark"
                                data-testid="work-cost-alert"
                                data-alert={state.cost.alert}
                            >
                                {t(`alert.${state.cost.alert}`)}
                            </dd>
                        </>
                    )}
                </dl>
            )}
            {state.kind === 'ready' && (
                <div className="space-y-1" data-testid="work-cost-tasks">
                    <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                        {t('tasksHint')}
                    </p>
                    {state.cost.tasks && state.cost.tasks.length > 0 && (
                        <ul className="space-y-1 text-sm" aria-label={t('tasksTitle')}>
                            {state.cost.tasks.map((line) => {
                                const title = line.title ?? t('untitledTask');
                                return (
                                    <li
                                        key={line.taskId}
                                        className="flex items-center justify-between gap-3"
                                        data-testid="work-cost-task"
                                    >
                                        <Link
                                            href={ROUTES.DASHBOARD_TASK(line.taskId)}
                                            className="truncate underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 text-text dark:text-text-dark"
                                            aria-label={t('openTaskCost', { title })}
                                            data-testid="work-cost-task-link"
                                        >
                                            {title}
                                        </Link>
                                        <span className="shrink-0 text-text-secondary dark:text-text-secondary-dark">
                                            {money(line.spendCents, state.cost.currency)}
                                        </span>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}
