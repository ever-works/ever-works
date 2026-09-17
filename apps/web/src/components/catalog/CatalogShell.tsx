'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Search, Sparkles, X } from 'lucide-react';
import {
    CATALOG_SEARCH_MIN_CHARS,
    PLAYBOOK_CATEGORIES,
    type PlaybookCategory,
} from '@ever-works/contracts';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { CatalogSection } from './CatalogSection';
import { PlaybookCard } from './PlaybookCard';
import { StartingPointsRow } from './StartingPointsRow';
import { TaskTemplateMiniCard } from './TaskTemplateMiniCard';
import { WorkflowList } from './WorkflowList';
import {
    READINESS_FILTERS,
    filterCatalog,
    type CatalogIndexData,
    type ReadinessFilterKey,
} from './catalog-data';

/** Cards each section shows on the index before `See all`. */
export const CATALOG_SECTION_PREVIEW = 6;
export const CATALOG_SEARCH_DEBOUNCE_MS = 250;

const CARD_SELECTOR = '[data-catalog-card]';

function chipClass(active: boolean): string {
    return cn(
        'rounded-full px-3 py-1 text-xs transition-colors cursor-pointer',
        active
            ? 'bg-button-primary dark:bg-white text-white dark:text-gray-900'
            : 'bg-surface-secondary dark:bg-white/9 text-text-secondary dark:text-text-secondary-dark hover:bg-surface-tertiary dark:hover:bg-white/20',
    );
}

function toggle<T>(set: ReadonlySet<T>, value: T): Set<T> {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
}

/** Move focus between cards inside one grid with the arrow keys. */
function moveCardFocus(event: KeyboardEvent<HTMLElement>) {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
    if (!keys.includes(event.key)) return;
    const cards = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(CARD_SELECTOR));
    const index = cards.indexOf(document.activeElement as HTMLElement);
    if (index === -1) return;
    event.preventDefault();
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const next = cards[Math.min(cards.length - 1, Math.max(0, index + (forward ? 1 : -1)))];
    next?.focus();
}

/**
 * The catalogue index: one search and two chip rows over five sections that
 * were all rendered on the server. Filtering happens here, on data that is
 * already loaded, so narrowing the page costs no network round trip.
 */
