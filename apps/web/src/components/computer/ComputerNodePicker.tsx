'use client';

import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown } from 'lucide-react';
import type { ComputerNodeOption } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { relativeTimeParts, runnerDotClass } from '@/components/dashboard/runner-status.shared';
import { nodeDotState, nodeRowNote } from './computer-session.shared';

export interface ComputerNodePickerHandle {
    open(): void;
}

interface Props {
    agentId: string;
    agentName: string;
    nodes: readonly ComputerNodeOption[];
    selectedNodeId: string | null;
    onSelect: (nodeId: string) => void;
    /** Injected so relative times are testable. */
    now?: number;
}

/**
 * The computer picker. Rows arrive from the platform already ordered — the
 * Agent's pinned computer first, then online by latest heartbeat — and each
 * names its state in words (never the dot alone): what it can serve, or the
 * one reason it cannot be watched.
 *
 * Picking a computer here chooses what to WATCH. It never touches the
 * Agent's pin — that is the affinity the Capabilities tab owns — and the
 * picker says so, and links there.
 */
export const ComputerNodePicker = forwardRef<ComputerNodePickerHandle, Props>(
    function ComputerNodePicker({ agentId, agentName, nodes, selectedNodeId, onSelect, now }, ref) {
        const t = useTranslations('dashboard.computer.nodePicker');
        const tState = useTranslations('dashboard.runner.nodeState');
        const tRelative = useTranslations('dashboard.runner.relative');
        const [open, setOpen] = useState(false);
        const listId = useId();
        const containerRef = useRef<HTMLDivElement | null>(null);
        const selected = nodes.find((node) => node.id === selectedNodeId) ?? null;
        const pinned = nodes.find((node) => node.boundToAgent) ?? null;

        useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), []);

        useEffect(() => {
            if (!open) return;
            const onKey = (event: KeyboardEvent) => {
                if (event.key === 'Escape') setOpen(false);
            };
            const onClick = (event: MouseEvent) => {
                if (containerRef.current && !containerRef.current.contains(event.target as Node))
                    setOpen(false);
            };
            document.addEventListener('keydown', onKey);
            document.addEventListener('mousedown', onClick);
            return () => {
                document.removeEventListener('keydown', onKey);
                document.removeEventListener('mousedown', onClick);
            };
        }, [open]);

        return (
            <div ref={containerRef} className="relative inline-block">
                <button
                    type="button"
                    data-testid="computer-node-picker-trigger"
                    aria-haspopup="listbox"
                    aria-expanded={open}
                    aria-controls={listId}
                    aria-label={t('label')}
                    onClick={() => setOpen((value) => !value)}
                    className="inline-flex items-center gap-1 rounded px-1 font-medium text-text hover:bg-surface-hover dark:text-text-dark dark:hover:bg-surface-hover-dark"
                >
                    {selected?.name ?? t('label')}
                    <ChevronDown className="h-3 w-3" aria-hidden />
                </button>
                {open ? (
                    <div
                        data-testid="computer-node-picker"
                        className="absolute left-0 top-full z-40 mt-1 w-[min(92vw,34rem)] rounded-lg border border-border bg-surface p-2 shadow-lg dark:border-border-dark dark:bg-surface-dark"
                    >
                        <p className="px-2 pt-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                            {t('heading', { agent: agentName })}
                        </p>
                        <p className="px-2 pb-2 text-xs text-text-secondary dark:text-text-secondary-dark">
                            {pinned
                                ? t('pinnedNote', { agent: agentName, node: pinned.name })
                                : t('unpinnedNote', { agent: agentName })}{' '}
                            <Link
                                href={ROUTES.DASHBOARD_AGENT_CAPABILITIES(agentId)}
                                className="underline"
                                data-testid="computer-node-picker-capabilities-link"
                            >
                                {t('capabilitiesLink')}
                            </Link>
                        </p>
                        <ul
                            id={listId}
                            role="listbox"
                            aria-label={t('label')}
                            className="max-h-80 overflow-y-auto border-t border-border/60 pt-1 dark:border-border-dark/60"
                        >
                            {nodes.map((node) => {
                                const note = nodeRowNote(node);
                                const relative = relativeTimeParts(node.lastHeartbeatAt, now);
                                const isSelected = node.id === selectedNodeId;
                                return (
                                    <li key={node.id} role="option" aria-selected={isSelected}>
                                        <button
                                            type="button"
                                            data-testid={`computer-node-option-${node.id}`}
                                            onClick={() => {
                                                setOpen(false);
                                                onSelect(node.id);
                                            }}
                                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-surface-hover dark:hover:bg-surface-hover-dark"
                                        >
                                            <span
                                                className={cn(
                                                    'h-2 w-2 shrink-0 rounded-full',
                                                    runnerDotClass(nodeDotState(node)),
                                                )}
                                                aria-hidden
                                            />
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate font-medium text-text dark:text-text-dark">
                                                    {node.name}
                                                </span>
                                                <span className="block truncate text-text-muted dark:text-text-muted-dark">
                                                    {[
                                                        node.platform,
                                                        tState(node.status),
                                                        relative
                                                            ? tRelative(relative.unit, {
                                                                  value: relative.value,
                                                              })
                                                            : t('lastHeartbeatNever'),
                                                    ]
                                                        .filter(Boolean)
                                                        .join(' · ')}
                                                </span>
                                            </span>
                                            <span
                                                className={cn(
                                                    'shrink-0',
                                                    note.tone === 'muted'
                                                        ? 'text-text-muted dark:text-text-muted-dark'
                                                        : 'text-text-secondary dark:text-text-secondary-dark',
                                                )}
                                            >
                                                {node.boundToAgent && node.watchable
                                                    ? `${t('pinnedBadge', { agent: agentName })} · `
                                                    : ''}
                                                {t(note.key)}
                                                {note.missingKey ? ` · ${t(note.missingKey)}` : ''}
                                            </span>
                                            {isSelected ? (
                                                <Check
                                                    className="h-3.5 w-3.5 shrink-0"
                                                    aria-label={t('selected')}
                                                />
                                            ) : null}
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                ) : null}
            </div>
        );
    },
);
