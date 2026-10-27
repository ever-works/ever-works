'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle, Laptop } from 'lucide-react';
import type { AgentActionProposal } from '@/lib/api/agent-approvals';
import { formatFleetDecisionExpiry, readFleetActionDecision } from './fleet-action-decision.shared';

/**
 * My Decisions — a held fleet action (FL-19 P2, spec §5.2):
 *
 *   ┌ Nina wants to restart nginx (services) ───────────────────────────────┐
 *   │ Change a computer · Ask                                                │
 *   │ ⚠ This restarts the web server Ever Works connects through on build-01.│
 *   │ expires in 23 h 58 m                                                   │
 *   └────────────────────────────────────────────────────────────────────────┘
 *
 * The title row and the Approve / Refuse buttons are the queue's own; this is
 * the body under the title. Model-supplied argument values are rendered as
 * text, never as markup.
 */
export function FleetActionDecisionCard({ proposal }: { proposal: AgentActionProposal }) {
    const t = useTranslations('fleet.tools.decision');
    const view = readFleetActionDecision(proposal.payload, proposal.createdAt);
    if (!view) return null;

    const category = view.category ? t(`categories.${categoryKey(view.category)}` as never) : null;
    const rung =
        view.rung === 'ask' || view.rung === 'draft' ? t(`rungs.${view.rung}` as never) : null;
    const expiry = view.expiresInMs === null ? null : formatFleetDecisionExpiry(view.expiresInMs);

    return (
        <div
            className="mt-2 space-y-1 text-xs text-text-secondary dark:text-text-secondary-dark"
            data-testid={`approval-fleet-action-${proposal.id}`}
        >
            {(category || rung) && (
                <p className="flex items-center gap-1.5">
                    <Laptop className="w-3.5 h-3.5 shrink-0" />
                    {[category, rung].filter(Boolean).join(' · ')}
                </p>
            )}
            {view.sentence && (
                <p
                    className="flex items-start gap-1.5 text-warning"
                    data-testid={`approval-fleet-sentence-${proposal.id}`}
                >
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>{view.sentence}</span>
                </p>
            )}
            {view.reason && !view.sentence && (
                <p>{t(`reasons.${reasonKey(view.reason)}` as never)}</p>
            )}
            {expiry &&
                (view.expiresInMs !== null && view.expiresInMs <= 0 ? (
                    <p
                        className="text-danger"
                        data-testid={`approval-fleet-expired-${proposal.id}`}
                    >
                        {t('expired')}
                    </p>
                ) : (
                    <p>{t('expiresIn', { hours: expiry.hours, minutes: expiry.minutes })}</p>
                ))}
            {view.args.length > 0 && (
                <details>
                    <summary className="cursor-pointer">
                        {t('details', { tool: view.tool ?? '' })}
                    </summary>
                    <dl className="mt-1 grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 font-mono">
                        {view.args.map(([key, value]) => (
                            <div key={key} className="contents">
                                <dt className="text-text-muted dark:text-text-muted-dark">{key}</dt>
                                <dd className="break-all">{value}</dd>
                            </div>
                        ))}
                    </dl>
                </details>
            )}
        </div>
    );
}

/** `machine.admin` → `machineAdmin` (i18n leaves are camelCase). */
function categoryKey(category: string): string {
    const known = [
        'machine.admin',
        'machine.run',
        'write.destructive',
        'write.internal',
        'agent.fanout',
        'publish.external',
        'spend.metered',
    ];
    if (!known.includes(category)) return 'other';
    return category.replace(/\.([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function reasonKey(reason: string): string {
    const known = ['blast-radius', 'kill', 'destructive', 'run'];
    if (!known.includes(reason)) return 'other';
    return reason.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}
