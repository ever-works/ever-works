'use client';

import { useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { AlertTriangle, Laptop } from 'lucide-react';
import { toast } from 'sonner';
import { Select } from '@/components/ui/select';
import { ROUTES } from '@/lib/constants';
import { runnerDotClass } from '@/components/dashboard/runner-status.shared';
import {
    clearFleetAgentAffinityAction,
    setFleetAgentAffinityAction,
} from '@/app/actions/settings/fleet';
import {
    describeAccountExecutionPreference,
    preferredNodeState,
    selectableFleetNodes,
    type AgentFleetData,
} from './agent-fleet.shared';

interface Props {
    agentId: string;
    fleet: AgentFleetData;
    /** Outer `<section>` class — the Capabilities page owns the card style. */
    className?: string;
}

/** The picker value for "unbound": the `Select` needs a string. */
const ANY_NODE = '';

/**
 * Capabilities tab — Execution section: WHERE this Agent's work runs.
 *
 * Two facts, one place, because they only make sense together:
 *
 *   1. **Preferred node** — the Agent-to-node affinity
 *      (`PUT/DELETE /api/fleet/agents/:id/node-affinity`). Bound, the
 *      Agent's `agent-task` jobs are leased ONLY by that machine, which
 *      is the right answer when the work needs what is on it (a
 *      checkout, a credential, a GPU) and the wrong one when it is
 *      merely the nearest laptop. The hint under the picker exists for
 *      the second case: a binding to a machine that is offline or
 *      drained does not fail, it WAITS, and nothing else on the page
 *      would say so.
 *   2. **Execution routing** — the account-wide fleet-vs-cloud rule,
 *      read-only. It is edited on the Fleet settings page (with the
 *      Work / Goal overrides listed next to it); repeating the editor
 *      here would be a second writer of the same row. What the Agent
 *      page owes the operator is the ANSWER, and a link to where it is
 *      changed.
 *
 * Policy — which nodes are offerable, what a status means, which row
 * is in force — lives in `agent-fleet.shared.ts`; this file is layout.
 */
export function AgentFleetSection({ agentId, fleet, className }: Props) {
    const t = useTranslations('dashboard.agentsPage.capabilities.fleet');
    // Node statuses and routing-mode wording are the Fleet settings
    // page's strings, reused so the two surfaces can never disagree
    // about what "Paused" or "Local runner" means.
    const tFleet = useTranslations('dashboard.settings.fleet');

    const nodes = useMemo(() => selectableFleetNodes(fleet.nodes), [fleet.nodes]);
    const [nodeId, setNodeId] = useState<string | null>(
        fleet.affinity.available ? fleet.affinity.nodeId : null,
    );
    // Same in-flight discipline as the environment picker: `saving` is
    // the real busy marker, not the transition's `pending`.
    const [saving, setSaving] = useState(false);
    const [, startTransition] = useTransition();

    const state = preferredNodeState(nodeId, nodes);
    const routing = fleet.preferences
        ? describeAccountExecutionPreference(fleet.preferences)
        : null;

    const pickNode = (value: string) => {
        const next = value === ANY_NODE ? null : value;
        if (saving || next === nodeId) return;
        const previous = nodeId;
        setNodeId(next);
        setSaving(true);
        startTransition(() => {
            void (async () => {
                try {
                    const result = next
                        ? await setFleetAgentAffinityAction(agentId, next)
                        : await clearFleetAgentAffinityAction(agentId);
                    if (result.success) {
                        toast.success(next ? t('saved') : t('cleared'));
                    } else {
                        setNodeId(previous);
                        toast.error(result.error);
                    }
                } finally {
                    setSaving(false);
                }
            })();
        });
    };

    const hint =
        state.kind === 'missing'
            ? t('hintMissing')
            : state.kind === 'node' && state.availability === 'offline'
              ? t('hintOffline', { name: state.node.name })
              : state.kind === 'node' && state.availability === 'draining'
                ? t('hintDraining', { name: state.node.name })
                : null;

    return (
        <section className={className} data-testid="capabilities-fleet-section">
            <div className="p-4 border-b border-border/40 dark:border-border-dark/40 flex items-start justify-between gap-4">
                <div>
                    <h3 className="text-sm font-medium text-text dark:text-text-dark flex items-center gap-2">
                        <Laptop className="w-4 h-4 text-primary" />
                        {t('title')}
                    </h3>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1 max-w-2xl">
                        {t('description')}
                    </p>
                </div>
                <Link
                    href={ROUTES.DASHBOARD_SETTINGS_FLEET}
                    className="text-xs text-primary hover:underline shrink-0"
                    data-testid="capabilities-manage-fleet"
                >
                    {t('manage')}
                </Link>
            </div>

            <div className="p-4 grid gap-6 lg:grid-cols-2">
                {/* ── Preferred node ── */}
                <div className="space-y-1.5" data-testid="capabilities-fleet-node-block">
                    <label
                        className="block text-sm font-medium text-text dark:text-text-dark"
                        htmlFor="capabilities-fleet-node"
                    >
                        {t('nodeLabel')}
                    </label>
                    {nodes.length === 0 ? (
                        <div
                            className="text-xs text-text-muted dark:text-text-muted-dark space-y-1"
                            data-testid="capabilities-fleet-no-nodes"
                        >
                            <p>{t('noNodes')}</p>
                            <Link
                                href={ROUTES.DASHBOARD_SETTINGS_FLEET}
                                className="text-primary hover:underline"
                                data-testid="capabilities-fleet-enroll-link"
                            >
                                {t('noNodesLink')}
                            </Link>
                        </div>
                    ) : !fleet.affinity.available ? (
                        <p
                            className="text-xs text-text-muted dark:text-text-muted-dark"
                            data-testid="capabilities-fleet-affinity-unavailable"
                        >
                            {fleet.affinity.reason === 'personal-scope'
                                ? t('affinityPersonalScope')
                                : t('affinityUnavailable')}
                        </p>
                    ) : (
                        <>
                            <Select
                                id="capabilities-fleet-node"
                                value={nodeId ?? ANY_NODE}
                                onValueChange={pickNode}
                                disabled={saving}
                                data-testid="capabilities-fleet-node"
                            >
                                <option value={ANY_NODE}>{t('anyNode')}</option>
                                {nodes.map((node) => (
                                    <option
                                        key={node.id}
                                        value={node.id}
                                        data-dot={runnerDotClass(node.status)}
                                    >
                                        {node.name} · {node.platform ?? '-'} ·{' '}
                                        {tFleet(`statuses.${node.status}` as never)}
                                    </option>
                                ))}
                                {state.kind === 'missing' && (
                                    // Keep the stored id selectable so the
                                    // trigger names the situation instead of
                                    // silently showing "Any node" for a
                                    // binding that is still in force.
                                    <option value={state.nodeId}>{t('missingNode')}</option>
                                )}
                            </Select>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('nodeHelper')}
                            </p>
                            {hint && (
                                <p
                                    className="flex items-start gap-1.5 text-xs text-warning"
                                    data-testid="capabilities-fleet-node-hint"
                                >
                                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                    <span>{hint}</span>
                                </p>
                            )}
                        </>
                    )}
                </div>

                {/* ── Execution routing (read-only) ── */}
                <div className="space-y-1.5" data-testid="capabilities-fleet-routing">
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {t('routingLabel')}
                    </p>
                    {routing ? (
                        <>
                            <p
                                className="text-sm text-text dark:text-text-dark"
                                data-testid="capabilities-fleet-routing-mode"
                            >
                                {tFleet(`routing.modes.${routing.mode}.label` as never)}
                            </p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {tFleet(`routing.modes.${routing.mode}.helper` as never)}
                            </p>
                            <p
                                className="text-xs text-text-muted dark:text-text-muted-dark"
                                data-testid="capabilities-fleet-routing-source"
                            >
                                {routing.configured
                                    ? t('routingAccountDefault')
                                    : t('routingPlatformDefault')}
                            </p>
                            {routing.overrideCount > 0 && (
                                <p
                                    className="text-xs text-text-muted dark:text-text-muted-dark"
                                    data-testid="capabilities-fleet-routing-overrides"
                                >
                                    {t('routingOverrides', { count: routing.overrideCount })}
                                </p>
                            )}
                        </>
                    ) : (
                        <p
                            className="text-xs text-text-muted dark:text-text-muted-dark"
                            data-testid="capabilities-fleet-routing-unavailable"
                        >
                            {t('routingUnavailable')}
                        </p>
                    )}
                    <Link
                        href={ROUTES.DASHBOARD_SETTINGS_FLEET}
                        className="inline-block text-xs text-primary hover:underline"
                        data-testid="capabilities-fleet-routing-link"
                    >
                        {t('routingChange')}
                    </Link>
                </div>
            </div>
        </section>
    );
}
