'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Coins } from 'lucide-react';
import type { FleetLinkError, FleetUsageView } from '@ever-works/contracts';
import { getFleetUsageAction } from '@/app/actions/fleet/usage';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { FleetOverviewBlockProps } from '../registry';
import { UsagePayerNote } from './UsagePayerNote';
import { computerUsageLineState } from './usage.shared';

type Loaded = { nodeId: string; view: FleetUsageView | null; error: FleetLinkError | null };

/**
 * Usage & cost on the fleet (FL-20, spec FR-14, §5.5, S1, U1, U2, U3) — the
 * computer page Overview's usage line: "Usage 7 d · $22.10 · scan on · last
 * scan 4 min ago", linking to the hub's Usage tab filtered to this computer;
 * the opt-in command when the machine's owner has not switched the scan on;
 * "update the node" when it is too old to scan. Behind
 * `FLEET_USAGE_SCAN_ENABLED` (the block's registration flag).
 */
export default function ComputerOverviewUsageLine({ nodes }: FleetOverviewBlockProps) {
    const t = useTranslations('fleet.usage.overview');
    const node = nodes.length === 1 ? nodes[0] : null;
    const nodeId = node?.id ?? null;
    const [loaded, setLoaded] = useState<Loaded | null>(null);

    useEffect(() => {
        if (!nodeId) return;
        let cancelled = false;
        getFleetUsageAction({ days: 7, node: nodeId })
            .then((result) => {
                if (cancelled) return;
                setLoaded(
                    result.ok
                        ? { nodeId, view: result.data, error: null }
                        : { nodeId, view: null, error: result.error },
                );
            })
            .catch(() => {
                if (!cancelled) setLoaded({ nodeId, view: null, error: { code: 'internal', hint: '' } });
            });
        return () => {
            cancelled = true;
        };
    }, [nodeId]);

    if (!node) return null;
    const current = loaded && loaded.nodeId === node.id ? loaded : null;
    let body: React.ReactNode;
    if (!current) {
        body = <span className="text-text-muted">{t('loading')}</span>;
    } else if (current.error) {
        const code = current.error.code;
        body =
            code === 'consent_missing' || code === 'unsupported_on_node' ? (
                <span data-testid="fleet-usage-line-hint">
                    {current.error.hint ||
                        (code === 'consent_missing' ? t('off', { computer: node.name }) : t('unsupported', { computer: node.name }))}
                </span>
            ) : (
                <span className="text-text-muted">{t('error', { hint: current.error.hint || code })}</span>
            );
    } else if (current.view) {
        const line = current.view.byNode.find((entry) => entry.nodeId === node.id) ?? current.view.byNode[0] ?? null;
        const state = computerUsageLineState(line?.scan ?? null, current.view.totals.costCents, Date.now());
        if (state.kind === 'off') body = <span>{line?.scan.hint ?? t('off', { computer: node.name })}</span>;
        else if (state.kind === 'unsupported') body = <span>{t('unsupported', { computer: node.name })}</span>;
        else {
            const cost = state.cost ?? t('tokensOnly');
            body = (
                <span className="tabular-nums" data-testid="fleet-usage-line">
                    {state.age ? t('line', { cost, age: state.age }) : t('lineNoScan', { cost })}
                    {!state.online && <span className="text-text-muted"> · {t('offline')}</span>}
                    {state.scannedPct !== null && (
                        <span className="text-text-muted"> · {t('catchingUp', { pct: state.scannedPct })}</span>
                    )}{' '}
                    <Link
                        href={`${ROUTES.DASHBOARD_FLEET_USAGE}?node=${encodeURIComponent(node.id)}`}
                        className="underline-offset-2 hover:underline"
                    >
                        {t('open')}
                    </Link>
                </span>
            );
        }
    }

    return (
        <section
            className="rounded-lg border border-border dark:border-border-dark p-4 text-sm space-y-1"
            aria-label={t('title')}
            data-testid="fleet-usage-overview-line"
        >
            <p className="flex flex-wrap items-center gap-1.5">
                <Coins className="w-4 h-4 shrink-0" aria-hidden />
                {body}
            </p>
            {current?.view && <UsagePayerNote />}
        </section>
    );
}
