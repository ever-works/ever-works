'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import {
    BookOpen,
    Building2,
    Database,
    FileText,
    Gavel,
    Globe2,
    Lightbulb,
    Lock,
    Milestone,
    Palette,
    Search,
    ShieldQuestion,
    Sparkles,
    UploadCloud,
    Users,
    Library,
    ChevronDown,
    ChevronRight,
    type LucideIcon,
} from 'lucide-react';
import { KB_DOCUMENT_CLASSES, KB_DOCUMENT_SOURCES } from '@ever-works/contracts';
import { KbOriginalsPanel } from './KbOriginalsPanel';
import { AgentMemoryPanel } from '@/components/memory/AgentMemoryPanel';
import type {
    KbDocumentClass,
    KbDocumentDto,
    KbDocumentSource,
    KbDocumentStatus,
} from '@ever-works/contracts';
import { KbDocumentContextMenu } from './KbDocumentContextMenu';
import { KbSourceBadge } from './KbSourceBadge';

/**
 * EW-641 slice A — workbench tree panel.
 *
 * Client component because the tab toggle (KB / Originals) is local
 * UI state and we fetch the doc metadata in-component (the workbench
 * page hands us a `workId` and we hit the same `/api/works/:id/kb/documents`
 * endpoint the server-side index page uses, but through the user's
 * session cookie via a relative `fetch`). Keeps the panel self-contained
 * — the parent route only needs to render `<KbTreePanel workId=… />`.
 *
 * Each class group is collapsible. Groups are collapsed by default with
 * the one exception of the group that contains `currentDocPath` (we
 * keep that one open so the active row is visible on first render).
 *
 * Drag-and-drop / right-click / inline rename are intentionally OUT of
 * scope here — slices C and E own those affordances.
 */

export interface KbTreePanelProps {
    workId: string;
    currentDocPath?: string;
    /**
     * EW-641 slice C — opt-in refresh token. When the parent (workbench
     * page) wants the tree to re-fetch (e.g. after a successful upload
     * via `WorkbenchUploadCoordinator`), it bumps this value and the
     * effect's dependency array picks up the change.
     */
    refreshKey?: number;
}

type Tab = 'kb' | 'originals' | 'agentMemory';

interface ListResponse {
    items: KbDocumentDto[];
    total: number;
}

const CLASS_ICONS: Record<KbDocumentClass, LucideIcon> = {
    brand: Sparkles,
    legal: Gavel,
    seo: Globe2,
    style: Palette,
    glossary: BookOpen,
    competitors: Building2,
    personas: Users,
    research: Search,
    output: FileText,
    freeform: Lightbulb,
    // Memory upgrades M4 — decision class. Icon only: the full decision
    // workbench UI (status chips, supersession chain view, review queue)
    // is a tracked follow-up; this entry keeps the exhaustive icon map
    // total so the tree renders decision docs like any other class.
    decision: Milestone,
};

