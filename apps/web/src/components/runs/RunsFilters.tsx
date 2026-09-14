'use client';

import { forwardRef, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Search, X } from 'lucide-react';
import {
    RUN_LEDGER_STATUSES,
    RUN_LEDGER_TRIGGER_KINDS,
    type RunLedgerFilters,
    type RunLedgerStatus,
    type RunLedgerTriggerKind,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { countActiveFilters, isSearchUsable } from './runs.shared';

export interface RunsAgentOption {
    id: string;
    name: string;
    archived: boolean;
}

const SEARCH_DEBOUNCE_MS = 350;

/**
 * Runs ledger (AW-09) — search plus the Agent / trigger / outcome filters.
 * Changing any of them narrows the list AND the rail together (the page owns
 * one filter state for both). The search box is debounced and only applied
 * once it is long enough for the API to accept it.
 */
export const RunsFilters = forwardRef<
    HTMLInputElement,
    {
        filters: RunLedgerFilters;
        agents: RunsAgentOption[];
        onChange: (next: RunLedgerFilters) => void;
    }
>(function RunsFilters({ filters, agents, onChange }, searchRef) {
    const t = useTranslations('dashboard.runsPage.filters');
    const tTrigger = useTranslations('dashboard.runsPage.trigger');
    const tOutcome = useTranslations('dashboard.runsPage.outcome');
    const [search, setSearch] = useState(filters.search ?? '');
    const [appliedSearch, setAppliedSearch] = useState(filters.search);

    // Keep the box in sync when the filters change from elsewhere (Clear, a
    // rail shortcut, browser navigation) — adjusted during render, not in an
    // effect, so there is no extra render pass.
    if (appliedSearch !== filters.search) {
        setAppliedSearch(filters.search);
        setSearch(filters.search ?? '');
    }

    useEffect(() => {
        const trimmed = search.trim();
        const next = isSearchUsable(trimmed) ? trimmed : undefined;
        if (next === filters.search) return;
        if (trimmed.length > 0 && !next) return; // too short: wait, keep current results
        const timer = setTimeout(() => onChange({ ...filters, search: next }), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [search, filters, onChange]);

    const active = countActiveFilters(filters);
    const tooShort = search.trim().length > 0 && !isSearchUsable(search);

    return (
        <div
            className="flex flex-wrap items-center gap-2"
            role="search"
            aria-label={t('label')}
            data-testid="runs-filters"
        >
            <div className="relative w-64 max-w-full">
                <Search
                    className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted"
                    aria-hidden
                />
                <input
                    ref={searchRef}
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={t('search')}
                    aria-label={t('search')}
                    aria-describedby={tooShort ? 'runs-search-hint' : undefined}
                    maxLength={200}
                    className="w-full h-8 pl-7 pr-2 text-xs rounded-lg outline-none bg-card dark:bg-card-primary-dark border border-card-border dark:border-white/9 text-text dark:text-text-dark placeholder-text-muted focus:border-primary"
                    data-testid="runs-search"
                />
            </div>
            {tooShort && (
                <span id="runs-search-hint" className="text-[11px] text-text-muted">
                    {t('searchTooShort')}
                </span>
            )}

            <Select
                value={filters.agentIds?.[0] ?? 'all'}
                onValueChange={(value) =>
                    onChange({ ...filters, agentIds: value === 'all' ? undefined : [value] })
                }
                size="sm"
                className="w-44"
                aria-label={t('agent')}
                data-testid="runs-filter-agent"
            >
                <option value="all">{t('agentAll')}</option>
                {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                        {agent.archived ? t('archivedSuffix', { name: agent.name }) : agent.name}
                    </option>
                ))}
            </Select>

            <Select
                value={filters.triggerKinds?.[0] ?? 'all'}
                onValueChange={(value) =>
                    onChange({
                        ...filters,
                        triggerKinds: value === 'all' ? undefined : [value as RunLedgerTriggerKind],
                    })
                }
                size="sm"
                className="w-36"
                aria-label={t('trigger')}
                data-testid="runs-filter-trigger"
            >
                <option value="all">{t('triggerAll')}</option>
                {RUN_LEDGER_TRIGGER_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                        {tTrigger(kind)}
                    </option>
                ))}
            </Select>

            <Select
                value={filters.statuses?.[0] ?? 'all'}
                onValueChange={(value) =>
                    onChange({
                        ...filters,
                        statuses: value === 'all' ? undefined : [value as RunLedgerStatus],
                    })
                }
                size="sm"
                className="w-36"
                aria-label={t('outcome')}
                data-testid="runs-filter-outcome"
            >
                <option value="all">{t('outcomeAll')}</option>
                {RUN_LEDGER_STATUSES.map((status) => (
                    <option key={status} value={status}>
                        {tOutcome(status)}
                    </option>
                ))}
            </Select>

            {active > 0 && (
                <>
                    <span
                        className="text-[11px] px-1.5 py-0.5 rounded bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary"
                        data-testid="runs-filter-count"
                    >
                        {t('activeCount', { count: active })}
                    </span>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onChange({})}
                        data-testid="runs-clear-filters"
                    >
                        <X className="w-3.5 h-3.5 mr-1" aria-hidden />
                        {t('clear')}
                    </Button>
                </>
            )}
        </div>
    );
});
