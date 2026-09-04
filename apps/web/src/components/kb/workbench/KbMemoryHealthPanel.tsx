'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Activity, HelpCircle, Inbox, Milestone, Search } from 'lucide-react';
import type { KbMemoryHealth } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';
import { browserApiFetch } from '@/lib/api/browser-api';

/**
 * Memory health panel (memory upgrades M10).
 *
 * Renders the three metrics the eval loop computes — recall hit rate,
 * stale decisions, review backlog — plus the gap topics that feed the
 * next consolidation pass. Every number carries a plain-language
 * explanation of what it means and what a bad value implies, because a
 * bare "0.42" on a dashboard is a number nobody acts on.
 *
 * The one rule this component enforces visually: a `null` rate renders
 * as "Not measurable yet" with the reason, never as `0%`. "We measured
 * zero" and "we cannot measure" are different facts and conflating them
 * is how a health panel starts lying to its reader.
 *
 * Org-scoped: the API resolves the Organization from the request scope
 * context, so there is no org id to pass — a session with no active org
 * gets the empty payload and the panel says so.
 *
 * EW-786 — but the scope context has to be told which workspace this tab
 * is looking at. `browserApiFetch` (not a bare `fetch`) is what stamps
 * the per-tab `x-ever-workspace` selector the BFF route turns into the
 * API's `x-scope-slug`. Without it the request reached the API unscoped,
 * `getMemoryHealth` fell to its org-less branch, and this panel rendered
 * a fully populated wall of zeroes for an Organization with real
 * retrieval history — a lie the `null` handling above cannot catch,
 * because `emptyHealth()` reports measurable zeroes rather than `null`.
 * The route now answers 400 without that selector, so the two halves are
 * a matched pair: a raw `fetch` here would surface as the error state.
 */

export interface KbMemoryHealthPanelProps {
    /** Injected in tests; production fetches `/api/memory/health`. */
    initialHealth?: KbMemoryHealth | null;
    windowDays?: number;
    className?: string;
}

