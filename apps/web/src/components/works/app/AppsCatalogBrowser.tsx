'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { BadgeCheck, Search, Star } from 'lucide-react';
import type { AppsCatalogListingItem } from '@ever-works/contracts';
import {
    listAppsCatalogAction,
    listAppsCatalogBlueprintsAction,
} from '@/app/actions/dashboard/apps-catalog';
import type { AppsCatalogBlueprintItem } from '@/lib/api/apps-catalog.types';
import { cn } from '@/lib/utils/cn';

/** Search waits this long after the last keystroke (APW-03 plan §5: 300 ms). */
export const APPS_CATALOG_SEARCH_DEBOUNCE_MS = 300;
/** …and only searches from this many characters (`APPS_CATALOG_SEARCH_MIN_CHARS`). */
export const APPS_CATALOG_SEARCH_MIN_CHARS = 2;

/**
 * What a pick hands the form: the repository to paste and, for a curated
 * entry, the Blueprint the member chose — which inspect previews explicitly
 * (and create answers `blueprint_mismatch` for, should it not fit).
 */
export interface AppsCatalogPick {
    url: string;
    blueprintId?: string;
}

/** A curated entry ⇒ its upstream (the app's own repository) with the Blueprint id. */
export function pickOfListingItem(item: AppsCatalogListingItem): AppsCatalogPick | null {
    if (!item.selectable || !item.upstream) return null;
    return { url: item.upstream.url, blueprintId: item.id };
}

/** A topic-listed Blueprint repository ⇒ its own URL; inspect settles the match. */
export function pickOfBlueprintItem(item: AppsCatalogBlueprintItem): AppsCatalogPick {
    return { url: item.url };
}

type LoadState =
    | { kind: 'loading' }
    | { kind: 'curated'; items: readonly AppsCatalogListingItem[] }
    | { kind: 'fallback'; items: AppsCatalogBlueprintItem[] }
    | { kind: 'unavailable' }
    | { kind: 'disabled' }
    | { kind: 'error' };

export interface AppsCatalogBrowserProps {
    /** A pick: the form fills the URL and inspects it once. */
    onPick: (pick: AppsCatalogPick) => void;
    disabled?: boolean;
}

const card = cn(
    'h-full w-full rounded-lg border p-4 text-left transition-colors',
    'border-card-border dark:border-border-secondary-dark',
);
const badge =
    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium';

/**
 * APW-01 T22 / APW-03 §5 — "Browse the Apps catalog" on the App Work create form.
 *
 * Reads the **curated** catalog first (`GET /api/apps-catalog`, the catalog
 * repository's `manifest.json`): status, verification, licence, where it may
 * run and the trademark notice per entry; placeholders are listed but not
 * selectable. When the curated catalog cannot be read it falls back to the
 * Blueprint repositories found on GitHub by topic
 * (`GET /api/apps-catalog/blueprints`) and says so. Search from two
 * characters, 300 ms debounce.
 */
