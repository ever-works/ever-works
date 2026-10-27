'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { RefreshCw } from 'lucide-react';
import {
    FLEET_USAGE_PERIODS,
    type FleetNodeView,
    type FleetUsagePeriodDays,
    type FleetUsageView,
} from '@ever-works/contracts';
import { rescanFleetUsageAction } from '@/app/actions/fleet/usage';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { UsagePayerNote } from './UsagePayerNote';
import { usageAge, usageMoney, usageTokens, usageTotalTokens } from './usage.shared';
import { usageExclusionNotes, usagePeriodKey, usagePriceListLine } from './usage-tab.shared';

/**
 * Usage & cost on the fleet (FL-20 P2, spec §0, §5.1) — the blocks of the
 * hub's Usage tab: the period control, the totals line (with the payer
 * sentence right beneath it), by model, by computer, busiest checkouts and
 * the sessions breakdown. Each renders from the one `FleetUsageView`.
 */

const card = 'rounded-lg border border-border dark:border-border-dark p-4 text-sm space-y-2';
const muted = 'text-xs text-text-muted dark:text-text-muted-dark';

export function UsagePeriodControl({
    days,
    onChange,
}: {
    days: FleetUsagePeriodDays;
    onChange: (days: FleetUsagePeriodDays) => void;
}) {
    const t = useTranslations('fleet.usage.tab');
    return (
        <div
            role="radiogroup"
            aria-label={t('periodLabel')}
            className="inline-flex rounded-md border border-border dark:border-border-dark"
        >
            {FLEET_USAGE_PERIODS.map((period, index) => (
                <button
                    key={period}
                    type="button"
                    role="radio"
                    aria-checked={period === days}
                    aria-keyshortcuts={String(index + 1)}
                    onClick={() => onChange(period)}
                    className={cn(
                        'px-3 py-1 text-xs first:rounded-l-md last:rounded-r-md',
                        period === days
                            ? 'bg-primary/10 font-medium text-text dark:text-text-dark'
                            : muted,
                    )}
                    data-testid={`fleet-usage-period-${period}`}
                >
                    {t(`periods.${usagePeriodKey(period)}`)}
                </button>
            ))}
        </div>
    );
}

export function UsageTotals({ view }: { view: FleetUsageView }) {
    const t = useTranslations('fleet.usage.tab');
    const cost = usageMoney(view.totals.costCents);
    const price = usagePriceListLine(view);
    return (
        <section className="space-y-1" data-testid="fleet-usage-totals">
            <p className="text-base font-medium text-text dark:text-text-dark tabular-nums">
                {t('totals', {
                    cost: cost ?? t('tokensOnly'),
                    tokens: usageTokens(usageTotalTokens(view.totals.tokens)),
                    requests: view.totals.requests,
                })}
                {view.totals.topModel ? ` · ${t('topModel', { model: view.totals.topModel })}` : ''}
            </p>
            <UsagePayerNote />
            {view.unknownModels.requests > 0 && (
                <p className={muted} data-testid="fleet-usage-unknown-models">
                    {t('unknownModels', {
                        count: view.unknownModels.requests,
                        models: view.unknownModels.models.join(', '),
                    })}
                </p>
            )}
            {usageExclusionNotes(view).map((note) => (
                <p key={note.key} className={muted}>
                    {t(note.key, note.values ?? {})}
                </p>
            ))}
            <p className={muted}>{t(price.key, price.values)}</p>
        </section>
    );
}

export function UsageCatchingUp({ view }: { view: FleetUsageView }) {
    const t = useTranslations('fleet.usage.tab');
    if (!view.catchingUp) return null;
    return (
        <div className="space-y-1" data-testid="fleet-usage-catching-up">
            <div className="h-1 w-full rounded bg-border/60 dark:bg-border-dark/60">
                <div
                    className="h-1 rounded bg-primary"
                    style={{ width: `${view.catchingUp.scannedPct}%` }}
                />
            </div>
            <p className={muted}>
                {t('catchingUp', {
                    pct: view.catchingUp.scannedPct,
                    computer: view.catchingUp.nodeName,
                })}
            </p>
        </div>
    );
}

