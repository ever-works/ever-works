'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import {
    FLEET_USAGE_PRIVACY_SENTENCE,
    type FleetLinkError,
    type FleetUsagePeriodDays,
    type FleetUsageView,
} from '@ever-works/contracts';
import { getFleetUsageAction } from '@/app/actions/fleet/usage';
import type { FleetHubTabProps } from '../registry';
import {
    UsageBusiestCheckouts,
    UsageByComputer,
    UsageByModel,
    UsageCatchingUp,
    UsagePeriodControl,
    UsageSessionsBreakdown,
    UsageTotals,
} from './UsageBlocks';
import { usagePeriodForKey, usagePeriodFrom, usageTabState } from './usage-tab.shared';

type Loaded = { key: string; view: FleetUsageView | null; error: FleetLinkError | null };

/**
 * Usage & cost on the fleet (FL-20 P2, spec §0, §5.1, §5.2, FR-12, FR-13) —
 * the hub's **Usage** tab: Today / 7 / 30 / 90 days (keys 1–4), the totals line
 * with the payer sentence beneath it, by model and by computer (each line a
 * filter), busiest checkouts, the sessions breakdown including **other**, the
 * catching-up line.
 * An offline computer keeps its numbers and its scan age; a computer with
 * the scan off shows the opt-in command and no numbers. Registered on the
 * server (`modules/fl-20-usage.server.ts`) behind `FLEET_USAGE_SCAN_ENABLED`.
 */
export default function UsagePanel({ nodes }: FleetHubTabProps) {
    const t = useTranslations('fleet.usage.tab');
    const search = useSearchParams();
    const [days, setDays] = useState<FleetUsagePeriodDays>(() => usagePeriodFrom(search?.get('days')));
    const [node, setNode] = useState<string | null>(() => search?.get('node') || null);
    const [model, setModel] = useState<string | null>(() => search?.get('model') || null);
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const key = `${days}|${node ?? ''}|${model ?? ''}`;

    useEffect(() => {
        let cancelled = false;
        getFleetUsageAction({ days, node, model })
            .then((result) => {
                if (cancelled) return;
                setLoaded(result.ok ? { key, view: result.data, error: null } : { key, view: null, error: result.error });
            })
            .catch(() => {
                if (!cancelled) setLoaded({ key, view: null, error: { code: 'internal', hint: '' } });
            });
        return () => {
            cancelled = true;
        };
    }, [key, days, node, model]);

    const onKey = useCallback((event: KeyboardEvent) => {
        const target = event.target as HTMLElement | null;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
        const period = usagePeriodForKey(event.key);
        if (period) setDays(period);
    }, []);
    useEffect(() => {
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onKey]);

    const current = loaded && loaded.key === key ? loaded : null;
    const view = current?.view ?? null;
    const nodeName = node ? (nodes.find((entry) => entry.id === node)?.name ?? node) : null;

    return (
        <div className="space-y-4 p-4" data-testid="fleet-usage-panel">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <UsagePeriodControl days={days} onChange={setDays} />
                <div className="flex flex-wrap items-center gap-2 text-xs">
                    {nodeName && (
                        <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-full border border-border dark:border-border-dark px-2 py-0.5"
                            onClick={() => setNode(null)}
                        >
                            {t('filterComputer', { computer: nodeName })} <X className="w-3 h-3" aria-label={t('clearFilter')} />
                        </button>
                    )}
                    {model && (
                        <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-full border border-border dark:border-border-dark px-2 py-0.5"
                            onClick={() => setModel(null)}
                        >
                            {t('filterModel', { model })} <X className="w-3 h-3" aria-label={t('clearFilter')} />
                        </button>
                    )}
                </div>
            </div>

            {!current ? (
                <div className="space-y-3" aria-busy="true" data-testid="fleet-usage-loading">
                    <div className="h-5 w-2/3 rounded bg-border/60 dark:bg-border-dark/60 animate-pulse" />
                    <div className="grid gap-3 md:grid-cols-2">
                        <div className="h-32 rounded-lg bg-border/40 dark:bg-border-dark/40 animate-pulse" />
                        <div className="h-32 rounded-lg bg-border/40 dark:bg-border-dark/40 animate-pulse" />
                    </div>
                </div>
            ) : current.error ? (
                <p role="alert" className="text-sm" data-testid="fleet-usage-error">
                    <span className="font-mono text-xs">{current.error.code}</span>
                    {current.error.hint ? ` — ${current.error.hint}` : ` — ${t('failed')}`}
                </p>
            ) : view && usageTabState(view) === 'empty' ? (
                <div className="rounded-lg border border-dashed border-border dark:border-border-dark p-6 text-sm space-y-2" data-testid="fleet-usage-empty">
                    <p className="font-medium">{t('empty.title')}</p>
                    <p>
                        {t('empty.command')} <code className="font-mono text-xs">ever-works-node start --usage-scan</code>
                    </p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('empty.promise', { sentence: FLEET_USAGE_PRIVACY_SENTENCE })}
                    </p>
                    <UsageByComputer view={view} nodes={nodes} onNode={setNode} now={Date.now()} />
                </div>
            ) : view ? (
                <>
                    <UsageTotals view={view} />
                    <UsageCatchingUp view={view} />
                    <div className="grid gap-3 md:grid-cols-2">
                        <UsageByModel view={view} onModel={setModel} />
                        <UsageByComputer view={view} nodes={nodes} onNode={setNode} now={Date.now()} />
                    </div>
                    <UsageBusiestCheckouts view={view} />
                    <UsageSessionsBreakdown view={view} />
                </>
            ) : null}
        </div>
    );
}
