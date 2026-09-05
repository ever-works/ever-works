'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/constants';
import { formatCents } from '@/lib/api/credits.shared';
import {
    buildCostsQuery,
    COSTS_WINDOW_DAYS,
    type CostsSnapshot,
    type CostsSection,
    type CostsWindowDays,
} from '@/lib/api/costs.shared';
import { CostsDailyStackedChart } from './CostsDailyStackedChart';
import { CostsByModelList } from './CostsByModelList';

interface CostsSettingsProps {
    /** Window the server rendered the initial snapshot with. */
    initialWindowDays: CostsWindowDays;
    initialSnapshot: CostsSnapshot;
}

async function fetchCosts<T>(section: CostsSection, windowDays: CostsWindowDays): Promise<T> {
    // eslint-disable-next-line no-restricted-syntax -- EW-790 ok
    const response = await fetch(`/api/usage/costs/${section}${buildCostsQuery({ windowDays })}`, {
        method: 'GET',
        cache: 'no-store',
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as T;
}

function StatTile({ label, value, testId }: { label: string; value: string; testId: string }) {
    // Monochrome KPI tiles, matching the Overview tab's grid.
    return (
        <div
            data-testid={testId}
            className="rounded-lg border border-border dark:border-border-dark p-4"
        >
            <p className="text-xs text-text-muted dark:text-text-muted-dark">{label}</p>
            <p className="mt-1 text-xl font-semibold text-text dark:text-text-dark">{value}</p>
        </div>
    );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="rounded-lg border border-border dark:border-border-dark p-5 space-y-3">
            <h3 className="text-sm font-semibold text-text dark:text-text-dark">{title}</h3>
            {children}
        </div>
    );
}

/**
 * Costs tab of Settings → Usage & Credits.
 *
 * Additive beside the Overview tab: the credits/period surface there is
 * untouched, and this tab answers a different question — where the AI
 * spend of the last 7/30/90 days actually went, per Agent, per model and
 * per run.
 *
 * One window drives every panel, and each window's snapshot is cached so
 * flipping back is instant (same pattern as `UsageCreditsSettings`).
 */
export function CostsSettings({ initialWindowDays, initialSnapshot }: CostsSettingsProps) {
    const t = useTranslations('dashboard.settings.costs');

    /**
     * Run statuses that have localized copy. An unrecognized status (a
     * future member of `AgentRunStatus`) falls back to its raw token
     * rather than making next-intl throw on a missing key and taking the
     * whole table down.
     */
    const runStatusLabel = (status: string): string =>
        (['queued', 'running', 'completed', 'failed', 'cancelled'] as const).includes(
            status as never,
        )
            ? t(`topRuns.status.${status}` as 'topRuns.status.completed')
            : status;

    const [windowDays, setWindowDays] = useState<CostsWindowDays>(initialWindowDays);
    const [snapshot, setSnapshot] = useState<CostsSnapshot>(initialSnapshot);
    const [cache, setCache] = useState<Record<number, CostsSnapshot>>({
        [initialWindowDays]: initialSnapshot,
    });
    const [loading, setLoading] = useState(false);
    const [loadFailed, setLoadFailed] = useState(false);

    /**
     * Monotonic token for the in-flight window fetch.
     *
     * Five requests go out per window change and nothing cancels the
     * previous batch, so clicking 7d then 90d races two batches whose
     * completion order is not the click order. Without this guard the
     * SLOWER batch wins and the page renders 7d numbers under a
     * highlighted 90d button — silently wrong spend, which is the one
     * thing this view must never show. Stale batches still populate the
     * cache (their data is correct for THEIR window); they just may not
     * touch what is on screen.
     */
    const latestRequest = useRef(0);

    const handleWindowChange = async (next: CostsWindowDays) => {
        if (next === windowDays) {
            return;
        }
        const request = latestRequest.current + 1;
        latestRequest.current = request;

        setWindowDays(next);
        setLoadFailed(false);

        const cached = cache[next];
        if (cached) {
            setSnapshot(cached);
            setLoading(false);
            return;
        }

        setLoading(true);
        try {
            const [summary, daily, byAgent, byModel, topRuns] = await Promise.all([
                fetchCosts<CostsSnapshot['summary']>('summary', next),
                fetchCosts<CostsSnapshot['daily']>('daily', next),
                fetchCosts<CostsSnapshot['byAgent']>('by-agent', next),
                fetchCosts<CostsSnapshot['byModel']>('by-model', next),
                fetchCosts<CostsSnapshot['topRuns']>('top-runs', next),
            ]);
            const fresh: CostsSnapshot = { summary, daily, byAgent, byModel, topRuns };
            setCache((current) => ({ ...current, [next]: fresh }));
            if (latestRequest.current !== request) {
                return;
            }
            setSnapshot(fresh);
        } catch {
            if (latestRequest.current !== request) {
                return;
            }
            setLoadFailed(true);
        } finally {
            if (latestRequest.current === request) {
                setLoading(false);
            }
        }
    };

    const { summary, daily, byAgent, byModel, topRuns } = snapshot;
    const dataUnavailable = !summary && !daily && !byAgent && !byModel && !topRuns;

    return (
        <div className="space-y-8" data-testid="costs-settings">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                        {t('title')}
                    </h2>
                    <p className="text-text-muted dark:text-text-muted-dark text-sm">
                        {t('subtitle')}
                    </p>
                </div>

                <div
                    role="group"
                    aria-label={t('window.label')}
                    className="flex flex-wrap items-center gap-2"
                    data-testid="costs-window-bar"
                >
                    {COSTS_WINDOW_DAYS.map((days) => (
                        <Button
                            key={days}
                            variant={windowDays === days ? 'primary' : 'secondary'}
                            className={cn('text-xs px-3 py-1')}
                            data-testid={`costs-window-${days}`}
                            aria-pressed={windowDays === days}
                            onClick={() => handleWindowChange(days)}
                        >
                            {t('window.days', { days })}
                        </Button>
                    ))}
                </div>
            </div>

            {dataUnavailable || loadFailed ? (
                <div
                    data-testid="costs-load-error"
                    className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm text-text dark:text-text-dark"
                >
                    <AlertCircle className="w-4 h-4 shrink-0 text-warning" />
                    {t('loadError')}
                </div>
            ) : null}

            {/* ── Headline totals ─────────────────────────────────── */}
            {summary ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" data-testid="costs-tiles">
                    <StatTile
                        label={t('tiles.total')}
                        value={formatCents(summary.totalCostCents)}
                        testId="costs-tile-total"
                    />
                    <StatTile
                        label={t('tiles.runs')}
                        value={String(summary.runsCount)}
                        testId="costs-tile-runs"
                    />
                    <StatTile
                        label={t('tiles.avgPerRun')}
                        value={formatCents(summary.avgPerRunCents)}
                        testId="costs-tile-avg"
                    />
                </div>
            ) : null}

            {/* ── Daily spend, stacked by Agent ───────────────────── */}
            <Panel title={t('panels.daily')}>
                {loading ? (
                    <p
                        className="py-10 text-center text-xs text-text-muted dark:text-text-muted-dark"
                        data-testid="costs-loading"
                    >
                        {t('loading')}
                    </p>
                ) : (
                    <CostsDailyStackedChart
                        series={daily?.series ?? []}
                        days={daily?.days ?? []}
                        emptyLabel={t('empty')}
                        otherLabel={t('series.other')}
                        unattributedLabel={t('series.unattributed')}
                        unknownAgentLabel={t('series.unknownAgent')}
                    />
                )}
            </Panel>

            {/* ── By agent / by model ─────────────────────────────── */}
            <div className="grid gap-4 @3xl/main:grid-cols-2">
                <Panel title={t('panels.byAgent')}>
                    {byAgent && byAgent.rows.length > 0 ? (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm" data-testid="costs-by-agent-table">
                                <thead>
                                    <tr className="text-left text-xs text-text-muted dark:text-text-muted-dark border-b border-border dark:border-border-dark">
                                        <th className="py-2 pr-4 font-medium">
                                            {t('byAgent.colAgent')}
                                        </th>
                                        <th className="py-2 pr-4 font-medium text-right">
                                            {t('byAgent.colCost')}
                                        </th>
                                        <th className="py-2 pr-4 font-medium text-right">
                                            {t('byAgent.colRuns')}
                                        </th>
                                        <th className="py-2 font-medium text-right">
                                            {t('byAgent.colAvg')}
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {byAgent.rows.map((row) => (
                                        <tr
                                            key={row.agentId ?? '__unattributed__'}
                                            data-testid="costs-by-agent-row"
                                            className="border-b border-border/60 dark:border-border-dark/60 last:border-0"
                                        >
                                            <td className="py-2 pr-4">
                                                {row.agentId ? (
                                                    <Link
                                                        href={ROUTES.DASHBOARD_AGENT(row.agentId)}
                                                        className="text-primary hover:underline"
                                                    >
                                                        {row.name ?? t('series.unknownAgent')}
                                                    </Link>
                                                ) : (
                                                    <span className="text-text-muted dark:text-text-muted-dark">
                                                        {t('series.unattributed')}
                                                    </span>
                                                )}
                                            </td>
                                            <td className="py-2 pr-4 text-right tabular-nums">
                                                {formatCents(row.costCents)}
                                            </td>
                                            <td className="py-2 pr-4 text-right tabular-nums text-text-muted dark:text-text-muted-dark">
                                                {row.runs}
                                            </td>
                                            <td className="py-2 text-right tabular-nums text-text-muted dark:text-text-muted-dark">
                                                {formatCents(row.avgPerRunCents)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <p
                            className="py-10 text-center text-xs text-text-muted dark:text-text-muted-dark"
                            data-testid="costs-by-agent-empty"
                        >
                            {t('empty')}
                        </p>
                    )}
                </Panel>

                <Panel title={t('panels.byModel')}>
                    <CostsByModelList
                        rows={byModel?.rows ?? []}
                        totalCostCents={byModel?.totalCostCents ?? 0}
                        emptyLabel={t('empty')}
                        noModelLabel={t('series.noModel')}
                        formatUnits={(units) => t('byModel.units', { units })}
                        formatTotal={(total) => t('byModel.total', { total })}
                    />
                </Panel>
            </div>

            {/* ── Most expensive runs ─────────────────────────────── */}
            <Panel title={t('panels.topRuns')}>
                {topRuns && topRuns.rows.length > 0 ? (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm" data-testid="costs-top-runs-table">
                            <thead>
                                <tr className="text-left text-xs text-text-muted dark:text-text-muted-dark border-b border-border dark:border-border-dark">
                                    <th className="py-2 pr-4 font-medium">
                                        {t('topRuns.colCost')}
                                    </th>
                                    <th className="py-2 pr-4 font-medium">
                                        {t('topRuns.colAgent')}
                                    </th>
                                    <th className="py-2 pr-4 font-medium">
                                        {t('topRuns.colTask')}
                                    </th>
                                    <th className="py-2 pr-4 font-medium">
                                        {t('topRuns.colModel')}
                                    </th>
                                    <th className="py-2 pr-4 font-medium">
                                        {t('topRuns.colStarted')}
                                    </th>
                                    <th className="py-2 font-medium">{t('topRuns.colStatus')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {topRuns.rows.map((row) => (
                                    <tr
                                        key={row.runId}
                                        data-testid="costs-top-runs-row"
                                        className="border-b border-border/60 dark:border-border-dark/60 last:border-0"
                                    >
                                        <td className="py-2 pr-4 font-medium tabular-nums">
                                            {formatCents(row.costCents)}
                                        </td>
                                        <td className="py-2 pr-4">
                                            <Link
                                                href={ROUTES.DASHBOARD_AGENT_ACTIVITY(row.agentId)}
                                                className="text-primary hover:underline"
                                                title={t('topRuns.runHint', { runId: row.runId })}
                                            >
                                                {row.agentName ?? t('series.unknownAgent')}
                                            </Link>
                                        </td>
                                        <td className="py-2 pr-4 max-w-[16rem] truncate">
                                            {row.taskId ? (
                                                <Link
                                                    href={ROUTES.DASHBOARD_TASK(row.taskId)}
                                                    className="text-primary hover:underline"
                                                    title={row.taskTitle ?? row.taskId}
                                                >
                                                    {row.taskTitle ?? row.taskId}
                                                </Link>
                                            ) : (
                                                <span className="text-text-muted dark:text-text-muted-dark">
                                                    {t('topRuns.noTask', {
                                                        trigger: row.triggerKind,
                                                    })}
                                                </span>
                                            )}
                                        </td>
                                        <td className="py-2 pr-4 text-text-muted dark:text-text-muted-dark">
                                            {row.modelId ?? t('series.noModel')}
                                        </td>
                                        <td className="py-2 pr-4 whitespace-nowrap text-text-muted dark:text-text-muted-dark">
                                            {row.startedAt
                                                ? new Date(row.startedAt).toLocaleString(
                                                      undefined,
                                                      {
                                                          month: 'short',
                                                          day: 'numeric',
                                                          hour: '2-digit',
                                                          minute: '2-digit',
                                                      },
                                                  )
                                                : '—'}
                                        </td>
                                        <td
                                            className={cn(
                                                'py-2 whitespace-nowrap',
                                                // Only failure gets colour: a run that
                                                // burned money and produced nothing is
                                                // the row a reader is scanning for.
                                                row.status === 'failed'
                                                    ? 'text-danger'
                                                    : 'text-text-muted dark:text-text-muted-dark',
                                            )}
                                        >
                                            {runStatusLabel(row.status)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <p
                        className="py-10 text-center text-xs text-text-muted dark:text-text-muted-dark"
                        data-testid="costs-top-runs-empty"
                    >
                        {t('topRuns.empty')}
                    </p>
                )}
            </Panel>

            {/*
             * Stated, not hidden: the platform records no cached-read
             * tokens, so a cache-hit column would be a fabricated number.
             */}
            <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('cacheHitNote')}</p>
        </div>
    );
}