export function KbTreePanel({ workId, currentDocPath, refreshKey }: KbTreePanelProps) {
    const t = useTranslations('dashboard.workDetail.kb');
    const [tab, setTab] = useState<Tab>('kb');
    const [documents, setDocuments] = useState<KbDocumentDto[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    // Memory facets — filter state. Every one of these is applied
    // SERVER-side (they become query params below), not by filtering the
    // already-fetched array: the tree is paginated upstream, so a
    // client-side filter would silently only search the first page.
    const [classFilter, setClassFilter] = useState<KbDocumentClass[]>([]);
    const [sourceFilter, setSourceFilter] = useState<KbDocumentSource[]>([]);
    const [search, setSearch] = useState('');
    // Debounced mirror of `search` — the input stays instant while the
    // network request waits for the user to stop typing.
    const [debouncedSearch, setDebouncedSearch] = useState('');

    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(search.trim()), 250);
        return () => clearTimeout(timer);
    }, [search]);

    const filterQuery = useMemo(() => {
        const params = new URLSearchParams();
        for (const cls of classFilter) params.append('class', cls);
        for (const source of sourceFilter) params.append('source', source);
        if (debouncedSearch.length > 0) {
            params.set('q', debouncedSearch);
            // Search titles AND content — a memory you can only find by
            // its title is a memory you cannot find.
            params.set('searchBody', 'true');
        }
        const qs = params.toString();
        return qs.length > 0 ? `?${qs}` : '';
    }, [classFilter, sourceFilter, debouncedSearch]);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        // eslint-disable-next-line no-restricted-syntax -- EW-790 baseline: unaudited, may be a real scope bug
        fetch(`/api/works/${encodeURIComponent(workId)}/kb/documents${filterQuery}`, {
            cache: 'no-store',
        })
            .then(async (res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return (await res.json()) as ListResponse;
            })
            .then((data) => {
                if (cancelled) return;
                setDocuments(data.items ?? []);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setError(err instanceof Error ? err.message : 'Failed to load');
            })
            .finally(() => {
                if (cancelled) return;
                setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [workId, refreshKey, filterQuery]);

    const filtersActive =
        classFilter.length > 0 || sourceFilter.length > 0 || debouncedSearch.length > 0;

    const grouped = useMemo(() => groupByClass(documents), [documents]);
    // Memory upgrades M8 — how many documents are waiting for review.
    // Derived from the list this panel already fetched (the KB list is
    // unfiltered, so `proposed` docs are in it) — zero extra requests.
    const proposedCount = useMemo(
        () => documents.filter((doc) => doc.reviewState === 'proposed').length,
        [documents],
    );
    // Pre-compute which class contains the active doc so it opens by
    // default on first render (without overriding subsequent user
    // toggles — see `expandedDefaults`).
    const activeClass = useMemo<KbDocumentClass | null>(() => {
        if (!currentDocPath) return null;
        const hit = documents.find((doc) => doc.path === currentDocPath);
        return hit?.class ?? null;
    }, [documents, currentDocPath]);

    return (
        <div data-testid="kb-workbench-tree" className="flex h-full flex-col" data-work-id={workId}>
            <header className="flex items-center gap-1 border-b border-border px-3 py-2 dark:border-border-dark">
                <h2 className="sr-only">{t('workbench.title')}</h2>
                <TreeTab
                    label={t('workbench.tab.kb')}
                    active={tab === 'kb'}
                    onClick={() => setTab('kb')}
                    testId="kb-workbench-tab-kb"
                />
                <TreeTab
                    label={t('workbench.tab.originals')}
                    active={tab === 'originals'}
                    onClick={() => setTab('originals')}
                    testId="kb-workbench-tab-originals"
                />
                {/* The third thing a Work's Memory holds. Documents and
                    originals are authored/uploaded; this is what the
                    agents themselves retained from their runs. Read-only
                    — sessions are written by agents during a run. */}
                <TreeTab
                    label={t('workbench.tab.agentMemory')}
                    active={tab === 'agentMemory'}
                    onClick={() => setTab('agentMemory')}
                    testId="kb-workbench-tab-agent-memory"
                />
                {/* Memory upgrades M8 — the review queue's entry point.
                    A link (not a tab) because the queue is its own route
                    inside the same workbench shell. The count badge is
                    what makes the queue discoverable at all: without it
                    `proposed` documents are captured and never surfaced. */}
                <Link
                    href={`${ROUTES.DASHBOARD_WORK_KB(workId)}/review`}
                    data-testid="kb-workbench-review-link"
                    aria-label={t('review.navAria', { count: proposedCount })}
                    className={cn(
                        'ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                        proposedCount > 0
                            ? 'text-amber-700 hover:bg-amber-500/10 dark:text-amber-300'
                            : 'text-text-muted hover:bg-card-hover hover:text-text dark:text-text-muted-dark/70 dark:hover:bg-card-primary-dark/40',
                    )}
                >
                    <ShieldQuestion className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{t('review.nav')}</span>
                    {proposedCount > 0 ? (
                        <span
                            data-testid="kb-workbench-review-badge"
                            className="rounded-full bg-amber-500/20 px-1.5 text-[10px] font-semibold text-amber-800 dark:text-amber-200"
                        >
                            {proposedCount}
                        </span>
                    ) : null}
                </Link>
            </header>

            {/* Memory facets — type + provenance chips and a search box
                over titles AND content. All three drive the SERVER query
                (see `filterQuery`), so the result set is the whole Work's
                KB, not just the page already in the browser. */}
            {tab === 'kb' ? (
                <KbFacetBar
                    search={search}
                    onSearchChange={setSearch}
                    classFilter={classFilter}
                    onToggleClass={(cls) =>
                        setClassFilter((prev) =>
                            prev.includes(cls) ? prev.filter((c) => c !== cls) : [...prev, cls],
                        )
                    }
                    sourceFilter={sourceFilter}
                    onToggleSource={(source) =>
                        setSourceFilter((prev) =>
                            prev.includes(source)
                                ? prev.filter((s) => s !== source)
                                : [...prev, source],
                        )
                    }
                    onClear={() => {
                        setClassFilter([]);
                        setSourceFilter([]);
                        setSearch('');
                    }}
                    filtersActive={filtersActive}
                    matchCount={documents.length}
                    labels={{
                        searchLabel: t('facets.searchLabel'),
                        searchPlaceholder: t('facets.searchPlaceholder'),
                        clear: t('facets.clear'),
                        typeLabel: t('facets.typeLabel'),
                        sourceLabel: t('facets.sourceLabel'),
                        activeCount: (count: number) => t('facets.activeCount', { count }),
                        classLabel: (cls: KbDocumentClass) => t(`classes.${cls}`),
                        sourceChipLabel: (source: KbDocumentSource) =>
                            t(`facets.badge.${SOURCE_TO_BADGE[source]}`),
                    }}
                />
            ) : null}

            <div className="flex-1 overflow-y-auto p-2">
                {tab === 'kb' ? (
                    <KbTab
                        workId={workId}
                        loading={loading}
                        error={error}
                        grouped={grouped}
                        emptyLabel={filtersActive ? t('facets.noMatches') : t('panes.tree.empty')}
                        currentDocPath={currentDocPath ?? null}
                        activeClass={activeClass}
                        labels={{
                            empty: t('panes.tree.empty'),
                            classLabel: (cls: KbDocumentClass) => t(`classes.${cls}`),
                            statusLabel: (status: KbDocumentStatus) => t(`status.${status}`),
                            lockedLabel: t('lock.full'),
                        }}
                    />
                ) : tab === 'originals' ? (
                    <KbOriginalsPanel workId={workId} refreshToken={refreshKey} />
                ) : (
                    <AgentMemoryPanel workId={workId} compact />
                )}
            </div>
        </div>
    );
}

