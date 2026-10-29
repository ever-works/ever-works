'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { TaskCostView } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { formatCents } from '@/components/works/app/WorkCostSummary';
import { getTaskCostAction } from '@/app/actions/tasks';

type Load = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; cost: TaskCostView };

/**
 * The runs' sum, or `null` (unknown) as soon as one run is not priced yet: a partial sum would
 * read as the whole cost. An empty list is a known zero.
 */
export function sumRunCents(runs: TaskCostView['runs']): number | null {
    let total = 0;
    for (const run of runs) {
        if (run.costCents === null || run.costCents === undefined) return null;
        total += run.costCents;
    }
    return total;
}

/** Only a same-origin path is linked (the API answers `/agents/sessions/<runId>`). */
function receiptHref(url: string | null | undefined): string | null {
    if (!url || !url.startsWith('/') || url.startsWith('//') || url.startsWith('/\\')) return null;
    return url;
}

/**
 * APW-08 T27 (`TaskCostSection`, spec §6.2 `COST`) — the Task page's last section, from
 * `GET /api/tasks/:id/cost`: the runs and what they cost (each with its receipt), the Builds when
 * per-Task Build accounting reports any, and the total. An unpriced amount reads **unknown**,
 * never `$0.00`. Neutral copy only — no status colour on a cost figure.
 */
export function TaskCostSection({ taskId }: { taskId: string }) {
    const t = useTranslations('dashboard.tasksPage.cost');
    const locale = useLocale();
    const [load, setLoad] = useState<Load>({ kind: 'loading' });

    useEffect(() => {
        let cancelled = false;
        void getTaskCostAction(taskId)
            .then((result) => {
                if (cancelled) return;
                setLoad(result.ok ? { kind: 'ready', cost: result.cost } : { kind: 'unavailable' });
            })
            .catch(() => {
                if (!cancelled) setLoad({ kind: 'unavailable' });
            });
        return () => {
            cancelled = true;
        };
    }, [taskId]);

    const money = (cents: number | null | undefined, currency: string) =>
        cents === null || cents === undefined ? t('unknown') : formatCents(cents, currency, locale);

    return (
        <section
            className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5"
            data-testid="task-cost-section"
            data-state={load.kind}
        >
            <h2 className="text-sm font-medium text-text dark:text-text-dark mb-3">{t('sectionTitle')}</h2>

            {load.kind === 'loading' && (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('loading')}</p>
            )}
            {load.kind === 'unavailable' && (
                <p className="text-xs text-text-muted dark:text-text-muted-dark" data-testid="task-cost-unavailable">
                    {t('unavailable')}
                </p>
            )}

            {load.kind === 'ready' && (
                <div className="space-y-3 text-xs text-text dark:text-text-dark">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                        <span data-testid="task-cost-runs">
                            {t('runs', {
                                count: load.cost.runs.length,
                                amount: money(sumRunCents(load.cost.runs), load.cost.currency),
                            })}
                        </span>
                        {load.cost.builds.length > 0 && (
                            <span data-testid="task-cost-builds">
                                {t('builds', {
                                    count: load.cost.builds.length,
                                    minutes: load.cost.builds.every((b) => b.runnerMinutes !== null)
                                        ? load.cost.builds.reduce((n, b) => n + (b.runnerMinutes ?? 0), 0)
                                        : t('unknown'),
                                    payer: load.cost.builds.every((b) => b.payer === 'github')
                                        ? t('paidByGithub')
                                        : t('paidByEverWorks'),
                                })}
                            </span>
                        )}
                        <span className="font-medium" data-testid="task-cost-total">
                            {t('total', { amount: money(load.cost.totalCents, load.cost.currency) })}
                        </span>
                    </div>

                    {load.cost.runs.length === 0 ? (
                        <p className="text-text-muted dark:text-text-muted-dark">{t('noRuns')}</p>
                    ) : (
                        <ul className="divide-y divide-border/40 dark:divide-border-dark/40" data-testid="task-cost-run-list">
                            {load.cost.runs.map((run) => {
                                const href = receiptHref(run.receiptUrl);
                                return (
                                    <li
                                        key={run.runId}
                                        className="flex items-center justify-between gap-3 py-1.5"
                                        data-testid="task-cost-run"
                                    >
                                        <span className="font-mono text-text-secondary dark:text-text-secondary-dark">
                                            {t('runLabel', { id: run.runId.slice(0, 8) })}
                                        </span>
                                        <span className="ml-auto tabular-nums" data-testid="task-cost-run-amount">
                                            {money(run.costCents, load.cost.currency)}
                                        </span>
                                        {href && (
                                            <Link href={href} className="text-text-muted hover:text-primary hover:underline">
                                                {t('receipt')}
                                            </Link>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}

                    {load.cost.runsTruncated && (
                        <p className="text-text-muted dark:text-text-muted-dark" data-testid="task-cost-truncated">
                            {t('runsTruncated', { count: load.cost.runsLimit })}
                        </p>
                    )}
                </div>
            )}
        </section>
    );
}
