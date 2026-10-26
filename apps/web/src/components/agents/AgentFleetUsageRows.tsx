'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { FleetLinkError, FleetUsageView } from '@ever-works/contracts';
import { getFleetUsageAction } from '@/app/actions/fleet/usage';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { UsagePayerNote } from '@/components/fleet/usage/UsagePayerNote';
import { usageMoney } from '@/components/fleet/usage/usage.shared';

/**
 * Usage & cost on the fleet (FL-20 P2, spec FR-14, FR-15, §5.5) — the Agent
 * page's Budgets tab: one row per computer with what this Agent's sessions and
 * Task runs there would cost at list price over the last 30 days. The Budget
 * figure above already includes it (one non-debiting `fleet-node:` row per
 * Run); these rows say where it came from, labelled list price. Rendered only
 * while `FLEET_USAGE_SCAN_ENABLED` is on (the page passes the flag).
 */
export function AgentFleetUsageRows({ agentId }: { agentId: string }) {
    const t = useTranslations('fleet.usage.agent');
    const [state, setState] = useState<{ view: FleetUsageView | null; error: FleetLinkError | null } | null>(null);

    useEffect(() => {
        let cancelled = false;
        getFleetUsageAction({ days: 30, agent: agentId })
            .then((result) => {
                if (!cancelled) setState(result.ok ? { view: result.data, error: null } : { view: null, error: result.error });
            })
            .catch(() => {
                if (!cancelled) setState({ view: null, error: { code: 'internal', hint: '' } });
            });
        return () => {
            cancelled = true;
        };
    }, [agentId]);

    if (!state) return null;
    const rows = state.view?.byNode.filter((line) => line.scan.state === 'on' && (line.requests > 0 || line.costCents)) ?? [];
    return (
        <section
            className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-2"
            aria-labelledby="agent-fleet-usage-title"
            data-testid="agent-fleet-usage-rows"
        >
            <h3 id="agent-fleet-usage-title" className="text-sm font-medium text-text dark:text-text-dark">
                {t('title')}
            </h3>
            {state.error ? (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('error', { hint: state.error.hint || state.error.code })}</p>
            ) : rows.length === 0 ? (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('none')}</p>
            ) : (
                <ul className="divide-y divide-border/60 dark:divide-border-dark/60">
                    {rows.map((line) => (
                        <li key={line.nodeId} className="flex items-center justify-between gap-3 py-1.5 text-sm tabular-nums">
                            <Link href={`${ROUTES.DASHBOARD_FLEET_USAGE}?node=${encodeURIComponent(line.nodeId)}&days=30`} className="hover:underline">
                                {line.name}
                            </Link>
                            <span>{t('row', { cost: usageMoney(line.costCents) ?? t('tokensOnly'), requests: line.requests })}</span>
                        </li>
                    ))}
                </ul>
            )}
            <UsagePayerNote />
        </section>
    );
}