interface KbTabProps {
    workId: string;
    loading: boolean;
    error: string | null;
    grouped: Map<KbDocumentClass, KbDocumentDto[]>;
    /**
     * Memory facets — "nothing here" and "nothing MATCHES" are different
     * messages: the first invites the user to add a document, the second
     * invites them to widen the filter.
     */
    emptyLabel: string;
    currentDocPath: string | null;
    activeClass: KbDocumentClass | null;
    labels: {
        empty: string;
        classLabel: (cls: KbDocumentClass) => string;
        statusLabel: (status: KbDocumentStatus) => string;
        lockedLabel: string;
    };
}

function KbTab({
    workId,
    loading,
    error,
    grouped,
    emptyLabel,
    currentDocPath,
    activeClass,
    labels,
}: KbTabProps) {
    if (loading) {
        return (
            <p
                data-testid="kb-workbench-tree-loading"
                className="px-2 py-1 text-xs text-text-muted dark:text-text-muted-dark/60"
            >
                …
            </p>
        );
    }
    if (error) {
        return (
            <p
                data-testid="kb-workbench-tree-error"
                className="px-2 py-1 text-xs text-red-600 dark:text-red-400"
            >
                {error}
            </p>
        );
    }
    if (grouped.size === 0) {
        return (
            <p
                data-testid="kb-workbench-tree-empty"
                className="px-2 py-1 text-sm text-text-muted dark:text-text-muted-dark/60"
            >
                {emptyLabel}
            </p>
        );
    }

    return (
        <nav aria-label="Knowledge Base" className="flex flex-col gap-1">
            {KB_DOCUMENT_CLASSES.map((cls) => {
                const docs = grouped.get(cls);
                if (!docs || docs.length === 0) return null;
                return (
                    <KbTreeGroup
                        key={cls}
                        workId={workId}
                        cls={cls}
                        label={labels.classLabel(cls)}
                        docs={docs}
                        defaultOpen={cls === activeClass}
                        currentDocPath={currentDocPath}
                        statusLabel={labels.statusLabel}
                        lockedLabel={labels.lockedLabel}
                    />
                );
            })}
        </nav>
    );
}

