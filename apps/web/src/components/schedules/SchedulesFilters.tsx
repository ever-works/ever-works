'use client';

import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
    EMPTY_SCHEDULE_FILTERS,
    SCHEDULE_FILTER_STATUSES,
    hasActiveFilters,
    type SchedulesFilterState,
} from './schedules-filters.shared';

const selectClass =
    'h-8 rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2 text-xs text-text dark:text-text-dark';

/**
 * Agent / status / health / search for the Schedules list. Pure presentation:
 * the parent owns the state and mirrors it into the URL, so a filtered list
 * survives a reload and can be shared as a link. The search box reports after
 * a short pause so typing does not fire a request per key.
 *
 * The SOURCE dimension is not here: it is the chip row directly above
 * (`ScheduleSourceChips`), which shows each source's count and is the only
 * control that can say "you have none of these" at a glance. One dimension,
 * one control — the chips write the same `source` parameter this select used
 * to, so every existing link and bookmark still resolves.
 */
export function SchedulesFilters({
    value,
    agents,
    onChange,
}: {
    value: SchedulesFilterState;
    agents: Array<{ id: string; name: string }>;
    onChange: (next: SchedulesFilterState) => void;
}) {
    const t = useTranslations('dashboard.schedules');
    const [draft, setDraft] = useState(value.q);
    const [syncedQ, setSyncedQ] = useState(value.q);
    // The URL changed underneath the box (Clear filters, back button): adopt
    // it. Adjusting state while rendering, not in an effect.
    if (value.q !== syncedQ) {
        setSyncedQ(value.q);
        setDraft(value.q);
    }
    useEffect(() => {
        if (draft === value.q) return;
        const timer = window.setTimeout(() => onChange({ ...value, q: draft }), 300);
        return () => window.clearTimeout(timer);
    }, [draft, value, onChange]);

    return (
        <div className="flex flex-wrap items-center gap-2" data-testid="schedules-filters">
            <label className="sr-only" htmlFor="schedules-filter-agent">
                {t('filters.agent')}
            </label>
            <select
                id="schedules-filter-agent"
                data-testid="schedules-filter-agent"
                className={selectClass}
                value={value.agent}
                onChange={(event) => onChange({ ...value, agent: event.target.value })}
            >
                <option value="">{t('filters.anyAgent')}</option>
                {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                        {agent.name}
                    </option>
                ))}
            </select>

            <label className="sr-only" htmlFor="schedules-filter-status">
                {t('filters.status')}
            </label>
            <select
                id="schedules-filter-status"
                data-testid="schedules-filter-status"
                className={selectClass}
                value={value.status}
                onChange={(event) =>
                    onChange({
                        ...value,
                        status: event.target.value as SchedulesFilterState['status'],
                    })
                }
            >
                <option value="">{t('filters.anyStatus')}</option>
                {SCHEDULE_FILTER_STATUSES.map((status) => (
                    <option key={status} value={status}>
                        {t(`statuses.${status}`)}
                    </option>
                ))}
            </select>

            <label className="sr-only" htmlFor="schedules-filter-health">
                {t('filters.health')}
            </label>
            <select
                id="schedules-filter-health"
                data-testid="schedules-filter-health"
                className={selectClass}
                value={value.health}
                onChange={(event) =>
                    onChange({
                        ...value,
                        health: event.target.value as SchedulesFilterState['health'],
                    })
                }
            >
                <option value="">{t('filters.anyHealth')}</option>
                <option value="ok">{t('filters.healthOk')}</option>
                <option value="never-runs">{t('filters.healthNeverRuns')}</option>
            </select>

            <div className="relative min-w-[12rem] flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted dark:text-text-muted-dark" />
                <input
                    type="search"
                    aria-label={t('filters.searchLabel')}
                    data-testid="schedules-filter-search"
                    placeholder={t('filters.search')}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    className="h-8 w-full rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark pl-7 pr-2 text-xs text-text dark:text-text-dark"
                />
            </div>

            {hasActiveFilters(value) && (
                <button
                    type="button"
                    data-testid="schedules-filter-clear"
                    onClick={() => onChange(EMPTY_SCHEDULE_FILTERS)}
                    className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-text-secondary hover:bg-surface-secondary dark:text-text-secondary-dark dark:hover:bg-surface-secondary-dark"
                >
                    <X className="h-3.5 w-3.5" />
                    {t('filters.clear')}
                </button>
            )}
        </div>
    );
}
