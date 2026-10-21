'use client';

import type { KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import type { FleetHandoffCandidateAgent, FleetHandoffComputer } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';
import { osKeyOf } from '../fleet-os.shared';
import { cliKey, HANDOFF_REASON_KEYS } from './task-handoff.shared';

/**
 * Tasks on computers (FL-15 P1, spec FR-2, FR-3, §5.2) — the dialog's
 * Computer section: every computer the person may see, with online state,
 * OS and installed agent CLIs; an unselectable one says why, from the closed
 * set, with the platform's own sentence under it. `↑/↓` move between the
 * selectable ones.
 */
export function ComputerPicker({
    computers,
    agent,
    selectedId,
    onSelect,
    loading,
}: {
    computers: readonly FleetHandoffComputer[];
    agent: FleetHandoffCandidateAgent | null;
    selectedId: string | null;
    onSelect: (nodeId: string) => void;
    loading?: boolean;
}) {
    const t = useTranslations('fleet.taskHandoff');
    const tProviders = useTranslations('fleet.sessions.providers');
    const tOs = useTranslations('fleet.os');

    if (loading) {
        return (
            <div className="space-y-2" aria-busy="true" data-testid="fleet-handoff-computers-loading">
                {[0, 1, 2].map((row) => (
                    <div key={row} className="h-10 rounded-md bg-surface-secondary dark:bg-surface-secondary-dark animate-pulse" />
                ))}
            </div>
        );
    }

    const selectable = computers.filter((row) => row.selectable);
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        if (selectable.length === 0) return;
        event.preventDefault();
        const at = selectable.findIndex((row) => row.nodeId === selectedId);
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const next = selectable[(at + step + selectable.length) % selectable.length];
        if (next) onSelect(next.nodeId);
    };
    const pinned = computers.find((row) => row.pinned);

    return (
        <div className="space-y-2">
            <div
                role="radiogroup"
                aria-label={t('dialog.computer')}
                className="space-y-1.5"
                onKeyDown={onKeyDown}
                data-testid="fleet-handoff-computers"
            >
                {computers.map((row) => {
                    const selected = row.nodeId === selectedId;
                    const osLabel = row.os ? tOs(osKeyOf(row.os), { platform: row.os }) : null;
                    const clis = row.clis.map((cli) => tProviders(cliKey(cli))).join(', ');
                    return (
                        <button
                            key={row.nodeId}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            disabled={!row.selectable}
                            tabIndex={selected || (!selectedId && row.selectable) ? 0 : -1}
                            onClick={() => row.selectable && onSelect(row.nodeId)}
                            className={cn(
                                'w-full rounded-md border px-3 py-2 text-left text-sm',
                                selected ? 'border-primary bg-primary/5' : 'border-border dark:border-border-dark',
                                !row.selectable && 'opacity-60 cursor-not-allowed',
                            )}
                            data-testid="fleet-handoff-computer"
                            data-node-id={row.nodeId}
                            data-reason={row.reason ?? ''}
                        >
                            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                <span
                                    className={cn(
                                        'h-2 w-2 shrink-0 rounded-full',
                                        row.online ? 'bg-emerald-500' : 'bg-text-muted/40',
                                    )}
                                    aria-hidden="true"
                                />
                                <span className="font-medium text-text dark:text-text-dark">{row.name}</span>
                                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                    {row.online ? t('dialog.online') : t('dialog.offlineShort')}
                                    {osLabel ? ` · ${osLabel}` : ''}
                                    {clis ? ` · ${clis}` : ''}
                                </span>
                                {row.pinned && (
                                    <span className="text-[11px] rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                                        {t('dialog.pinned')}
                                    </span>
                                )}
                                {!row.selectable && row.reason && (
                                    <span className="ml-auto text-xs text-warning" data-testid="fleet-handoff-reason">
                                        {t(`reasons.${HANDOFF_REASON_KEYS[row.reason]}`, {
                                            agent: agent?.name ?? '',
                                            node: row.name,
                                            cli: agent ? tProviders(cliKey(agent.cli)) : '',
                                        })}
                                    </span>
                                )}
                            </span>
                            {!row.selectable && row.hint && (
                                <span className="mt-0.5 block text-xs text-text-muted dark:text-text-muted-dark">
                                    {row.hint}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>
            {pinned && agent && (
                <p className="text-xs text-text-muted dark:text-text-muted-dark" data-testid="fleet-handoff-pin-note">
                    {t('dialog.pinNote', { agent: agent.name, node: pinned.name })}
                </p>
            )}
        </div>
    );
}