interface KbTreeGroupProps {
    workId: string;
    cls: KbDocumentClass;
    label: string;
    docs: KbDocumentDto[];
    defaultOpen: boolean;
    currentDocPath: string | null;
    statusLabel: (status: KbDocumentStatus) => string;
    lockedLabel: string;
}

function KbTreeGroup({
    workId,
    cls,
    label,
    docs,
    defaultOpen,
    currentDocPath,
    statusLabel,
    lockedLabel,
}: KbTreeGroupProps) {
    const [open, setOpen] = useState(defaultOpen);
    const Icon = CLASS_ICONS[cls] ?? FileText;
    const Chevron = open ? ChevronDown : ChevronRight;
    return (
        <div
            data-testid={`kb-workbench-group-${cls}`}
            data-kb-class={cls}
            className="flex flex-col"
        >
            <button
                type="button"
                onClick={() => setOpen((prev) => !prev)}
                aria-expanded={open}
                data-testid={`kb-workbench-group-toggle-${cls}`}
                className={cn(
                    'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left',
                    'text-[11px] font-semibold uppercase tracking-wider',
                    'text-text-muted hover:bg-card-hover dark:text-text-muted-dark/70',
                    'dark:hover:bg-card-primary-dark/40',
                )}
            >
                <Chevron className="h-3 w-3" aria-hidden="true" />
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{label}</span>
                <span className="ml-auto text-text-muted/60">({docs.length})</span>
            </button>
            {open ? (
                <ul className="ml-2 flex flex-col gap-0.5 border-l border-border/60 pl-2 dark:border-border-dark/60">
                    {docs.map((doc) => {
                        const isActive = currentDocPath === doc.path;
                        return (
                            <li key={doc.id}>
                                <KbDocumentContextMenu workId={workId} document={doc}>
                                    <Link
                                        href={`${ROUTES.DASHBOARD_WORK_KB(workId)}/${doc.path}`}
                                        data-testid={`kb-workbench-row-${doc.id}`}
                                        data-doc-path={doc.path}
                                        aria-current={isActive ? 'page' : undefined}
                                        className={cn(
                                            'flex items-center gap-2 rounded px-2 py-1 text-sm transition-colors',
                                            isActive
                                                ? 'bg-primary/10 text-text dark:bg-primary/20 dark:text-text-dark'
                                                : 'text-text-secondary hover:bg-card-hover hover:text-text dark:text-text-secondary-dark/80 dark:hover:bg-card-primary-dark/40 dark:hover:text-text-dark',
                                        )}
                                    >
                                        <FileText
                                            className="h-3.5 w-3.5 shrink-0 text-text-muted dark:text-text-muted-dark/60"
                                            aria-hidden="true"
                                        />
                                        <span className="truncate">{doc.title || doc.path}</span>
                                        {/* Memory facets — provenance at a
                                            glance. Derived from the source
                                            column + ingest provenance, so a
                                            connector-written memory is
                                            identifiable without opening it. */}
                                        <KbSourceBadge
                                            document={doc}
                                            compact
                                            className="ml-auto"
                                            testId={`kb-workbench-row-${doc.id}-source`}
                                        />
                                        {doc.locked ? (
                                            <Lock
                                                data-testid={`kb-workbench-row-${doc.id}-lock`}
                                                aria-label={lockedLabel}
                                                className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-300"
                                            />
                                        ) : null}
                                        {doc.status !== 'active' ? (
                                            <span
                                                data-testid={`kb-workbench-row-${doc.id}-status`}
                                                className={cn(
                                                    'rounded-full px-1.5 py-0.5 text-[10px] uppercase',
                                                    doc.status === 'draft'
                                                        ? 'bg-card-hover text-text-muted dark:bg-card-primary-dark/40 dark:text-text-muted-dark/70'
                                                        : 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
                                                )}
                                            >
                                                {statusLabel(doc.status)}
                                            </span>
                                        ) : null}
                                    </Link>
                                </KbDocumentContextMenu>
                            </li>
                        );
                    })}
                </ul>
            ) : null}
        </div>
    );
}