export function AppsCatalogBrowser({ onPick, disabled }: AppsCatalogBrowserProps) {
    const t = useTranslations('dashboard.workCreation.app.catalog');
    const [query, setQuery] = useState('');
    const [state, setState] = useState<LoadState>({ kind: 'loading' });
    const ticket = useRef(0);

    useEffect(() => {
        const needle = query.trim();
        const effective = needle.length >= APPS_CATALOG_SEARCH_MIN_CHARS ? needle : '';
        const mine = ++ticket.current;
        const timer = window.setTimeout(
            async () => {
                setState({ kind: 'loading' });
                try {
                    const curated = await listAppsCatalogAction(effective || undefined);
                    if (mine !== ticket.current) return;
                    if (!curated.success && curated.code === 'app_works_disabled') {
                        setState({ kind: 'disabled' });
                        return;
                    }
                    if (curated.success && curated.data.available) {
                        setState({ kind: 'curated', items: curated.data.items });
                        return;
                    }
                    // The curated catalog is not readable here: the topic listing.
                    const found = await listAppsCatalogBlueprintsAction(effective || undefined);
                    if (mine !== ticket.current) return;
                    if (!found.success) {
                        if (found.code === 'app_works_disabled') setState({ kind: 'disabled' });
                        else if (found.httpStatus === 404) setState({ kind: 'unavailable' });
                        else setState({ kind: 'error' });
                        return;
                    }
                    setState(
                        found.data.available
                            ? { kind: 'fallback', items: found.data.items }
                            : { kind: 'unavailable' },
                    );
                } catch {
                    if (mine === ticket.current) setState({ kind: 'error' });
                }
            },
            // The first paint loads at once; typing waits for the debounce.
            mine === 1 ? 0 : APPS_CATALOG_SEARCH_DEBOUNCE_MS,
        );
        return () => window.clearTimeout(timer);
    }, [query]);

    const searching = query.trim().length >= APPS_CATALOG_SEARCH_MIN_CHARS;
    const empty =
        (state.kind === 'curated' || state.kind === 'fallback') && state.items.length === 0;

    return (
        <div className="space-y-4" data-testid="apps-catalog-browser">
            <label className="relative block">
                <span className="sr-only">{t('searchLabel')}</span>
                <Search
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
                    aria-hidden="true"
                />
                <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('searchPlaceholder')}
                    disabled={disabled}
                    data-testid="apps-catalog-search"
                    className="w-full rounded-md border border-card-border dark:border-border-secondary-dark bg-transparent py-2 pl-9 pr-3 text-sm"
                />
            </label>

            <div aria-live="polite" className="space-y-1">
                {state.kind === 'loading' && (
                    <p
                        className="text-sm text-text-secondary dark:text-text-secondary-dark"
                        data-testid="apps-catalog-loading"
                    >
                        {t('loading')}
                    </p>
                )}
                {state.kind === 'unavailable' && (
                    <p
                        className="text-sm text-text-secondary dark:text-text-secondary-dark"
                        data-testid="apps-catalog-unavailable"
                    >
                        {t('unavailable')}
                    </p>
                )}
                {state.kind === 'disabled' && (
                    <p
                        className="text-sm text-text-secondary dark:text-text-secondary-dark"
                        data-testid="apps-catalog-disabled"
                    >
                        {t('disabled')}
                    </p>
                )}
                {state.kind === 'error' && (
                    <p
                        className="text-sm text-red-600 dark:text-red-400"
                        data-testid="apps-catalog-error"
                        role="alert"
                    >
                        {t('error')}
                    </p>
                )}
                {state.kind === 'fallback' && (
                    <p
                        className="text-xs text-text-muted dark:text-text-muted-dark"
                        data-testid="apps-catalog-fallback"
                    >
                        {t('fallbackNote')}
                    </p>
                )}
                {empty && (
                    <p
                        className="text-sm text-text-secondary dark:text-text-secondary-dark"
                        data-testid="apps-catalog-empty"
                    >
                        {searching ? t('noMatches') : t('empty')}
                    </p>
                )}
            </div>

            {state.kind === 'curated' && state.items.length > 0 && (
                <ul
                    className="grid gap-3 @lg/main:grid-cols-2 @3xl/main:grid-cols-3"
                    aria-label={t('listLabel')}
                >
                    {state.items.map((item) => {
                        const pick = pickOfListingItem(item);
                        const targets = [
                            item.yourCluster ? t('targetYourCluster') : null,
                            item.managedHosting.allowed ? t('targetManaged') : null,
                        ]
                            .filter(Boolean)
                            .join(' · ');
                        return (
                            <li key={item.id}>
                                <button
                                    type="button"
                                    onClick={() => pick && onPick(pick)}
                                    disabled={disabled || !pick}
                                    aria-disabled={!pick}
                                    data-testid="apps-catalog-card"
                                    data-blueprint-id={item.id}
                                    data-source="manifest"
                                    aria-label={
                                        pick
                                            ? t('pick', { name: item.name })
                                            : `${item.name} — ${t('notSelectable')}`
                                    }
                                    className={cn(
                                        card,
                                        pick
                                            ? 'hover:border-primary focus-visible:border-primary focus-visible:outline-none'
                                            : 'cursor-not-allowed opacity-60',
                                    )}
                                >
                                    <span className="flex flex-wrap items-baseline justify-between gap-2">
                                        <span className="font-semibold text-text dark:text-text-dark">
                                            {item.name}
                                        </span>
                                        <span className="flex flex-wrap gap-1">
                                            {item.status === 'beta' && (
                                                <span
                                                    className={cn(
                                                        badge,
                                                        'border-sky-300 text-sky-700 dark:text-sky-300',
                                                    )}
                                                >
                                                    {t('statusBeta')}
                                                </span>
                                            )}
                                            {item.status === 'placeholder' && (
                                                <span
                                                    className={cn(
                                                        badge,
                                                        'border-gray-300 text-text-secondary',
                                                    )}
                                                >
                                                    {t('statusPlaceholder')}
                                                </span>
                                            )}
                                            {item.blueprint.verified && (
                                                <span
                                                    className={cn(
                                                        badge,
                                                        'border-emerald-300 text-emerald-700 dark:text-emerald-300',
                                                    )}
                                                >
                                                    <BadgeCheck
                                                        className="h-3 w-3"
                                                        aria-hidden="true"
                                                    />
                                                    {t('verified')}
                                                </span>
                                            )}
                                        </span>
                                    </span>
                                    {item.upstream && (
                                        <span className="mt-1 block text-xs text-text-muted dark:text-text-muted-dark">
                                            {t('upstreamLine', { repo: item.upstream.repo })}
                                            {item.license.spdx ? ` · ${item.license.spdx}` : ''}
                                        </span>
                                    )}
                                    {item.summary && (
                                        <span className="mt-2 block text-sm text-text-secondary dark:text-text-secondary-dark">
                                            {item.summary}
                                        </span>
                                    )}
                                    {targets && (
                                        <span className="mt-2 block text-xs text-text-secondary dark:text-text-secondary-dark">
                                            {t('runsOn', { targets })}
                                        </span>
                                    )}
                                    {item.trademark?.notice && (
                                        <span className="mt-2 block text-[11px] text-text-muted dark:text-text-muted-dark">
                                            {item.trademark.notice}
                                        </span>
                                    )}
                                    {!pick && (
                                        <span className="mt-2 block text-xs text-text-muted">
                                            {t('notSelectable')}
                                        </span>
                                    )}
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}

            {state.kind === 'fallback' && state.items.length > 0 && (
                <ul
                    className="grid gap-3 @lg/main:grid-cols-2 @3xl/main:grid-cols-3"
                    aria-label={t('listLabel')}
                >
                    {state.items.map((item) => (
                        <li key={item.repo}>
                            <button
                                type="button"
                                onClick={() => onPick(pickOfBlueprintItem(item))}
                                disabled={disabled}
                                data-testid="apps-catalog-card"
                                data-blueprint-id={item.id}
                                data-source="topic"
                                aria-label={t('pick', { name: item.name })}
                                className={cn(
                                    card,
                                    'hover:border-primary focus-visible:border-primary focus-visible:outline-none',
                                )}
                            >
                                <span className="flex items-baseline justify-between gap-2">
                                    <span className="font-semibold text-text dark:text-text-dark">
                                        {item.name}
                                    </span>
                                    {typeof item.stars === 'number' && (
                                        <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
                                            <Star className="h-3 w-3" aria-hidden="true" />
                                            {item.stars}
                                        </span>
                                    )}
                                </span>
                                <span className="mt-1 block text-xs text-text-muted dark:text-text-muted-dark">
                                    {item.repo}
                                    {item.spdx ? ` · ${item.spdx}` : ''}
                                </span>
                                {item.summary && (
                                    <span className="mt-2 block text-sm text-text-secondary dark:text-text-secondary-dark">
                                        {item.summary}
                                    </span>
                                )}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
