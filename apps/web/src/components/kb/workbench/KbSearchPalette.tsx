'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Command } from 'cmdk';
import { Search, X, Lock as LockIcon } from 'lucide-react';
import { useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import {
    KB_DOCUMENT_CLASSES,
    KB_DOCUMENT_STATUSES,
    type KbDocumentClass,
    type KbDocumentStatus,
    type KbSearchHit,
    type KbSearchResult,
} from '@ever-works/contracts';

/**
 * EW-641 slice E — KB workbench command palette (Cmd+K / Ctrl+K).
 *
 * A globally-mounted `cmdk` palette scoped to the current Work's KB.
 * Operators type a query and the palette debounce-hits the lexical search
 * endpoint (`/api/works/:id/kb/search?q=…`), then renders class / status /
 * snippet rows. Clicking a row routes via the locale-aware `next-intl`
 * router into the workbench detail page (`…/kb/<path>`).
 *
 * Filter chips above the result list narrow the search server-side:
 *  - class (multi-select), repeated `class` query params
 *  - tags (comma-separated input)
 *  - status (multi-select), repeated `status` query params
 *  - locked toggle
 *  - language (BCP-47 input)
 *
 * The keyboard shortcut listener is global within the workbench: the
 * `<KbSearchPalette workId={id} />` mount lives at the workbench route
 * root so any pane (tree, editor, metadata) can open the palette without
 * each component owning its own keydown hook.
 */

export interface KbSearchPaletteProps {
    workId: string;
    /** Test seam — override the default 200ms debounce. */
    debounceMs?: number;
    /** Test seam — start opened (defaults to false). */
    defaultOpen?: boolean;
}

interface PaletteFilters {
    classes: KbDocumentClass[];
    statuses: KbDocumentStatus[];
    tags: string;
    locked: boolean;
    language: string;
}

const EMPTY_FILTERS: PaletteFilters = {
    classes: [],
    statuses: [],
    tags: '',
    locked: false,
    language: '',
};

const DEFAULT_DEBOUNCE_MS = 200;

export function KbSearchPalette({
    workId,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    defaultOpen = false,
}: KbSearchPaletteProps) {
    const t = useTranslations('dashboard.workDetail.kb.workbench');
    const router = useRouter();

    const [open, setOpen] = useState(defaultOpen);
    const [query, setQuery] = useState('');
    const [filters, setFilters] = useState<PaletteFilters>(EMPTY_FILTERS);
    const [hits, setHits] = useState<KbSearchHit[]>([]);
    const [loading, setLoading] = useState(false);

    // Global keyboard shortcut. Listens on `window` so the palette can be
    // triggered from any focused element within the workbench.
    useEffect(() => {
        const handler = (event: KeyboardEvent) => {
            const mod = event.metaKey || event.ctrlKey;
            if (mod && (event.key === 'k' || event.key === 'K')) {
                event.preventDefault();
                setOpen((prev) => !prev);
            } else if (event.key === 'Escape' && open) {
                event.preventDefault();
                setOpen(false);
            }
        };
        window.addEventListener('keydown', handler);
        return () => {
            window.removeEventListener('keydown', handler);
        };
    }, [open]);

    // Reset transient state when the palette closes so reopening always
    // starts from a fresh empty box.
    useEffect(() => {
        if (!open) {
            setQuery('');
            setHits([]);
            setLoading(false);
        }
    }, [open]);

    const buildUrl = useCallback(
        (rawQuery: string, filterState: PaletteFilters) => {
            const params = new URLSearchParams();
            params.set('q', rawQuery);
            for (const cls of filterState.classes) params.append('class', cls);
            for (const status of filterState.statuses) params.append('status', status);
            const tags = filterState.tags
                .split(',')
                .map((t) => t.trim())
                .filter((t) => t.length > 0);
            for (const tag of tags) params.append('tag', tag);
            if (filterState.locked) params.set('locked', 'true');
            if (filterState.language.trim()) params.set('language', filterState.language.trim());
            return `/api/works/${encodeURIComponent(workId)}/kb/search?${params.toString()}`;
        },
        [workId],
    );

    // Debounced fetch on query / filter change. We keep a `cancelled`
    // flag per scheduled fetch so a stale response can't overwrite a
    // newer one. The empty-query branch clears results immediately
    // without firing a request.
    useEffect(() => {
        if (!open) return;
        const trimmed = query.trim();
        if (trimmed.length === 0) {
            setHits([]);
            setLoading(false);
            return;
        }

        let cancelled = false;
        setLoading(true);
        const timer = setTimeout(() => {
            fetch(buildUrl(trimmed, filters), { cache: 'no-store' })
                .then(async (res) => {
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    return (await res.json()) as KbSearchResult;
                })
                .then((data) => {
                    if (cancelled) return;
                    setHits(data.hits ?? []);
                })
                .catch(() => {
                    if (cancelled) return;
                    setHits([]);
                })
                .finally(() => {
                    if (cancelled) return;
                    setLoading(false);
                });
        }, debounceMs);

        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [open, query, filters, buildUrl, debounceMs]);

    const onResultSelect = useCallback(
        (hit: KbSearchHit) => {
            setOpen(false);
            router.push(`/works/${workId}/kb/${hit.path}`);
        },
        [router, workId],
    );

    const toggleClass = useCallback((cls: KbDocumentClass) => {
        setFilters((prev) => {
            const has = prev.classes.includes(cls);
            const next = has ? prev.classes.filter((c) => c !== cls) : [...prev.classes, cls];
            return { ...prev, classes: next };
        });
    }, []);

    const toggleStatus = useCallback((status: KbDocumentStatus) => {
        setFilters((prev) => {
            const has = prev.statuses.includes(status);
            const next = has
                ? prev.statuses.filter((s) => s !== status)
                : [...prev.statuses, status];
            return { ...prev, statuses: next };
        });
    }, []);

    const setTags = useCallback((tags: string) => {
        setFilters((prev) => ({ ...prev, tags }));
    }, []);

    const setLanguage = useCallback((language: string) => {
        setFilters((prev) => ({ ...prev, language }));
    }, []);

    const toggleLocked = useCallback(() => {
        setFilters((prev) => ({ ...prev, locked: !prev.locked }));
    }, []);

    const isEmpty = query.trim().length === 0;

    return (
        <div data-testid="kb-workbench-search-palette-root" data-open={open ? 'true' : 'false'}>
            {open ? (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-label={t('search.placeholder')}
                    data-testid="kb-workbench-search-palette"
                    className={cn(
                        'fixed inset-0 z-50 flex items-start justify-center',
                        'bg-black/50 dark:bg-black/70 p-4 pt-[10vh]',
                    )}
                    onClick={(e) => {
                        if (e.target === e.currentTarget) setOpen(false);
                    }}
                >
                    <Command
                        data-testid="kb-workbench-search-palette-cmd"
                        shouldFilter={false}
                        label={t('search.placeholder')}
                        className={cn(
                            'flex w-full max-w-2xl flex-col gap-2 rounded-lg border',
                            'border-border dark:border-border-dark',
                            'bg-surface dark:bg-surface-dark shadow-xl',
                            'overflow-hidden',
                        )}
                    >
                        <div className="flex items-center gap-2 border-b border-border dark:border-border-dark px-3 py-2">
                            <Search className="h-4 w-4 text-text-muted" aria-hidden="true" />
                            <Command.Input
                                data-testid="kb-workbench-search-palette-input"
                                autoFocus
                                value={query}
                                onValueChange={setQuery}
                                placeholder={t('search.placeholder')}
                                className={cn(
                                    'flex-1 bg-transparent text-sm outline-none',
                                    'text-text dark:text-text-dark',
                                    'placeholder:text-text-muted',
                                )}
                            />
                            <button
                                type="button"
                                data-testid="kb-workbench-search-palette-close"
                                aria-label="Close"
                                onClick={() => setOpen(false)}
                                className="rounded p-1 text-text-muted hover:text-text"
                            >
                                <X className="h-4 w-4" aria-hidden="true" />
                            </button>
                        </div>

                        <FilterBar
                            filters={filters}
                            labels={{
                                classFilter: t('search.filter.class'),
                                tagsFilter: t('search.filter.tags'),
                                statusFilter: t('search.filter.status'),
                                lockedFilter: t('search.filter.locked'),
                                languageFilter: t('search.filter.language'),
                                classLabel: (cls) => cls,
                                statusLabel: (status) =>
                                    status === 'active'
                                        ? t('metadata.statusActive')
                                        : status === 'archived'
                                          ? t('metadata.statusArchived')
                                          : t('metadata.statusDraft'),
                            }}
                            onToggleClass={toggleClass}
                            onToggleStatus={toggleStatus}
                            onTagsChange={setTags}
                            onLanguageChange={setLanguage}
                            onToggleLocked={toggleLocked}
                        />

                        <Command.List
                            data-testid="kb-workbench-search-palette-list"
                            className="max-h-[60vh] overflow-y-auto p-1"
                        >
                            {isEmpty ? (
                                <div
                                    data-testid="kb-workbench-search-palette-empty"
                                    className="px-3 py-6 text-center text-sm text-text-muted"
                                >
                                    {t('search.empty')}
                                </div>
                            ) : loading ? (
                                <LoadingShimmer label={t('search.searching')} />
                            ) : hits.length === 0 ? (
                                <Command.Empty
                                    data-testid="kb-workbench-search-palette-noresults"
                                    className="px-3 py-6 text-center text-sm text-text-muted"
                                >
                                    {t('search.noResults')}
                                </Command.Empty>
                            ) : (
                                hits.map((hit) => (
                                    <ResultRow
                                        key={hit.documentId}
                                        hit={hit}
                                        onSelect={onResultSelect}
                                    />
                                ))
                            )}
                        </Command.List>
                    </Command>
                </div>
            ) : null}
        </div>
    );
}

interface FilterBarLabels {
    classFilter: string;
    tagsFilter: string;
    statusFilter: string;
    lockedFilter: string;
    languageFilter: string;
    classLabel: (cls: KbDocumentClass) => string;
    statusLabel: (status: KbDocumentStatus) => string;
}

interface FilterBarProps {
    filters: PaletteFilters;
    labels: FilterBarLabels;
    onToggleClass: (cls: KbDocumentClass) => void;
    onToggleStatus: (status: KbDocumentStatus) => void;
    onTagsChange: (tags: string) => void;
    onLanguageChange: (lang: string) => void;
    onToggleLocked: () => void;
}

function FilterBar({
    filters,
    labels,
    onToggleClass,
    onToggleStatus,
    onTagsChange,
    onLanguageChange,
    onToggleLocked,
}: FilterBarProps) {
    return (
        <div
            data-testid="kb-workbench-search-palette-filters"
            className="flex flex-col gap-2 border-b border-border dark:border-border-dark px-3 py-2 text-xs"
        >
            <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-text-muted">{labels.classFilter}:</span>
                {KB_DOCUMENT_CLASSES.map((cls) => {
                    const selected = filters.classes.includes(cls);
                    return (
                        <button
                            key={cls}
                            type="button"
                            data-testid="kb-workbench-search-palette-class-chip"
                            data-kb-class={cls}
                            data-selected={selected ? 'true' : 'false'}
                            onClick={() => onToggleClass(cls)}
                            className={cn(
                                'rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide',
                                selected
                                    ? 'bg-primary text-white'
                                    : 'bg-primary/10 text-primary hover:bg-primary/20',
                            )}
                        >
                            {labels.classLabel(cls)}
                        </button>
                    );
                })}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-text-muted">{labels.statusFilter}:</span>
                {KB_DOCUMENT_STATUSES.map((status) => {
                    const selected = filters.statuses.includes(status);
                    return (
                        <button
                            key={status}
                            type="button"
                            data-testid="kb-workbench-search-palette-status-chip"
                            data-kb-status={status}
                            data-selected={selected ? 'true' : 'false'}
                            onClick={() => onToggleStatus(status)}
                            className={cn(
                                'rounded-full px-2 py-0.5 text-[11px] font-medium',
                                selected
                                    ? 'bg-primary text-white'
                                    : 'bg-primary/10 text-primary hover:bg-primary/20',
                            )}
                        >
                            {labels.statusLabel(status)}
                        </button>
                    );
                })}
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1">
                    <span className="text-text-muted">{labels.tagsFilter}:</span>
                    <input
                        type="text"
                        data-testid="kb-workbench-search-palette-tags-input"
                        value={filters.tags}
                        onChange={(e) => onTagsChange(e.target.value)}
                        placeholder="tag1, tag2"
                        className={cn(
                            'rounded border border-border dark:border-border-dark',
                            'bg-card-secondary dark:bg-card-primary-dark/40',
                            'px-2 py-0.5 text-xs',
                        )}
                    />
                </label>

                <label className="flex items-center gap-1">
                    <span className="text-text-muted">{labels.languageFilter}:</span>
                    <input
                        type="text"
                        data-testid="kb-workbench-search-palette-language-input"
                        value={filters.language}
                        onChange={(e) => onLanguageChange(e.target.value)}
                        placeholder="en"
                        spellCheck={false}
                        autoCapitalize="none"
                        autoCorrect="off"
                        className={cn(
                            'rounded border border-border dark:border-border-dark',
                            'bg-card-secondary dark:bg-card-primary-dark/40',
                            'px-2 py-0.5 text-xs font-mono w-16',
                        )}
                    />
                </label>

                <label className="flex items-center gap-1">
                    <input
                        type="checkbox"
                        data-testid="kb-workbench-search-palette-locked-toggle"
                        checked={filters.locked}
                        onChange={onToggleLocked}
                    />
                    <span className="text-text-muted">{labels.lockedFilter}</span>
                </label>
            </div>
        </div>
    );
}

interface ResultRowProps {
    hit: KbSearchHit;
    onSelect: (hit: KbSearchHit) => void;
}

function ResultRow({ hit, onSelect }: ResultRowProps) {
    return (
        <Command.Item
            data-testid="kb-workbench-search-palette-result"
            data-doc-id={hit.documentId}
            data-doc-path={hit.path}
            value={hit.documentId}
            onSelect={() => onSelect(hit)}
            className={cn(
                'flex flex-col gap-1 rounded-md px-3 py-2 text-sm',
                'aria-selected:bg-primary/10 aria-selected:text-primary',
                'cursor-pointer',
            )}
        >
            <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{hit.title || hit.path}</span>
                <span
                    data-testid="kb-workbench-search-palette-result-class"
                    className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-primary"
                >
                    {hit.class}
                </span>
            </div>
            {hit.snippet ? (
                <p
                    data-testid="kb-workbench-search-palette-result-snippet"
                    className="line-clamp-2 text-xs text-text-muted"
                >
                    {hit.snippet}
                </p>
            ) : null}
        </Command.Item>
    );
}

function LoadingShimmer({ label }: { label: string }) {
    return (
        <div
            data-testid="kb-workbench-search-palette-loading"
            role="status"
            aria-label={label}
            className="flex flex-col gap-2 p-3"
        >
            {[0, 1, 2].map((i) => (
                <div
                    key={i}
                    className="h-8 animate-pulse rounded-md bg-card-secondary/60 dark:bg-card-primary-dark/40"
                />
            ))}
            <span className="sr-only">{label}</span>
        </div>
    );
}

/**
 * Sentinel — exported solely so test files can assert on a stable icon
 * import without dragging the full lucide tree into the spec module.
 */
export const KB_SEARCH_PALETTE_LOCKED_ICON = LockIcon;