interface TreeTabProps {
    label: string;
    active: boolean;
    onClick: () => void;
    testId: string;
}

function TreeTab({ label, active, onClick, testId }: TreeTabProps) {
    return (
        <button
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={testId}
            onClick={onClick}
            className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                active
                    ? 'bg-primary/10 text-text dark:bg-primary/20 dark:text-text-dark'
                    : 'text-text-muted hover:bg-card-hover hover:text-text dark:text-text-muted-dark/70 dark:hover:bg-card-primary-dark/40 dark:hover:text-text-dark',
            )}
        >
            {label}
        </button>
    );
}

/**
 * Memory facets — the source CHIP labels reuse the badge vocabulary so
 * "filter by Agent" and the "Agent" badge on a row mean the same thing.
 *
 * The filter itself stays on the stored `source` column (an indexed
 * equality predicate); only the LABEL borrows the derived badge name.
 * `imported` maps to the connector badge because both mean "this came
 * from outside the platform" — the same rule
 * `deriveKbMemorySourceBadge` applies.
 */
const SOURCE_TO_BADGE: Record<KbDocumentSource, 'human' | 'agent' | 'connector'> = {
    user: 'human',
    seeded: 'human',
    agent: 'agent',
    imported: 'connector',
};

interface KbFacetBarProps {
    search: string;
    onSearchChange: (value: string) => void;
    classFilter: KbDocumentClass[];
    onToggleClass: (cls: KbDocumentClass) => void;
    sourceFilter: KbDocumentSource[];
    onToggleSource: (source: KbDocumentSource) => void;
    onClear: () => void;
    filtersActive: boolean;
    matchCount: number;
    labels: {
        searchLabel: string;
        searchPlaceholder: string;
        clear: string;
        typeLabel: string;
        sourceLabel: string;
        activeCount: (count: number) => string;
        classLabel: (cls: KbDocumentClass) => string;
        sourceChipLabel: (source: KbDocumentSource) => string;
    };
}

/**
 * Type + provenance chips and a search box over titles AND content.
 *
 * Every control here maps to a server query param — nothing filters the
 * already-fetched array. That matters because the KB list is paginated
 * upstream: a client-side filter would quietly search only the page in
 * the browser and confidently report "no matches" for a document that
 * exists.
 *
 * `seeded` is deliberately absent from the source chips: it is a
 * platform implementation detail (documents created on Work init), and
 * a filter nobody would ever choose is noise. Its rows still render the
 * `human` badge, so nothing is hidden — only the chip is omitted.
 */
