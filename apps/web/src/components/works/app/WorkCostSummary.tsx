'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { WorkCostRollup } from '@ever-works/contracts';
import { getWorkCostAction } from '@/app/actions/dashboard/app-changes';

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
                        {formatCents(state.cost.spendCents, state.cost.currency, locale)}
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
                                {formatCents(
                                    state.cost.remainingCents ?? 0,
                                    state.cost.currency,
                                    locale,
                                )}
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
        </div>
    );
}
