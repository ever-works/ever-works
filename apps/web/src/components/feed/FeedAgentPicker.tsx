'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Search } from 'lucide-react';
import type { FeedActorSummaryDto } from '@ever-works/contracts';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { cn } from '@/lib/utils/cn';

interface FeedAgentPickerProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    actors: FeedActorSummaryDto[];
    selected: string[];
    onToggle: (agentId: string) => void;
    onClearAll: () => void;
    /** True right after a selection beyond the limit was refused. */
    limitReached: boolean;
}

const STATUS_KEYS: Record<string, string> = {
    draft: 'statusDraft',
    active: 'statusActive',
    paused: 'statusPaused',
    running: 'statusRunning',
    error: 'statusError',
    archived: 'statusArchived',
};

/** Searchable overflow for agents beyond the chips, with the 20-agent limit. */
export function FeedAgentPicker({
    open,
    onOpenChange,
    actors,
    selected,
    onToggle,
    onClearAll,
    limitReached,
}: FeedAgentPickerProps) {
    const t = useTranslations('dashboard.feed');
    // Agent status words are the ones the Agents catalog already shows.
    const tStatus = useTranslations('dashboard.agentsPage.card');
    const [query, setQuery] = useState('');

    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return needle
            ? actors.filter((actor) => actor.label.toLowerCase().includes(needle))
            : actors;
    }, [actors, query]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <div data-testid="feed-agent-picker" className="flex flex-col gap-3">
                    <h2 className="text-base font-semibold text-text dark:text-text-dark">
                        {t('agentPicker.title')}
                    </h2>
                    <label className="relative block">
                        <span className="sr-only">{t('agentPicker.search')}</span>
                        <Search
                            aria-hidden="true"
                            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted dark:text-text-muted-dark"
                        />
                        <input
                            type="search"
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={t('agentPicker.search')}
                            className="w-full rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark py-1.5 pl-8 pr-3 text-sm text-text dark:text-text-dark"
                        />
                    </label>
                    <ul
                        className="max-h-72 space-y-0.5 overflow-y-auto"
                        aria-label={t('filters.agentsGroup')}
                    >
                        {visible.length === 0 ? (
                            <li className="px-2 py-4 text-center text-sm text-text-muted dark:text-text-muted-dark">
                                {t('agentPicker.noMatches')}
                            </li>
                        ) : (
                            visible.map((actor) => {
                                const checked = selected.includes(actor.agentId);
                                const statusKey = STATUS_KEYS[actor.status];
                                return (
                                    <li key={actor.agentId}>
                                        <label
                                            className={cn(
                                                'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                                                'hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark',
                                            )}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={checked}
                                                onChange={() => onToggle(actor.agentId)}
                                                className="h-4 w-4"
                                            />
                                            <span className="min-w-0 flex-1 truncate text-text dark:text-text-dark">
                                                {actor.label}
                                            </span>
                                            {statusKey ? (
                                                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                                    {tStatus(statusKey as never)}
                                                </span>
                                            ) : null}
                                            <span className="w-16 text-right text-xs tabular-nums text-text-muted dark:text-text-muted-dark">
                                                {t('agentPicker.entryCount', {
                                                    count: actor.count,
                                                })}
                                            </span>
                                        </label>
                                    </li>
                                );
                            })
                        )}
                    </ul>
                    {limitReached ? (
                        <p role="alert" className="text-xs text-warning">
                            {t('filters.agentLimit')}
                        </p>
                    ) : null}
                    <div className="flex items-center justify-between gap-2 border-t border-border dark:border-border-dark pt-3">
                        <span
                            className="text-xs text-text-muted dark:text-text-muted-dark"
                            aria-live="polite"
                        >
                            {t('agentPicker.selectedCount', { selected: selected.length })}
                        </span>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={onClearAll}
                                disabled={selected.length === 0}
                                className="rounded-lg border border-border dark:border-border-dark px-3 py-1.5 text-xs font-medium text-text dark:text-text-dark disabled:opacity-40"
                            >
                                {t('agentPicker.clearAll')}
                            </button>
                            <button
                                type="button"
                                onClick={() => onOpenChange(false)}
                                className="rounded-lg bg-button-primary dark:bg-button-primary-dark px-3 py-1.5 text-xs font-medium text-white dark:text-black"
                            >
                                {t('agentPicker.done')}
                            </button>
                        </div>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