function KbFacetBar({
    search,
    onSearchChange,
    classFilter,
    onToggleClass,
    sourceFilter,
    onToggleSource,
    onClear,
    filtersActive,
    matchCount,
    labels,
}: KbFacetBarProps) {
    const sourceChips = KB_DOCUMENT_SOURCES.filter((source) => source !== 'seeded');
    return (
        <div
            data-testid="kb-workbench-facets"
            className="flex flex-col gap-2 border-b border-border px-3 py-2 dark:border-border-dark"
        >
            <label className="relative block">
                <span className="sr-only">{labels.searchLabel}</span>
                <Search
                    className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted dark:text-text-muted-dark/60"
                    aria-hidden="true"
                />
                <input
                    type="search"
                    value={search}
                    onChange={(event) => onSearchChange(event.target.value)}
                    placeholder={labels.searchPlaceholder}
                    data-testid="kb-workbench-facet-search"
                    className={cn(
                        'w-full rounded-md border border-border bg-transparent py-1 pl-7 pr-2 text-xs',
                        'text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary',
                        'dark:border-border-dark dark:text-text-dark dark:placeholder:text-text-muted-dark/60',
                    )}
                />
            </label>

            <FacetChipGroup
                testId="kb-workbench-facet-types"
                label={labels.typeLabel}
                options={KB_DOCUMENT_CLASSES.map((cls) => ({
                    value: cls,
                    label: labels.classLabel(cls),
                    active: classFilter.includes(cls),
                    onToggle: () => onToggleClass(cls),
                    testId: `kb-workbench-facet-type-${cls}`,
                }))}
            />

            <FacetChipGroup
                testId="kb-workbench-facet-sources"
                label={labels.sourceLabel}
                options={sourceChips.map((source) => ({
                    value: source,
                    label: labels.sourceChipLabel(source),
                    active: sourceFilter.includes(source),
                    onToggle: () => onToggleSource(source),
                    testId: `kb-workbench-facet-source-${source}`,
                }))}
            />

            {filtersActive ? (
                <div className="flex items-center gap-2">
                    <span
                        data-testid="kb-workbench-facet-count"
                        className="text-[11px] text-text-muted dark:text-text-muted-dark/60"
                    >
                        {labels.activeCount(matchCount)}
                    </span>
                    <button
                        type="button"
                        onClick={onClear}
                        data-testid="kb-workbench-facet-clear"
                        className="ml-auto text-[11px] font-medium text-primary hover:underline"
                    >
                        {labels.clear}
                    </button>
                </div>
            ) : null}
        </div>
    );
}

interface FacetChipGroupProps {
    testId: string;
    label: string;
    options: Array<{
        value: string;
        label: string;
        active: boolean;
        onToggle: () => void;
        testId: string;
    }>;
}

function FacetChipGroup({ testId, label, options }: FacetChipGroupProps) {
    return (
        <div data-testid={testId} role="group" aria-label={label} className="flex flex-wrap gap-1">
            {options.map((option) => (
                <button
                    key={option.value}
                    type="button"
                    onClick={option.onToggle}
                    aria-pressed={option.active}
                    data-testid={option.testId}
                    className={cn(
                        'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide transition-colors',
                        option.active
                            ? 'bg-primary/15 text-primary'
                            : 'bg-card-hover text-text-muted hover:text-text dark:bg-card-primary-dark/40 dark:text-text-muted-dark/70 dark:hover:text-text-dark',
                    )}
                >
                    {option.label}
                </button>
            ))}
        </div>
    );
}

function groupByClass(documents: KbDocumentDto[]): Map<KbDocumentClass, KbDocumentDto[]> {
    const map = new Map<KbDocumentClass, KbDocumentDto[]>();
    for (const doc of documents) {
        const bucket = map.get(doc.class);
        if (bucket) {
            bucket.push(doc);
        } else {
            map.set(doc.class, [doc]);
        }
    }
    for (const docs of map.values()) {
        docs.sort((a, b) =>
            (a.title || a.path).localeCompare(b.title || b.path, undefined, {
                sensitivity: 'base',
            }),
        );
    }
    return map;
}