export function CatalogShell({ data }: { data: CatalogIndexData }) {
    const t = useTranslations('dashboard.catalogPage');
    const router = useRouter();
    const searchRef = useRef<HTMLInputElement>(null);
    const [input, setInput] = useState('');
    const [query, setQuery] = useState('');
    const [categories, setCategories] = useState<ReadonlySet<PlaybookCategory>>(new Set());
    const [readiness, setReadiness] = useState<ReadonlySet<ReadinessFilterKey>>(new Set());
    const [allPlaybooks, setAllPlaybooks] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => setQuery(input), CATALOG_SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [input]);

    // `/` focuses search from anywhere on the page, unless the person is
    // already typing into a field.
    useEffect(() => {
        const onKeyDown = (event: globalThis.KeyboardEvent) => {
            if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
            const target = event.target as HTMLElement | null;
            const typing =
                target instanceof HTMLInputElement ||
                target instanceof HTMLTextAreaElement ||
                target?.isContentEditable === true;
            if (typing) return;
            event.preventDefault();
            searchRef.current?.focus();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, []);

    const activeQuery = query.trim().length >= CATALOG_SEARCH_MIN_CHARS ? query.trim() : '';
    const searching = activeQuery.length > 0;
    const filtered = useMemo(
        () => filterCatalog(data, { query: activeQuery, categories, readiness }),
        [data, activeQuery, categories, readiness],
    );

    const startingPoints = useMemo(() => {
        if (!searching) return data.startingPoints.items;
        const needle = activeQuery.toLowerCase();
        return data.startingPoints.items.filter((point) =>
            t(`startingPoints.${point.kind}`).toLowerCase().includes(needle),
        );
    }, [data.startingPoints.items, searching, activeQuery, t]);

    const nothingMatches =
        searching &&
        filtered.playbooks.length +
            filtered.skills.length +
            filtered.workflows.length +
            filtered.taskTemplates.length +
            startingPoints.length ===
            0;

    const clearSearch = () => {
        setInput('');
        setQuery('');
    };

    const retry = () => router.refresh();
    const count = (n: number) => (searching ? n : null);
    const noMatches = (
        <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('empty.noMatches')}</p>
    );
    const readyCount = data.playbooks.items.filter((item) => item.readiness === 'ready').length;
    const nothingAdopted = !data.playbooks.items.some((item) => item.readiness === 'adopted');

    return (
        <div className="space-y-8">
            <div className="space-y-2">
                <label htmlFor="catalog-search" className="sr-only">
                    {t('searchLabel')}
                </label>
                <div className="relative max-w-md">
                    <Search
                        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
                        aria-hidden="true"
                    />
                    <input
                        id="catalog-search"
                        ref={searchRef}
                        type="search"
                        value={input}
                        onChange={(event) => setInput(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                                clearSearch();
                                event.currentTarget.blur();
                            }
                        }}
                        placeholder={t('searchPlaceholder')}
                        aria-describedby="catalog-search-hint"
                        className="w-full rounded-md border border-border dark:border-border-dark bg-surface dark:bg-surface-dark py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                </div>
                <p
                    id="catalog-search-hint"
                    className="text-xs text-text-muted dark:text-text-muted-dark"
                >
                    {input.trim().length > 0 && input.trim().length < CATALOG_SEARCH_MIN_CHARS
                        ? t('searchTooShort')
                        : t('searchShortcut')}
                </p>
                {nothingMatches && (
                    <div
                        role="status"
                        data-testid="catalog-no-results"
                        className="flex flex-wrap items-center gap-3 rounded-lg border border-border dark:border-border-dark p-3 text-sm"
                    >
                        <span>{t('searchNoResults', { query: activeQuery })}</span>
                        <button
                            type="button"
                            onClick={clearSearch}
                            className="inline-flex items-center gap-1 rounded-md border border-border dark:border-border-dark px-2 py-1 text-xs font-medium"
                        >
                            <X className="h-3 w-3" aria-hidden="true" />
                            {t('searchClear')}
                        </button>
                    </div>
                )}
            </div>

            <CatalogSection
                id="playbooks"
                title={t('sections.playbooks')}
                total={data.playbooks.total}
                matchCount={count(filtered.playbooks.length)}
                onSeeAll={
                    !allPlaybooks && filtered.playbooks.length > CATALOG_SECTION_PREVIEW
                        ? () => setAllPlaybooks(true)
                        : undefined
                }
                error={data.playbooks.error}
                onRetry={retry}
                isEmpty={filtered.playbooks.length === 0}
                empty={
                    data.playbooks.total === 0 ? (
                        <p className="text-sm text-text-muted">{t('empty.playbooks')}</p>
                    ) : (
                        noMatches
                    )
                }
                headerExtra={
                    !data.playbooks.error && data.playbooks.total > 0 ? (
                        <div className="space-y-2">
                            {nothingAdopted && (
                                <p
                                    data-testid="catalog-first-visit"
                                    className="flex items-center gap-2 rounded-lg bg-primary/5 px-3 py-2 text-sm text-text dark:text-text-dark"
                                >
                                    <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
                                    {t('firstVisitBanner')}
                                </p>
                            )}
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('readyCount', {
                                    ready: readyCount,
                                    total: data.playbooks.total,
                                })}
                            </p>
                            <div
                                role="group"
                                aria-label={t('filters.categoryGroup')}
                                className="flex flex-wrap gap-2"
                            >
                                <button
                                    type="button"
                                    aria-pressed={categories.size === 0}
                                    onClick={() => setCategories(new Set())}
                                    className={chipClass(categories.size === 0)}
                                >
                                    {t('filters.all')}
                                </button>
                                {PLAYBOOK_CATEGORIES.map((category) => (
                                    <button
                                        key={category}
                                        type="button"
                                        aria-pressed={categories.has(category)}
                                        onClick={() =>
                                            setCategories((current) => toggle(current, category))
                                        }
                                        className={chipClass(categories.has(category))}
                                    >
                                        {t(`categories.${category}`)}
                                    </button>
                                ))}
                            </div>
                            <div
                                role="group"
                                aria-label={t('filters.readinessGroup')}
                                className="flex flex-wrap gap-2"
                            >
                                {(Object.keys(READINESS_FILTERS) as ReadinessFilterKey[]).map(
                                    (key) => (
                                        <button
                                            key={key}
                                            type="button"
                                            aria-pressed={readiness.has(key)}
                                            onClick={() =>
                                                setReadiness((current) => toggle(current, key))
                                            }
                                            className={chipClass(readiness.has(key))}
                                        >
                                            {t(`filters.${key}`)}
                                        </button>
                                    ),
                                )}
                            </div>
                        </div>
                    ) : null
                }
            >
                <ul
                    onKeyDown={moveCardFocus}
                    className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
                >
                    {(allPlaybooks
                        ? filtered.playbooks
                        : filtered.playbooks.slice(0, CATALOG_SECTION_PREVIEW)
                    ).map((playbook) => (
                        <li key={playbook.slug}>
                            <PlaybookCard playbook={playbook} />
                        </li>
                    ))}
                </ul>
            </CatalogSection>

            <CatalogSection
                id="skills"
                title={t('sections.skills')}
                total={data.skills.total}
                matchCount={count(filtered.skills.length)}
                seeAllHref={ROUTES.DASHBOARD_AGENTS_SKILLS}
                error={data.skills.error}
                onRetry={retry}
                isEmpty={filtered.skills.length === 0}
                empty={
                    data.skills.total === 0 ? (
                        <p className="text-sm text-text-muted">
                            {t('empty.skills')}{' '}
                            <Link
                                href={ROUTES.DASHBOARD_AGENTS_SKILLS}
                                className="text-primary hover:underline"
                            >
                                {t('empty.skillsAction')}
                            </Link>
                        </p>
                    ) : (
                        noMatches
                    )
                }
            >
                <ul
                    onKeyDown={moveCardFocus}
                    className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
                >
                    {filtered.skills.slice(0, CATALOG_SECTION_PREVIEW).map((skill) => (
                        <li key={skill.slug}>
                            <Link
                                href={ROUTES.DASHBOARD_AGENTS_SKILLS}
                                data-catalog-card
                                data-testid="skill-card"
                                className="flex h-full flex-col gap-1 rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-3 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                            >
                                <span className="text-sm font-medium text-text dark:text-text-dark">
                                    {skill.title}
                                </span>
                                <span className="line-clamp-2 text-xs text-text-muted dark:text-text-muted-dark">
                                    {skill.description}
                                </span>
                                <span
                                    className={cn(
                                        'mt-auto text-xs font-medium',
                                        skill.installed ? 'text-success' : 'text-text-muted',
                                    )}
                                >
                                    {skill.installed
                                        ? t('skills.installed')
                                        : t('skills.notInstalled')}
                                </span>
                            </Link>
                        </li>
                    ))}
                </ul>
            </CatalogSection>

            <CatalogSection
                id="workflows"
                title={t('sections.workflows')}
                total={data.workflows.total}
                matchCount={count(filtered.workflows.length)}
                seeAllHref={ROUTES.DASHBOARD_CATALOG_WORKFLOWS}
                error={data.workflows.error}
                onRetry={retry}
                isEmpty={filtered.workflows.length === 0}
                empty={
                    data.workflows.total === 0 ? (
                        <p className="text-sm text-text-muted">{t('empty.workflows')}</p>
                    ) : (
                        noMatches
                    )
                }
            >
                <WorkflowList workflows={filtered.workflows.slice(0, CATALOG_SECTION_PREVIEW)} />
            </CatalogSection>

            <CatalogSection
                id="taskTemplates"
                title={t('sections.taskTemplates')}
                total={data.taskTemplates.total}
                matchCount={count(filtered.taskTemplates.length)}
                seeAllHref={ROUTES.DASHBOARD_TASK_TEMPLATES}
                error={data.taskTemplates.error}
                onRetry={retry}
                isEmpty={filtered.taskTemplates.length === 0}
                empty={
                    data.taskTemplates.total === 0 ? (
                        <p className="text-sm text-text-muted">
                            {t('empty.taskTemplates')}{' '}
                            <Link
                                href={ROUTES.DASHBOARD_TASK_TEMPLATES}
                                className="text-primary hover:underline"
                            >
                                {t('empty.taskTemplatesAction')}
                            </Link>
                        </p>
                    ) : (
                        noMatches
                    )
                }
            >
                <ul onKeyDown={moveCardFocus} className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {filtered.taskTemplates.slice(0, CATALOG_SECTION_PREVIEW).map((template) => (
                        <li key={template.id}>
                            <TaskTemplateMiniCard template={template} />
                        </li>
                    ))}
                </ul>
            </CatalogSection>

            <CatalogSection
                id="startingPoints"
                title={t('sections.startingPoints')}
                total={data.startingPoints.items.reduce((sum, point) => sum + point.count, 0)}
                matchCount={count(startingPoints.length)}
                seeAllHref={ROUTES.DASHBOARD_TEMPLATES}
                error={data.startingPoints.error}
                onRetry={retry}
                isEmpty={startingPoints.length === 0}
                empty={noMatches}
            >
                <div onKeyDown={moveCardFocus}>
                    <StartingPointsRow points={startingPoints} />
                </div>
            </CatalogSection>
        </div>
    );
}
