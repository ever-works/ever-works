'use client';

import { useEffect, useMemo, useState, useTransition, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Download, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { Skill, SkillCardStateCounts, SkillCatalogEntry } from '@/lib/api/skills';
import type { SkillProvenance, SkillReadinessFilter, SkillShelfSort } from '@ever-works/contracts';
import { installCatalogSkillAction } from '@/app/actions/skills';
import { SkillShelf, SkillShelfGrid } from './SkillShelf';
import type { SkillTagFacetItem } from './SkillTagFilter';

type Section = 'installed' | 'available' | 'custom';

interface PageMeta {
    total: number;
    limit: number;
    offset: number;
}

interface SkillsPageClientProps {
    installed: Skill[];
    installedMeta: PageMeta;
    catalog: SkillCatalogEntry[];
    catalogTotal: number;
    catalogLimit: number;
    filters: {
        section: Section;
        search: string;
        installedOffset: number;
        catalogOffset: number;
        // Skills shelf — each absent at its default.
        tags?: string[];
        readiness?: SkillReadinessFilter;
        provenance?: SkillProvenance;
        enabled?: boolean;
        sort?: SkillShelfSort;
    };
    /** Skills shelf — tag chips with counts. */
    tagFacets?: SkillTagFacetItem[];
    /** Skills shelf — per-card-state counts for the summary line. */
    counts?: SkillCardStateCounts | null;
    loadErrors?: {
        installed?: string | null;
        catalog?: string | null;
    };
    /**
     * Navigation consolidation: this client is hosted twice — standalone on
     * `/skills` and as the Skills block on the Agents tab. `basePath`/`hash`
     * tell it which URL its tab/search/pagination state belongs to, so the
     * block rewrites `/agents?section=…#skills` instead of navigating the
     * user away to `/skills`.
     */
    basePath?: string;
    hash?: string;
}

const SECTIONS: Section[] = ['installed', 'available', 'custom'];

export function SkillsPageClient({
    installed,
    installedMeta,
    catalog,
    catalogTotal,
    catalogLimit,
    filters,
    loadErrors = {},
    basePath = ROUTES.DASHBOARD_SKILLS,
    hash = '',
    tagFacets = [],
    counts = null,
}: SkillsPageClientProps) {
    const t = useTranslations('dashboard.skillsPage');
    const router = useRouter();
    const [section, setSection] = useState<Section>(filters.section);
    const [installedItems, setInstalledItems] = useState(installed);
    const [search, setSearch] = useState(filters.search);

    useEffect(() => {
        setSection(filters.section);
        setSearch(filters.search);
        setInstalledItems(installed);
    }, [filters.section, filters.search, installed]);

    const tenantCatalogSlugs = useMemo(
        () =>
            new Set(
                installedItems
                    .filter((s) => s.ownerType === 'tenant' && s.sourceCatalogSlug)
                    .map((s) => s.sourceCatalogSlug as string),
            ),
        [installedItems],
    );
    const customSkills = useMemo(
        () => installedItems.filter((s) => !s.sourceCatalogSlug),
        [installedItems],
    );

    const updateUrl = (updates: Partial<typeof filters>) => {
        const next = {
            section,
            search,
            installedOffset: filters.installedOffset,
            catalogOffset: filters.catalogOffset,
            tags: filters.tags,
            readiness: filters.readiness,
            provenance: filters.provenance,
            enabled: filters.enabled,
            sort: filters.sort,
            ...updates,
        };
        const params = new URLSearchParams();
        if (next.section !== 'installed') params.set('section', next.section);
        if (next.search.trim()) params.set('search', next.search.trim());
        if (next.installedOffset > 0) params.set('installedOffset', String(next.installedOffset));
        if (next.catalogOffset > 0) params.set('catalogOffset', String(next.catalogOffset));
        // Skills shelf — same order and default-omission as `buildSkillsHref`.
        if (next.tags?.length) params.set('tags', next.tags.join(','));
        if (next.readiness) params.set('readiness', next.readiness);
        if (next.provenance) params.set('provenance', next.provenance);
        if (next.enabled !== undefined) params.set('enabled', String(next.enabled));
        if (next.sort && next.sort !== 'updated') params.set('sort', next.sort);
        router.replace(`${basePath}${params.size ? `?${params}` : ''}${hash}`);
    };

    const handleSectionChange = (next: Section) => {
        setSection(next);
        updateUrl({ section: next });
    };

    const handleSearch = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        updateUrl({ search: search.trim(), installedOffset: 0, catalogOffset: 0 });
    };

    return (
        <div className="space-y-4">
            <div
                role="tablist"
                aria-label={t('tabs.label')}
                className="flex items-center gap-2 flex-wrap"
            >
                {SECTIONS.map((s) => (
                    <button
                        key={s}
                        id={`skills-tab-${s}`}
                        type="button"
                        role="tab"
                        aria-selected={section === s}
                        aria-controls={`skills-panel-${s}`}
                        onClick={() => handleSectionChange(s)}
                        className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
                            section === s
                                ? 'border-border-secondary dark:border-border-secondary-dark bg-surface-secondary dark:bg-surface-secondary-dark font-medium text-text dark:text-text-dark'
                                : 'border-border/60 dark:border-border-dark/60 text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark hover:border-border dark:hover:border-border-dark'
                        }`}
                    >
                        {t(`tabs.${s}`)}
                    </button>
                ))}
            </div>

            <form onSubmit={handleSearch} className="flex flex-col gap-2 sm:flex-row">
                <label className="sr-only" htmlFor="skills-search">
                    {t('search.label')}
                </label>
                <div className="relative flex-1">
                    <Search
                        className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted dark:text-text-muted-dark"
                        aria-hidden="true"
                    />
                    <input
                        id="skills-search"
                        name="search"
                        type="search"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder={t('search.placeholder')}
                        className="h-9 w-full rounded-md border border-border/60 bg-card pl-8 pr-3 text-sm text-text outline-none focus:border-primary dark:border-border-dark/60 dark:bg-card-primary-dark dark:text-text-dark"
                    />
                </div>
                <div className="flex gap-2">
                    <Button type="submit" size="sm">
                        {t('search.submit')}
                    </Button>
                    {filters.search ? (
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                                updateUrl({ search: '', installedOffset: 0, catalogOffset: 0 })
                            }
                        >
                            {t('search.clear')}
                        </Button>
                    ) : null}
                </div>
            </form>

            {loadErrors.installed ? <LoadError message={t('errors.installed')} /> : null}
            {loadErrors.catalog ? <LoadError message={t('errors.catalog')} /> : null}

            {section === 'installed' && (
                <section
                    id="skills-panel-installed"
                    role="tabpanel"
                    aria-labelledby="skills-tab-installed"
                    className="space-y-4"
                >
                    <SkillShelf
                        skills={installedItems}
                        meta={installedMeta}
                        counts={counts}
                        tagFacets={tagFacets}
                        filters={{
                            search: filters.search,
                            tags: filters.tags,
                            readiness: filters.readiness,
                            sort: filters.sort,
                        }}
                        onFiltersChange={(updates) => {
                            if (updates.search !== undefined) setSearch(updates.search);
                            updateUrl({ ...updates, installedOffset: 0 });
                        }}
                        onFirstPage={() => updateUrl({ installedOffset: 0 })}
                        onBrowseCatalog={() => handleSectionChange('available')}
                    />
                    <Pagination
                        total={installedMeta.total}
                        limit={installedMeta.limit}
                        offset={installedMeta.offset}
                        empty={installedItems.length === 0}
                        onPage={(offset) => updateUrl({ installedOffset: offset })}
                    />
                </section>
            )}
            {section === 'available' && (
                <section
                    id="skills-panel-available"
                    role="tabpanel"
                    aria-labelledby="skills-tab-available"
                    className="space-y-4"
                >
                    <CatalogList
                        entries={catalog}
                        installedSlugs={tenantCatalogSlugs}
                        onInstalled={(skill) => setInstalledItems((prev) => [skill, ...prev])}
                    />
                    <Pagination
                        total={catalogTotal}
                        limit={catalogLimit}
                        offset={filters.catalogOffset}
                        empty={catalog.length === 0}
                        onPage={(offset) => updateUrl({ catalogOffset: offset })}
                    />
                </section>
            )}
            {section === 'custom' && (
                <section
                    id="skills-panel-custom"
                    role="tabpanel"
                    aria-labelledby="skills-tab-custom"
                >
                    <CustomSection skills={customSkills} />
                </section>
            )}
        </div>
    );
}

function LoadError({ message }: { message: string }) {
    return (
        <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
            {message}
        </div>
    );
}

/**
 * The Custom section's card grid. Skills shelf: the cards are the same
 * `SkillShelfGrid` the Installed shelf renders, so a Skill shows the same
 * badge and on/off switch wherever it appears; the empty state is unchanged.
 */
function InstalledList({ installed }: { installed: Skill[] }) {
    const t = useTranslations('dashboard.skillsPage');
    if (installed.length === 0) {
        return (
            <div className="rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-6 text-sm text-text-muted dark:text-text-muted-dark">
                <p className="font-medium text-text dark:text-text-dark">{t('empty.title')}</p>
                <p className="mt-1">{t('empty.subtitle')}</p>
            </div>
        );
    }
    return <SkillShelfGrid skills={installed} />;
}

function CatalogList({
    entries,
    installedSlugs,
    onInstalled,
}: {
    entries: SkillCatalogEntry[];
    installedSlugs: Set<string>;
    onInstalled: (skill: Skill) => void;
}) {
    const t = useTranslations('dashboard.skillsPage');
    if (entries.length === 0) {
        return (
            <div className="rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-6 text-sm text-text-muted dark:text-text-muted-dark">
                <p className="font-medium text-text dark:text-text-dark">
                    {t('catalog.emptyTitle')}
                </p>
                <p className="mt-1">{t('catalog.emptySubtitle')}</p>
            </div>
        );
    }
    return (
        <div className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4">
            {entries.map((e) => (
                <CatalogCard
                    key={e.slug}
                    entry={e}
                    alreadyInstalled={installedSlugs.has(e.slug)}
                    onInstalled={onInstalled}
                />
            ))}
        </div>
    );
}

function CatalogCard({
    entry,
    alreadyInstalled,
    onInstalled,
}: {
    entry: SkillCatalogEntry;
    alreadyInstalled: boolean;
    onInstalled: (skill: Skill) => void;
}) {
    const t = useTranslations('dashboard.skillsPage');
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [done, setDone] = useState(alreadyInstalled);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setDone(alreadyInstalled);
    }, [alreadyInstalled]);

    const handleInstall = () => {
        setError(null);
        startTransition(() => {
            void (async () => {
                try {
                    const skill = await installCatalogSkillAction({ slug: entry.slug });
                    setDone(true);
                    onInstalled(skill);
                    router.refresh();
                } catch (err) {
                    setError(err instanceof Error ? err.message : t('catalog.installFailed'));
                }
            })();
        });
    };

    return (
        <div className="flex flex-col rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-4 hover:border-border dark:hover:border-border-dark transition-colors">
            <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-text dark:text-text-dark truncate">
                    {entry.title}
                </h3>
                <span className="shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary dark:text-text-secondary-dark">
                    v{entry.version}
                </span>
            </div>
            <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1.5 line-clamp-2 min-h-8">
                {entry.description}
            </p>
            <div className="flex items-center justify-between gap-2 mt-4 pt-3 border-t border-border/40 dark:border-border-dark/40 text-[11px] text-text-secondary dark:text-text-secondary-dark">
                <span className="min-w-0 truncate font-mono">{entry.slug}</span>
                <Button
                    size="sm"
                    variant={done ? 'ghost' : 'primary'}
                    onClick={handleInstall}
                    disabled={pending || done}
                    className="gap-1.5 shrink-0"
                >
                    <Download className="w-3.5 h-3.5" aria-hidden="true" />
                    {done
                        ? t('catalog.installed')
                        : pending
                          ? t('catalog.installing')
                          : t('catalog.install')}
                </Button>
            </div>
            {error && (
                <p className="text-xs text-danger mt-2" role="alert">
                    {error}
                </p>
            )}
        </div>
    );
}

function CustomSection({ skills }: { skills: Skill[] }) {
    const t = useTranslations('dashboard.skillsPage');

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('custom.summary', { count: skills.length })}
                </p>
                <Button
                    size="sm"
                    variant="primary"
                    href={ROUTES.DASHBOARD_SKILL_NEW}
                    className="gap-1.5"
                >
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('custom.new')}
                </Button>
            </div>

            <InstalledList installed={skills} />
        </div>
    );
}

function Pagination({
    total,
    limit,
    offset,
    empty,
    onPage,
}: {
    total: number;
    limit: number;
    offset: number;
    empty: boolean;
    onPage: (offset: number) => void;
}) {
    const t = useTranslations('dashboard.skillsPage');
    const hasPrevious = offset > 0;
    const hasNext = offset + limit < total;
    if (!hasPrevious && !hasNext) return null;

    return (
        <nav className="flex items-center justify-between gap-3 text-xs text-text-muted dark:text-text-muted-dark">
            {empty ? (
                <span>{t('pagination.emptyPage')}</span>
            ) : (
                <span>
                    {t('pagination.showing', {
                        start: offset + 1,
                        end: Math.min(offset + limit, total),
                        total,
                    })}
                </span>
            )}
            <div className="flex items-center gap-2">
                <Button
                    size="sm"
                    variant="ghost"
                    disabled={!hasPrevious}
                    onClick={() => onPage(Math.max(0, offset - limit))}
                >
                    {t('pagination.previous')}
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    disabled={!hasNext}
                    onClick={() => onPage(offset + limit)}
                >
                    {t('pagination.next')}
                </Button>
            </div>
        </nav>
    );
}