export function KbMemoryHealthPanel({
    initialHealth,
    windowDays,
    className,
}: KbMemoryHealthPanelProps) {
    const t = useTranslations('dashboard.workDetail.kb.health');
    const [health, setHealth] = useState<KbMemoryHealth | null>(initialHealth ?? null);
    const [loading, setLoading] = useState(!initialHealth);
    const [error, setError] = useState<string | null>(null);
    const [reloadKey, setReloadKey] = useState(0);

    const retry = useCallback(() => {
        setError(null);
        setLoading(true);
        setReloadKey((key) => key + 1);
    }, []);

    useEffect(() => {
        // A caller-supplied payload is authoritative (unit tests, and a
        // future server-rendered variant) — never re-fetch over it.
        if (initialHealth) return;
        let cancelled = false;
        const query = windowDays ? `?windowDays=${windowDays}` : '';
        browserApiFetch(`/api/memory/health${query}`, { cache: 'no-store' })
            .then(async (res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return (await res.json()) as KbMemoryHealth;
            })
            .then((data) => {
                if (cancelled) return;
                setHealth(data);
            })
            .catch(() => {
                if (cancelled) return;
                setError(t('error'));
            })
            .finally(() => {
                if (cancelled) return;
                setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [initialHealth, windowDays, reloadKey, t]);

    if (loading) {
        return (
            <section
                data-testid="kb-memory-health-loading"
                className={cn(
                    'rounded-lg border border-border p-4 text-sm text-text-muted',
                    'dark:border-border-dark dark:text-text-muted-dark/70',
                    className,
                )}
            >
                {t('loading')}
            </section>
        );
    }

    if (error || !health) {
        return (
            <section
                data-testid="kb-memory-health-error"
                className={cn(
                    'flex items-center justify-between gap-3 rounded-lg border border-border p-4',
                    'text-sm text-red-600 dark:border-border-dark dark:text-red-400',
                    className,
                )}
            >
                <span>{error ?? t('error')}</span>
                <button
                    type="button"
                    onClick={retry}
                    data-testid="kb-memory-health-retry"
                    className="rounded-md border border-border px-2 py-1 text-xs font-medium text-text-secondary hover:bg-card-hover dark:border-border-dark dark:text-text-secondary-dark/80"
                >
                    {t('retry')}
                </button>
            </section>
        );
    }

    return (
        <section
            data-testid="kb-memory-health"
            aria-labelledby="kb-memory-health-title"
            className={cn('rounded-lg border border-border dark:border-border-dark', className)}
        >
            <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-3 dark:border-border-dark">
                <h2
                    id="kb-memory-health-title"
                    className="flex items-center gap-1.5 text-sm font-semibold text-text dark:text-text-dark"
                >
                    <Activity className="h-4 w-4" aria-hidden="true" />
                    {t('title')}
                </h2>
                <p className="text-xs text-text-muted dark:text-text-muted-dark/70">
                    {t('subtitle')}
                </p>
                <span
                    data-testid="kb-memory-health-window"
                    className="ml-auto text-[11px] uppercase tracking-wide text-text-muted dark:text-text-muted-dark/60"
                >
                    {t('window', { days: health.windowDays })}
                </span>
            </header>

            <div className="grid gap-px bg-border sm:grid-cols-3 dark:bg-border-dark">
                <Metric
                    testId="kb-memory-health-recall"
                    icon={<Search className="h-3.5 w-3.5" aria-hidden="true" />}
                    label={t('recall.label')}
                    value={formatRate(health.recallHitRate)}
                    unmeasured={health.recallHitRate === null}
                    unmeasuredLabel={t('notMeasurable')}
                    explainer={t('recall.explainer')}
                    detail={
                        health.recallHitRate === null
                            ? t('recall.noSignal')
                            : t('recall.detail', {
                                  cited: health.documentsCited,
                                  retrieved: health.documentsRetrieved,
                              })
                    }
                />
                <Metric
                    testId="kb-memory-health-stale"
                    icon={<Milestone className="h-3.5 w-3.5" aria-hidden="true" />}
                    label={t('stale.label')}
                    value={formatRate(health.staleDecisionRate)}
                    unmeasured={health.staleDecisionRate === null}
                    unmeasuredLabel={t('notMeasurable')}
                    explainer={t('stale.explainer', { days: health.staleAfterDays })}
                    detail={
                        health.staleDecisionRate === null
                            ? t('stale.none')
                            : t('stale.detail', {
                                  stale: health.decisionsStale,
                                  accepted: health.decisionsAccepted,
                              })
                    }
                />
                <Metric
                    testId="kb-memory-health-backlog"
                    icon={<Inbox className="h-3.5 w-3.5" aria-hidden="true" />}
                    label={t('backlog.label')}
                    value={String(health.proposedBacklog)}
                    unmeasured={false}
                    unmeasuredLabel={t('notMeasurable')}
                    explainer={t('backlog.explainer')}
                    detail={
                        health.proposedBacklog === 0
                            ? t('backlog.none')
                            : t('backlog.detail', {
                                  oldest: health.proposedOldestAgeDays ?? 0,
                                  average: health.proposedAverageAgeDays ?? 0,
                              })
                    }
                />
            </div>

            <div className="grid gap-4 border-t border-border p-4 sm:grid-cols-2 dark:border-border-dark">
                <div data-testid="kb-memory-health-gaps">
                    <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark/80">
                        <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('gaps.label')}
                    </h3>
                    <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark/70">
                        {t('gaps.explainer')}
                    </p>
                    {health.gapTopics.length === 0 ? (
                        <p
                            data-testid="kb-memory-health-gaps-empty"
                            className="mt-2 text-xs text-text-muted dark:text-text-muted-dark/60"
                        >
                            {t('gaps.none')}
                        </p>
                    ) : (
                        <ul className="mt-2 flex flex-col gap-1">
                            {health.gapTopics.map((topic) => (
                                <li
                                    key={topic.query}
                                    className="flex items-baseline gap-2 text-xs text-text-secondary dark:text-text-secondary-dark/80"
                                >
                                    <span className="truncate">{topic.query}</span>
                                    <span className="ml-auto shrink-0 text-text-muted dark:text-text-muted-dark/60">
                                        {t('gaps.occurrences', { count: topic.occurrences })}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <div data-testid="kb-memory-health-uncited">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark/80">
                        {t('uncited.label')}
                    </h3>
                    {health.uncitedDocs.length === 0 ? (
                        <p
                            data-testid="kb-memory-health-uncited-empty"
                            className="mt-2 text-xs text-text-muted dark:text-text-muted-dark/60"
                        >
                            {t('uncited.none')}
                        </p>
                    ) : (
                        <ul className="mt-2 flex flex-col gap-1">
                            {health.uncitedDocs.map((doc) => (
                                <li
                                    key={doc.documentId}
                                    className="flex items-baseline gap-2 text-xs text-text-secondary dark:text-text-secondary-dark/80"
                                >
                                    <span className="truncate">{doc.title}</span>
                                    <span className="ml-auto shrink-0 text-text-muted dark:text-text-muted-dark/60">
                                        {t('uncited.retrievals', { count: doc.retrievals })}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
        </section>
    );
}

interface MetricProps {
    testId: string;
    icon: React.ReactNode;
    label: string;
    value: string;
    unmeasured: boolean;
    unmeasuredLabel: string;
    explainer: string;
    detail: string;
}

function Metric({
    testId,
    icon,
    label,
    value,
    unmeasured,
    unmeasuredLabel,
    explainer,
    detail,
}: MetricProps) {
    return (
        <div
            data-testid={testId}
            data-unmeasured={unmeasured ? 'true' : 'false'}
            className="bg-card-primary p-4 dark:bg-card-primary-dark"
        >
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark/80">
                {icon}
                {label}
            </h3>
            <p
                data-testid={`${testId}-value`}
                className={cn(
                    'mt-1 font-semibold',
                    unmeasured
                        ? 'text-sm text-text-muted dark:text-text-muted-dark/70'
                        : 'text-2xl text-text dark:text-text-dark',
                )}
            >
                {unmeasured ? unmeasuredLabel : value}
            </p>
            <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark/70">{explainer}</p>
            <p
                data-testid={`${testId}-detail`}
                className="mt-1 text-xs text-text-secondary dark:text-text-secondary-dark/70"
            >
                {detail}
            </p>
        </div>
    );
}

/** `null` never becomes `0%` — the caller renders the unmeasured state. */
function formatRate(rate: number | null): string {
    if (rate === null) return '';
    return `${Math.round(rate * 100)}%`;
}
