'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Brain, Search, FileText, FolderClosed, Building2, X, Loader2 } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import {
    buildMemoryQuery,
    type MemoryFacet,
    type MemoryFilters,
    type MemoryResponse,
} from '@/lib/api/memory-types';

interface MemoryShellProps {
    initial: MemoryResponse;
}

/** Facet kinds that map to a filter chip group. */
type FacetKind = 'type' | 'work' | 'status' | 'source';

const DEFAULT_LIMIT = 200;

function titleCase(value: string): string {
    if (!value) return value;
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Org-wide Memory (Cortex P1) — the interactive client shell.
 *
 * Renders the search box, header counters, filter chips (Type / Work /
 * Source / Status), and the ranked document list over the active
 * Organization's aggregated Knowledge Base. Re-queries the same-origin
 * BFF proxy (`/api/memory`) on search/filter changes; the Organization
 * itself is resolved server-side from the session scope, so the shell
 * never passes an org id.
 *
 * Mission / Team filters and the Graph view are deliberately deferred
 * (they depend on cross-feature prerequisites — see the Memory spec
 * §2.4 / §4.3).
 */
export function MemoryShell({ initial }: MemoryShellProps) {
    const t = useTranslations('dashboard.memoryPage');

    const [data, setData] = useState<MemoryResponse>(initial);
    const [query, setQuery] = useState('');
    const [filters, setFilters] = useState<Required<Pick<MemoryFilters, FacetKind>>>({
        type: [],
        work: [],
        status: [],
        source: [],
    });
    const [isLoading, setIsLoading] = useState(false);

    // Skip the very first effect run — the server already handed us the
    // initial payload, so an immediate refetch would be wasted work.
    const didMount = useRef(false);

    // Tracks the in-flight request so a newer fetch can cancel an older
    // one — otherwise a slower earlier response could resolve last and
    // overwrite fresher data (stale-data race on rapid search/filter).
    const inflightRef = useRef<AbortController | null>(null);

    const runFetch = useCallback(async (nextQuery: string, nextFilters: typeof filters) => {
        const qs = buildMemoryQuery({
            q: nextQuery || undefined,
            type: nextFilters.type,
            work: nextFilters.work,
            status: nextFilters.status,
            source: nextFilters.source,
            limit: DEFAULT_LIMIT,
        });
        // Abort any request still in flight and become the current one.
        inflightRef.current?.abort();
        const controller = new AbortController();
        inflightRef.current = controller;
        setIsLoading(true);
        try {
            const res = await fetch(`/api/memory${qs}`, {
                method: 'GET',
                headers: { Accept: 'application/json' },
                cache: 'no-store',
                signal: controller.signal,
            });
            if (!res.ok) return;
            const body = (await res.json()) as MemoryResponse;
            // Guard against a late resolve that lost the race (defensive —
            // an aborted fetch rejects, but this also covers a superseded
            // request whose body read finishes after a newer one started).
            if (inflightRef.current !== controller) return;
            setData(body);
        } catch {
            // Best-effort — keep the last good payload on a transient error
            // (an aborted request lands here too and is intentionally a no-op).
        } finally {
            // Only the current request owns the loading flag; a superseded
            // one must not clear it out from under its replacement.
            if (inflightRef.current === controller) {
                setIsLoading(false);
            }
        }
    }, []);

    // Debounced refetch on any search/filter change.
    useEffect(() => {
        if (!didMount.current) {
            didMount.current = true;
            return;
        }
        const handle = setTimeout(() => {
            void runFetch(query, filters);
        }, 300);
        return () => clearTimeout(handle);
    }, [query, filters, runFetch]);

    const toggleFacet = useCallback((kind: FacetKind, value: string) => {
        setFilters((prev) => {
            const current = prev[kind];
            const next = current.includes(value)
                ? current.filter((v) => v !== value)
                : [...current, value];
            return { ...prev, [kind]: next };
        });
    }, []);

    const clearAll = useCallback(() => {
        setQuery('');
        setFilters({ type: [], work: [], status: [], source: [] });
    }, []);

    const activeCount =
        filters.type.length + filters.work.length + filters.status.length + filters.source.length;
    const hasActiveFilters = activeCount > 0 || query.length > 0;

    const { documents, counts, facets } = data;

    return (
        <div
            data-testid="memory-shell"
            className="flex flex-col h-full min-h-0 p-4 sm:p-6 lg:p-8 gap-6"
        >
            {/* Header */}
            <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="flex items-start gap-3 min-w-0">
                    <span className="shrink-0 mt-0.5 inline-flex items-center justify-center w-9 h-9 rounded-lg bg-surface-secondary dark:bg-card-primary-dark">
                        <Brain className="w-5 h-5" strokeWidth={1.5} />
                    </span>
                    <div className="min-w-0">
                        <h1 className="text-xl font-semibold text-text dark:text-text-dark">
                            {t('title')}
                        </h1>
                        <p className="text-sm text-text-muted dark:text-text-muted-dark max-w-2xl">
                            {t('subtitle')}
                        </p>
                    </div>
                </div>
                {/*
                 * TODO(Cortex P1): restore a "New document" action once a
                 * dedicated org-memory doc-create flow exists. It previously
                 * linked to ROUTES.DASHBOARD_WORKS (the Works list), which is
                 * unrelated to creating a KB document — hidden for now rather
                 * than mis-navigating the user.
                 */}
            </div>

            {/* Search */}
            <div className="relative">
                <Search
                    className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted dark:text-text-muted-dark pointer-events-none"
                    strokeWidth={1.5}
                />
                <input
                    data-testid="memory-search"
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('searchPlaceholder')}
                    className={cn(
                        'w-full text-sm rounded-lg transition-colors outline-none pl-9 pr-9 py-2.5',
                        'bg-card dark:bg-card-primary-dark',
                        'border border-card-border dark:border-white/9',
                        'text-text dark:text-text-dark placeholder-text-muted dark:placeholder-text-muted-dark',
                        'focus:border-primary dark:focus:border-white/20 focus:ring-2 focus:ring-primary-800/20',
                    )}
                />
                {isLoading && (
                    <Loader2
                        className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted dark:text-text-muted-dark animate-spin"
                        strokeWidth={1.5}
                    />
                )}
            </div>

            {/* Header counts */}
            <div className="flex items-center gap-2 text-sm text-text-muted dark:text-text-muted-dark">
                <span className="font-medium text-text dark:text-text-dark">
                    {t('documentsIndexed', { count: counts.indexed })}
                </span>
                {facets.works.length > 0 && (
                    <>
                        <span aria-hidden>·</span>
                        <span>{t('worksCovered', { count: facets.works.length })}</span>
                    </>
                )}
            </div>

            {/* Filter chips */}
            <div className="flex flex-col gap-3">
                <FacetRow
                    kind="type"
                    label={t('filters.type')}
                    facets={facets.types}
                    selected={filters.type}
                    onToggle={toggleFacet}
                    renderLabel={titleCase}
                />
                <FacetRow
                    kind="work"
                    label={t('filters.work')}
                    facets={facets.works}
                    selected={filters.work}
                    onToggle={toggleFacet}
                />
                <FacetRow
                    kind="source"
                    label={t('filters.source')}
                    facets={facets.sources}
                    selected={filters.source}
                    onToggle={toggleFacet}
                    renderLabel={titleCase}
                />
                <FacetRow
                    kind="status"
                    label={t('filters.status')}
                    facets={facets.statuses}
                    selected={filters.status}
                    onToggle={toggleFacet}
                    renderLabel={titleCase}
                />
                {hasActiveFilters && (
                    <button
                        type="button"
                        onClick={clearAll}
                        className="self-start inline-flex items-center gap-1 text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark transition-colors"
                    >
                        <X className="w-3 h-3" strokeWidth={1.5} />
                        {t('filters.clearAll')}
                    </button>
                )}
            </div>

            {/* List body */}
            <div className="flex-1 min-h-0 overflow-y-auto">
                {documents.length === 0 ? (
                    <EmptyState
                        title={
                            hasActiveFilters
                                ? t('empty.noResults')
                                : counts.documents === 0
                                  ? t('empty.title')
                                  : t('empty.noResults')
                        }
                        subtitle={hasActiveFilters ? undefined : t('empty.subtitle')}
                    />
                ) : (
                    <ul className="flex flex-col gap-2">
                        {documents.map((doc) => (
                            <li key={doc.id}>
                                <MemoryRow doc={doc} orgLabel={t('orgScoped')} />
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}

function FacetRow({
    kind,
    label,
    facets,
    selected,
    onToggle,
    renderLabel,
}: {
    kind: FacetKind;
    label: string;
    facets: MemoryFacet[];
    selected: string[];
    onToggle: (kind: FacetKind, value: string) => void;
    renderLabel?: (value: string) => string;
}) {
    if (facets.length === 0) return null;
    return (
        <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-text-muted dark:text-text-muted-dark w-14 shrink-0">
                {label}
            </span>
            <div className="flex items-center gap-1.5 flex-wrap">
                {facets.map((facet) => {
                    const isActive = selected.includes(facet.value);
                    return (
                        <button
                            key={facet.value}
                            type="button"
                            data-testid={`memory-filter-chip-${kind}:${facet.value}`}
                            onClick={() => onToggle(kind, facet.value)}
                            aria-pressed={isActive}
                            className={cn(
                                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                                isActive
                                    ? 'bg-primary/10 border-primary/40 text-primary dark:text-white'
                                    : 'bg-card dark:bg-card-primary-dark border-card-border dark:border-white/9 text-text dark:text-text-secondary-dark/80 hover:border-border-secondary dark:hover:border-white/20',
                            )}
                        >
                            <span className="truncate max-w-[12rem]">
                                {renderLabel ? renderLabel(facet.label) : facet.label}
                            </span>
                            <span
                                className={cn(
                                    'rounded-full px-1.5 text-[10px] leading-4',
                                    isActive
                                        ? 'bg-primary/20'
                                        : 'bg-surface-secondary dark:bg-white/9 text-text-muted dark:text-text-muted-dark',
                                )}
                            >
                                {facet.count}
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

function MemoryRow({
    doc,
    orgLabel,
}: {
    doc: MemoryResponse['documents'][number];
    orgLabel: string;
}) {
    return (
        <div
            data-testid={`memory-doc-${doc.id}`}
            className={cn(
                'group flex items-start gap-3 rounded-lg border p-3 transition-colors',
                'bg-card dark:bg-card-primary-dark border-card-border dark:border-white/9',
                'hover:border-border-secondary dark:hover:border-white/20',
            )}
        >
            <span className="shrink-0 mt-0.5 inline-flex items-center justify-center w-8 h-8 rounded-md bg-surface-secondary dark:bg-white/5">
                <FileText
                    className="w-4 h-4 text-text-muted dark:text-text-muted-dark"
                    strokeWidth={1.5}
                />
            </span>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-text dark:text-text-dark truncate">
                        {doc.title}
                    </span>
                    <span className="inline-flex items-center rounded border border-card-border dark:border-white/9 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                        {doc.class}
                    </span>
                </div>
                {doc.description && (
                    <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark line-clamp-2">
                        {doc.description}
                    </p>
                )}
                <div className="mt-1.5 flex items-center gap-3 text-xs text-text-muted dark:text-text-muted-dark flex-wrap">
                    {doc.workId ? (
                        <Link
                            href={ROUTES.DASHBOARD_WORK_KB(doc.workId)}
                            className="inline-flex items-center gap-1 hover:text-text dark:hover:text-text-dark transition-colors"
                        >
                            <FolderClosed className="w-3 h-3" strokeWidth={1.5} />
                            <span className="truncate max-w-[14rem]">
                                {doc.workName ?? doc.workId}
                            </span>
                        </Link>
                    ) : (
                        <span className="inline-flex items-center gap-1">
                            <Building2 className="w-3 h-3" strokeWidth={1.5} />
                            {orgLabel}
                        </span>
                    )}
                    <span aria-hidden>·</span>
                    <span>{formatDate(doc.updatedAt)}</span>
                </div>
            </div>
        </div>
    );
}

function EmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
    return (
        <div className="flex flex-col items-center justify-center text-center py-16 px-6">
            <span className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-surface-secondary dark:bg-card-primary-dark mb-4">
                <Brain
                    className="w-6 h-6 text-text-muted dark:text-text-muted-dark"
                    strokeWidth={1.5}
                />
            </span>
            <p className="text-sm font-medium text-text dark:text-text-dark">{title}</p>
            {subtitle && (
                <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark max-w-md">
                    {subtitle}
                </p>
            )}
        </div>
    );
}
