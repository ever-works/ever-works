'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import type { AgentCapabilitiesPayload, ConnectionScopePresetId } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { setAgentAccessLevelAction } from '@/app/actions/agent-capabilities';
import {
    composeAgentAccessLevels,
    describeAccessLevel,
    selectedAccessLevel,
    type AgentAccessLevelRow,
} from './agent-access-levels.shared';

interface Props {
    agentId: string;
    rows: AgentAccessLevelRow[];
    /** The per-tool switches read the same grant row, so they refresh from this. */
    onCapabilitiesChange: (capabilities: AgentCapabilitiesPayload) => void;
    /** Outer `<section>` class — the Capabilities page owns the card style. */
    className?: string;
}

/**
 * Capabilities tab — Access levels section (AW-15).
 *
 * "Read only" or "Read and write", per provider whose plugin declares the
 * levels, for THIS agent. A choice is written onto the agent's existing
 * tool-grant row (as deny patterns), so it narrows exactly the way the
 * per-tool switches above do and binds on the agent's next tool call.
 *
 * The picker is never optimistic: widening can be refused (a parent scope
 * denies it, or the provider needs the owner to re-approve), so the chosen
 * option only moves once the server has answered with the stored level.
 */
export function AgentAccessLevelsSection({
    agentId,
    rows,
    onCapabilitiesChange,
    className,
}: Props) {
    const t = useTranslations('dashboard.agentsPage.capabilities.accessLevels');
    const [items, setItems] = useState(() => composeAgentAccessLevels(rows));
    const [busyProvider, setBusyProvider] = useState<string | null>(null);
    const [reapprovalProvider, setReapprovalProvider] = useState<string | null>(null);
    const [, startTransition] = useTransition();

    if (items.length === 0) return null;

    const choose = (row: AgentAccessLevelRow, preset: ConnectionScopePresetId) => {
        if (busyProvider !== null || selectedAccessLevel(row) === preset) return;
        setBusyProvider(row.providerId);
        setReapprovalProvider(null);
        startTransition(() => {
            void (async () => {
                try {
                    const result = await setAgentAccessLevelAction(agentId, row.providerId, preset);
                    if (result.success) {
                        setItems((previous) =>
                            previous.map((item) =>
                                item.providerId === row.providerId
                                    ? { ...item, state: result.state }
                                    : item,
                            ),
                        );
                        onCapabilitiesChange(result.capabilities);
                        toast.success(t('saved', { provider: row.providerName }));
                    } else if (result.reason === 'reapproval') {
                        setReapprovalProvider(row.providerId);
                    } else {
                        toast.error(result.error);
                    }
                } catch (error) {
                    toast.error(error instanceof Error ? error.message : String(error));
                } finally {
                    setBusyProvider(null);
                }
            })();
        });
    };

    return (
        <section className={className} data-testid="capabilities-access-levels-section">
            <div className="p-4 border-b border-border/40 dark:border-border-dark/40">
                <h3 className="text-sm font-medium text-text dark:text-text-dark flex items-center gap-2">
                    <KeyRound className="w-4 h-4 text-primary" />
                    {t('title')}
                </h3>
                <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1 max-w-2xl">
                    {t('description')}
                </p>
            </div>
            <div className="divide-y divide-border/40 dark:divide-border-dark/40">
                {items.map((row) => {
                    const selected = selectedAccessLevel(row);
                    const hint = describeAccessLevel(row);
                    const busy = busyProvider === row.providerId;
                    return (
                        <article
                            key={row.providerId}
                            className="p-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"
                            data-testid={`capabilities-access-level-${row.providerId}`}
                        >
                            <div className="min-w-0">
                                <div className="text-sm text-text dark:text-text-dark">
                                    {row.providerName}
                                </div>
                                <p
                                    className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark"
                                    data-testid={`capabilities-access-level-hint-${row.providerId}`}
                                >
                                    {hint.kind === 'unavailable'
                                        ? t('unavailable')
                                        : hint.kind === 'narrowed'
                                          ? t('narrowed', {
                                                level: hint.effective
                                                    ? t(`levels.${hint.effective}`)
                                                    : t('none'),
                                                scope: t(`scopes.${hint.scope}`),
                                            })
                                          : t(`levelHints.${hint.level}`)}
                                </p>
                                {reapprovalProvider === row.providerId && (
                                    <p
                                        className="mt-1 text-xs text-warning"
                                        role="status"
                                        data-testid={`capabilities-access-level-reapproval-${row.providerId}`}
                                    >
                                        {t('reapproval', { provider: row.providerName })}{' '}
                                        <Link
                                            href={ROUTES.DASHBOARD_PLUGINS}
                                            className="text-primary hover:underline"
                                        >
                                            {t('reapprovalLink')}
                                        </Link>
                                    </p>
                                )}
                            </div>
                            <div
                                role="radiogroup"
                                aria-label={t('pickerLabel', { provider: row.providerName })}
                                className="inline-flex shrink-0 rounded-lg border border-border/60 dark:border-border-dark/60 p-0.5"
                            >
                                {row.presets.map((preset) => {
                                    const checked = selected === preset;
                                    return (
                                        <button
                                            key={preset}
                                            type="button"
                                            role="radio"
                                            aria-checked={checked}
                                            disabled={busyProvider !== null || row.state === null}
                                            onClick={() => choose(row, preset)}
                                            className={
                                                checked
                                                    ? 'px-3 py-1 text-xs rounded-md bg-primary text-white dark:bg-white dark:text-gray-900'
                                                    : 'px-3 py-1 text-xs rounded-md text-text dark:text-text-dark hover:bg-muted/40 disabled:opacity-50'
                                            }
                                            data-testid={`capabilities-access-level-${row.providerId}-${preset}`}
                                        >
                                            {busy && !checked ? '…' : t(`levels.${preset}`)}
                                        </button>
                                    );
                                })}
                            </div>
                        </article>
                    );
                })}
            </div>
            <p className="px-4 pb-4 pt-2 text-[11px] text-text-muted dark:text-text-muted-dark">
                {t('appliesNext')}
            </p>
        </section>
    );
}