export function UsageByModel({
    view,
    onModel,
}: {
    view: FleetUsageView;
    onModel: (model: string) => void;
}) {
    const t = useTranslations('fleet.usage.tab');
    return (
        <section
            className={card}
            aria-labelledby="fleet-usage-by-model"
            data-testid="fleet-usage-by-model"
        >
            <h3 id="fleet-usage-by-model" className="font-medium">
                {t('byModel')}
            </h3>
            {view.byModel.length === 0 ? (
                <p className={muted}>{t('nothingYet')}</p>
            ) : (
                <ul className="space-y-1">
                    {view.byModel.map((line) => (
                        <li
                            key={line.model}
                            className="flex items-center justify-between gap-3 tabular-nums"
                        >
                            <button
                                type="button"
                                className="min-w-0 truncate text-left font-mono text-xs hover:underline"
                                onClick={() => onModel(line.model)}
                            >
                                {line.costCents === null
                                    ? t('unknownModel', { model: line.model })
                                    : line.model}
                            </button>
                            <span className="shrink-0 text-xs">
                                {t('requests', { count: line.requests })} ·{' '}
                                {usageMoney(line.costCents) ?? t('tokensOnly')}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

function NodeRescan({ nodeId }: { nodeId: string }) {
    const t = useTranslations('fleet.usage.tab');
    const [state, setState] = useState<{ busy: boolean; message: string | null }>({
        busy: false,
        message: null,
    });
    return (
        <span className="inline-flex items-center gap-1">
            <button
                type="button"
                className={cn(muted, 'inline-flex items-center gap-1 hover:underline')}
                disabled={state.busy}
                onClick={() => {
                    setState({ busy: true, message: null });
                    void rescanFleetUsageAction(nodeId).then((result) =>
                        setState({
                            busy: false,
                            message: result.ok
                                ? t('rescanQueued')
                                : result.error.hint || result.error.code,
                        }),
                    );
                }}
            >
                <RefreshCw className={cn('w-3 h-3', state.busy && 'animate-spin')} aria-hidden />
                {t('rescan')}
            </button>
            {state.message && <span className={muted}>{state.message}</span>}
        </span>
    );
}

export function UsageByComputer({
    view,
    nodes,
    onNode,
    now,
}: {
    view: FleetUsageView;
    nodes: FleetNodeView[];
    onNode: (nodeId: string) => void;
    now: number;
}) {
    const t = useTranslations('fleet.usage.tab');
    const roles = new Map(nodes.map((node) => [node.id, node.viewerRole ?? 'owner']));
    return (
        <section
            className={card}
            aria-labelledby="fleet-usage-by-computer"
            data-testid="fleet-usage-by-computer"
        >
            <h3 id="fleet-usage-by-computer" className="font-medium">
                {t('byComputer')}
            </h3>
            <ul className="space-y-1">
                {view.byNode.map((line) => {
                    const age = usageAge(line.scan.lastScanAt, now);
                    const scan =
                        line.scan.state === 'on'
                            ? [
                                  line.scan.online ? null : t('offline'),
                                  age ? t('scannedAgo', { age }) : t('noScanYet'),
                              ]
                                  .filter(Boolean)
                                  .join(' · ')
                            : (line.scan.hint ?? t('scanOff'));
                    return (
                        <li
                            key={line.nodeId}
                            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5"
                            data-testid="fleet-usage-node-line"
                        >
                            <button
                                type="button"
                                className="font-medium hover:underline"
                                onClick={() => onNode(line.nodeId)}
                            >
                                {line.name}
                            </button>
                            <span className="text-xs tabular-nums">
                                {line.scan.state === 'on'
                                    ? (usageMoney(line.costCents) ?? t('tokensOnly'))
                                    : '—'}
                            </span>
                            <span className={cn(muted, 'w-full')}>
                                {scan}{' '}
                                {line.scan.state === 'on' &&
                                    line.scan.online &&
                                    roles.get(line.nodeId) === 'owner' && (
                                        <NodeRescan nodeId={line.nodeId} />
                                    )}
                            </span>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}

export function UsageBusiestCheckouts({ view }: { view: FleetUsageView }) {
    const t = useTranslations('fleet.usage.tab');
    if (view.busiestCheckouts.length === 0) return null;
    return (
        <p className="text-sm" data-testid="fleet-usage-checkouts">
            <span className="font-medium">{t('busiestCheckouts')}</span>{' '}
            {view.busiestCheckouts.map((line, index) => (
                <span key={`${line.nodeId}:${line.path ?? ''}`}>
                    {index > 0 && ' · '}
                    {line.path ? (
                        <Link
                            href={ROUTES.DASHBOARD_FLEET_COMPUTER(line.nodeId, 'checkouts')}
                            className="font-mono text-xs hover:underline"
                        >
                            {line.path}
                        </Link>
                    ) : (
                        <span className="text-xs">{t('otherFolders')}</span>
                    )}{' '}
                    <span className={muted}>
                        {t('onComputer', { computer: line.nodeName })}{' '}
                        {usageMoney(line.costCents) ?? t('tokensOnly')}
                    </span>
                </span>
            ))}
        </p>
    );
}

export function UsageSessionsBreakdown({ view }: { view: FleetUsageView }) {
    const t = useTranslations('fleet.usage.tab');
    const parts: string[] = view.sessions.agents.map((agent) =>
        t('agentSessions', { name: agent.name ?? t('unknownAgent'), count: agent.sessions }),
    );
    if (view.sessions.owner.sessions > 0)
        parts.push(t('ownerSessions', { count: view.sessions.owner.sessions }));
    if (view.sessions.other)
        parts.push(t('otherSessions', { count: view.sessions.other.sessions }));
    else parts.push(t('otherNotShown'));
    return (
        <p className="text-sm" data-testid="fleet-usage-sessions">
            <span className="font-medium">{t('sessions')}</span> {parts.join(' · ')}
        </p>
    );
}
