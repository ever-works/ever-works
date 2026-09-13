'use client';

import { useTranslations } from 'next-intl';
import { FEED_KINDS, type FeedActorSummaryDto, type FeedKind } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';
import type { FeedFilterState } from './feed-filters';

/** How many agent chips the bar shows before the rest go behind the picker. */
export const FEED_AGENT_CHIP_LIMIT = 12;

interface FeedFiltersProps {
    filters: FeedFilterState;
    actors: FeedActorSummaryDto[];
    onToggleAgent: (agentId: string) => void;
    onClearAgents: () => void;
    onOpenPicker: () => void;
    onToggleKind: (kind: FeedKind) => void;
    onToggleFailedOnly: () => void;
    onClearFilters: () => void;
    /** Loaded entries while "Only failed" is on. */
    failedInView: number | null;
    limitReached: boolean;
    filtered: boolean;
}

const chipBase =
    'inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background';
const chipOn = 'bg-button-primary dark:bg-button-primary-dark text-white dark:text-black';
const chipOff =
    'bg-surface-secondary dark:bg-white/9 text-text-secondary dark:text-text-secondary-dark hover:bg-surface-tertiary dark:hover:bg-white/20';

/**
 * Agent chips (busiest first, at most 12, the rest behind "+N more"), the
 * five kind chips and "Only failed". Chips look like the other dashboard
 * filter pills so filters read the same everywhere.
 */
export function FeedFilters({
    filters,
    actors,
    onToggleAgent,
    onClearAgents,
    onOpenPicker,
    onToggleKind,
    onToggleFailedOnly,
    onClearFilters,
    failedInView,
    limitReached,
    filtered,
}: FeedFiltersProps) {
    const t = useTranslations('dashboard.feed.filters');
    const tKinds = useTranslations('dashboard.feed.kinds');

    const chips = actors.slice(0, FEED_AGENT_CHIP_LIMIT);
    // A selected agent outside the top chips still shows as a chip, so the
    // selection is always visible.
    const extraSelected = actors.filter(
        (actor) => filters.agentIds.includes(actor.agentId) && !chips.includes(actor),
    );
    const overflow = Math.max(0, actors.length - FEED_AGENT_CHIP_LIMIT);

    return (
        <div data-testid="feed-filters" className="space-y-2">
            {actors.length > 0 ? (
                <div
                    role="group"
                    aria-label={t('agentsGroup')}
                    className="flex flex-wrap items-center gap-1.5"
                >
                    <span className="mr-1 text-xs font-medium text-text-muted dark:text-text-muted-dark">
                        {t('agentsLabel')}
                    </span>
                    <button
                        type="button"
                        aria-pressed={filters.agentIds.length === 0}
                        onClick={onClearAgents}
                        className={cn(chipBase, filters.agentIds.length === 0 ? chipOn : chipOff)}
                    >
                        {t('allAgents')}
                    </button>
                    {[...chips, ...extraSelected].map((actor) => {
                        const on = filters.agentIds.includes(actor.agentId);
                        return (
                            <button
                                key={actor.agentId}
                                type="button"
                                data-testid="feed-agent-chip"
                                aria-pressed={on}
                                onClick={() => onToggleAgent(actor.agentId)}
                                className={cn(chipBase, on ? chipOn : chipOff)}
                            >
                                {actor.label}
                            </button>
                        );
                    })}
                    {overflow > 0 ? (
                        <button
                            type="button"
                            data-testid="feed-agent-more"
                            onClick={onOpenPicker}
                            className={cn(chipBase, chipOff)}
                        >
                            {t('moreAgents', { count: overflow })}
                        </button>
                    ) : null}
                </div>
            ) : null}
            {limitReached ? (
                <p role="alert" data-testid="feed-agent-limit" className="text-xs text-warning">
                    {t('agentLimit')}
                </p>
            ) : null}
            <div
                role="group"
                aria-label={t('kindsGroup')}
                className="flex flex-wrap items-center gap-1.5"
            >
                <span className="mr-1 text-xs font-medium text-text-muted dark:text-text-muted-dark">
                    {t('kindsLabel')}
                </span>
                {FEED_KINDS.map((kind) => {
                    const on = filters.kinds.includes(kind);
                    return (
                        <button
                            key={kind}
                            type="button"
                            data-testid="feed-kind-chip"
                            data-kind={kind}
                            aria-pressed={on}
                            disabled={filters.failedOnly}
                            onClick={() => onToggleKind(kind)}
                            className={cn(
                                chipBase,
                                on && !filters.failedOnly ? chipOn : chipOff,
                                'disabled:opacity-50',
                            )}
                        >
                            {tKinds(kind)}
                        </button>
                    );
                })}
                <label className="ml-2 inline-flex cursor-pointer items-center gap-1.5 text-xs text-text dark:text-text-dark">
                    <input
                        type="checkbox"
                        data-testid="feed-only-failed"
                        checked={filters.failedOnly}
                        onChange={onToggleFailedOnly}
                        className="h-3.5 w-3.5"
                    />
                    {t('onlyFailed')}
                </label>
                {failedInView !== null ? (
                    <span
                        data-testid="feed-failed-count"
                        className="text-xs text-text-muted dark:text-text-muted-dark"
                    >
                        {t('failedInView', { count: failedInView })}
                    </span>
                ) : null}
                {filtered ? (
                    <button
                        type="button"
                        onClick={onClearFilters}
                        className="ml-auto text-xs font-medium text-text-secondary dark:text-text-secondary-dark underline-offset-2 hover:underline"
                    >
                        {t('clearFilters')}
                    </button>
                ) : null}
            </div>
        </div>
    );
}
