'use client';

import { useMemo, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import { Check, ShieldCheck, X } from 'lucide-react';
import { ROUTES } from '@/lib/constants';
import {
    agentFleetToolsHasComputers,
    agentFleetToolsRows,
    fleetToolsGateMessageKey,
    type AgentFleetToolsData,
    type AgentFleetToolsRow,
} from './agent-fleet-tools.shared';

interface Props {
    agentName: string;
    data: AgentFleetToolsData;
    /** Outer `<section>` class — the Capabilities page owns the card style. */
    className?: string;
}

/**
 * Agent › Capabilities › Fleet tools (FL-19, spec FR-24, §5.1).
 *
 * One row per fleet tool family: may this Agent read there, may it act (and
 * at which trust-ladder rung), and when not, which gate refuses — its tool
 * grants, its trust ladder, the fleet stop switch, or a computer's owner — with
 * a link to where that is changed. Per-computer refusals ("build-02 ✗ owner
 * allows only owner") are listed under the row.
 *
 * States: hidden when Fleet is off (`data === null`); an error card with
 * Retry; "You have no computers yet" with Add computer; the table otherwise.
 * The facts are composed by the API (`GET /api/fleet/tools/gate`); what a row
 * shows is decided in `agent-fleet-tools.shared.ts`.
 */
export function AgentFleetToolsSection({ agentName, data, className }: Props) {
    const t = useTranslations('fleet.tools.capabilities');
    const router = useRouter();
    const [retrying, startRetry] = useTransition();

    const view = data?.kind === 'ready' ? data.view : null;
    const rows = useMemo<AgentFleetToolsRow[]>(() => (view ? agentFleetToolsRows(view) : []), [view]);

    if (data === null) return null;

    const header = (
        <div className="p-4 border-b border-border/40 dark:border-border-dark/40">
            <h3 className="text-sm font-medium text-text dark:text-text-dark flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-primary" />
                {t('title')}
            </h3>
            <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1 max-w-2xl">
                {t('description', { agent: agentName })}
            </p>
        </div>
    );

    if (data.kind === 'error') {
        return (
            <section className={className} data-testid="capabilities-fleet-tools-section">
                {header}
                <div className="p-4 flex items-center justify-between gap-4" data-testid="capabilities-fleet-tools-error">
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('error', { agent: agentName })}</p>
                    <button
                        type="button"
                        className="text-xs text-primary hover:underline disabled:opacity-50"
                        disabled={retrying}
                        onClick={() => startRetry(() => router.refresh())}
                    >
                        {t('retry')}
                    </button>
                </div>
            </section>
        );
    }

    const hasComputers = view ? agentFleetToolsHasComputers(view) : false;

    return (
        <section className={className} data-testid="capabilities-fleet-tools-section">
            {header}
            {view?.killSwitch && (
                <p className="px-4 pt-3 text-xs text-warning" data-testid="capabilities-fleet-tools-stopped">
                    {t('stopped')}
                </p>
            )}
            {!hasComputers ? (
                <div className="p-4 text-xs text-text-muted dark:text-text-muted-dark space-y-1" data-testid="capabilities-fleet-tools-empty">
                    <p>{t('empty')}</p>
                    <Link href={ROUTES.DASHBOARD_SETTINGS_FLEET} className="text-primary hover:underline">
                        {t('addComputer')}
                    </Link>
                </div>
            ) : (
                <div className="p-4 overflow-x-auto">
                    <table className="w-full text-sm" data-testid="capabilities-fleet-tools-table">
                        <thead>
                            <tr className="text-left text-xs text-text-muted dark:text-text-muted-dark">
                                <th className="py-1 pr-4 font-medium">{t('columns.family')}</th>
                                <th className="py-1 pr-4 font-medium">{t('columns.read')}</th>
                                <th className="py-1 pr-4 font-medium">{t('columns.act')}</th>
                                <th className="py-1 font-medium">{t('columns.whyNot')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row) => (
                                <FleetToolsRow key={row.family} row={row} />
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            <p className="px-4 pb-4 text-xs text-text-muted dark:text-text-muted-dark">
                {t('noCredential', { agent: agentName })}
            </p>
        </section>
    );
}

function FleetToolsRow({ row }: { row: AgentFleetToolsRow }) {
    const t = useTranslations('fleet.tools.capabilities');
    const refusedComputers = row.computers.filter((computer) => !computer.allowed);
    return (
        <tr className="border-t border-border/30 dark:border-border-dark/30 align-top" data-testid={`capabilities-fleet-tools-row-${row.family}`}>
            <td className="py-2 pr-4 text-text dark:text-text-dark">{t(`families.${row.family}` as never)}</td>
            <td className="py-2 pr-4">
                {row.comingSoon ? (
                    <span className="text-xs text-text-muted dark:text-text-muted-dark">{t('comingSoon')}</span>
                ) : row.read ? (
                    <Check className="w-4 h-4 text-success" aria-label={t('yes')} />
                ) : (
                    <X className="w-4 h-4 text-danger" aria-label={t('no')} />
                )}
            </td>
            <td className="py-2 pr-4 text-xs">
                {row.act.kind === 'none' ? (
                    <span className="text-text-muted dark:text-text-muted-dark">—</span>
                ) : row.act.kind === 'rung' ? (
                    <span className="inline-flex items-center gap-1 text-text dark:text-text-dark">
                        <Check className="w-3.5 h-3.5 text-success" />
                        {t(`rungs.${row.act.rung}` as never)}
                    </span>
                ) : (
                    <span className="inline-flex items-center gap-1 text-danger">
                        <X className="w-3.5 h-3.5" />
                        {t(`gates.${fleetToolsGateMessageKey(row.act.gate)}` as never)}
                    </span>
                )}
            </td>
            <td className="py-2 text-xs text-text-muted dark:text-text-muted-dark space-y-1">
                {row.reason && (
                    <p>
                        {row.reason}
                        {row.fixHref && (
                            <>
                                {' · '}
                                <Link href={row.fixHref} className="text-primary hover:underline">
                                    {t('change')}
                                </Link>
                            </>
                        )}
                    </p>
                )}
                {refusedComputers.map((computer) => (
                    <p key={computer.nodeId}>
                        <Link href={computer.href} className="hover:underline">
                            {computer.name}
                        </Link>{' '}
                        ✗ {computer.hint ?? t('computerRefuses')}
                    </p>
                ))}
            </td>
        </tr>
    );
}
