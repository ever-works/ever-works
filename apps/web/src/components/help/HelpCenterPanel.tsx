'use client';

import {
    useCallback,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent,
    type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight, Search, X } from 'lucide-react';
import { Link, usePathname } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { matchHelpScreen } from '@/lib/help/help-screen-map';
import {
    foldForSearch,
    HELP_SEARCH_DEBOUNCE_MS,
    HELP_SEARCH_MIN_CHARS,
    rankHelpArticles,
    type HelpSearchResult,
} from '@/lib/help/help-search';
import {
    formatHelpTarget,
    getHelpArticle,
    getHelpArticles,
    groupHelpArticlesBySection,
    parseHelpTarget,
} from '@/lib/help/help-target';
import { captureHelpEvent, type HelpArticleSource } from '@/lib/help/help-telemetry';
import type { HelpArticleMeta } from '@/lib/help/help-types';
import { helpArticleHref } from './HelpArticleBlocks';
import { HelpArticleReader } from './HelpArticleReader';
import { HelpBuildStamp } from './HelpBuildStamp';
import { helpSectionMessageKey } from './help-section-label';

interface SelectedArticle {
    article: HelpArticleMeta;
    headingId: string | null;
}

export interface HelpCenterPanelProps {
    /** `<article>` or `<article>#<heading>` to open at; anything else opens the browse view. */
    initialTarget?: string | null;
    /** Rendered at the top of the browse view (the drawer passes its onboarding entry). */
    lead?: ReactNode;
    /** Close the whole Help drawer — used when a link leaves for another screen. */
    onClose: () => void;
}

function selectionFor(target: string | null | undefined): SelectedArticle | null {
    if (!target) return null;
    const parsed = parseHelpTarget(target);
    const article = parsed ? getHelpArticle(parsed.articleId) : null;
    return parsed && article ? { article, headingId: parsed.headingId } : null;
}

/**
 * Whether an Esc is Help's to take: aimed inside the dialog that hosts the
 * panel (the drawer's close button and tabs sit outside the panel itself), or
 * at no element in particular — the page body, document or window, where the
 * key lands once the focused row was removed. A key aimed at anything else,
 * such as the command palette opened on top of the drawer, is that overlay's.
 */
function isEscapeForPanel(target: EventTarget | null, panel: HTMLElement | null): boolean {
    if (!panel) return false;
    if (!(target instanceof Node)) return true;
    const doc = panel.ownerDocument;
    if (target === doc || target === doc.body || target === doc.documentElement) return true;
    return (panel.closest('[role="dialog"]') ?? panel).contains(target);
}

const ROW_BUTTON =
    'flex w-full min-h-11 items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors md:min-h-0 hover:bg-surface dark:hover:bg-surface-secondary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';
const GROUP_HEADING =
    'mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark';

/**
 * The manual (AW-25) — the Help drawer's first tab. Three views over the
 * catalog that ships with the build: browse (On this screen · Browse),
 * results, and one article. Nothing here waits on the network except an
 * article's body.
 *
 * Keyboard (spec FR-40): `/` focuses search; ↑ ↓ Home End move through
 * results and never land on a section heading; Enter opens; Esc walks
 * article → results → browse and only then lets the drawer close.
 */
export function HelpCenterPanel({ initialTarget, lead, onClose }: HelpCenterPanelProps) {
    const t = useTranslations('dashboard.helpCenter');
    const pathname = usePathname();
    const baseId = useId();
    const listboxId = `${baseId}-results`;
    const inputRef = useRef<HTMLInputElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);

    const [selected, setSelected] = useState<SelectedArticle | null>(() =>
        selectionFor(initialTarget),
    );
    const [query, setQuery] = useState('');
    const [settledQuery, setSettledQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);

    const articles = getHelpArticles();
    const sections = useMemo(() => groupHelpArticlesBySection(articles), [articles]);
    const onThisScreen = useMemo(() => {
        const ids = matchHelpScreen(pathname, articles).articleIds;
        return ids.map((id) => getHelpArticle(id)).filter((a): a is HelpArticleMeta => a !== null);
    }, [articles, pathname]);

    useEffect(() => {
        const initial = selectionFor(initialTarget);
        if (initial) {
            captureHelpEvent({
                name: 'help_article_opened',
                properties: {
                    article_id: initial.article.id,
                    section: initial.article.section,
                    source: 'deep_link',
                    via_heading: initial.headingId !== null,
                },
            });
        }
        // Only the target the panel opened with is a deep link.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const timer = setTimeout(() => setSettledQuery(query), HELP_SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [query]);

    const outcome = useMemo(
        () =>
            rankHelpArticles({
                query: settledQuery,
                articles,
                currentArticleIds: onThisScreen.map((article) => article.id),
            }),
        [articles, onThisScreen, settledQuery],
    );

    const searching = foldForSearch(settledQuery).length >= HELP_SEARCH_MIN_CHARS;
    const view: 'article' | 'results' | 'browse' = selected
        ? 'article'
        : searching
          ? 'results'
          : 'browse';

    const openArticle = useCallback((target: string, source: HelpArticleSource) => {
        const next = selectionFor(target);
        if (!next) return;
        captureHelpEvent({
            name: 'help_article_opened',
            properties: {
                article_id: next.article.id,
                section: next.article.section,
                source,
                via_heading: next.headingId !== null,
            },
        });
        setSelected(next);
    }, []);

    const openResult = (result: HelpSearchResult) =>
        openArticle(formatHelpTarget(result.article.id, result.heading?.id), 'search');

    const backFromArticle = useCallback(() => {
        setSelected(null);
        requestAnimationFrame(() => inputRef.current?.focus());
    }, []);

    // Esc steps back (article → results → browse) before the drawer may close.
    // This listens on the window in the CAPTURE phase, not on the panel: focus
    // is often outside the panel — opened from a help link, the drawer's
    // Headless UI Dialog puts initial focus on its close button — so a panel
    // keydown handler never sees the key while the Dialog's own window-level
    // (bubble-phase) Esc handler closes the whole drawer. Capture runs first,
    // and preventDefault tells the Dialog to leave the key alone. With nothing
    // to step back from, no listener is attached and Esc closes the drawer.
    // Being on the window, it must skip an Esc aimed at another overlay — the
    // command palette opens above the drawer and closes on its own Esc.
    useEffect(() => {
        if (!selected && !query) return;
        const onEscape = (event: globalThis.KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            if (!isEscapeForPanel(event.target, panelRef.current)) return;
            event.preventDefault();
            if (selected) {
                backFromArticle();
            } else {
                setQuery('');
                setSettledQuery('');
            }
        };
        window.addEventListener('keydown', onEscape, true);
        return () => window.removeEventListener('keydown', onEscape, true);
    }, [backFromArticle, query, selected]);

    const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) {
            const target = event.target as HTMLElement;
            const editable =
                target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.isContentEditable;
            if (!editable) {
                event.preventDefault();
                if (selected) backFromArticle();
                else inputRef.current?.focus();
            }
        }
    };

    const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (view !== 'results' || outcome.total === 0) return;
        const last = outcome.total - 1;
        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                setActiveIndex((index) => Math.min(index + 1, last));
                break;
            case 'ArrowUp':
                event.preventDefault();
                setActiveIndex((index) => Math.max(index - 1, 0));
                break;
            case 'Home':
                event.preventDefault();
                setActiveIndex(0);
                break;
            case 'End':
                event.preventDefault();
                setActiveIndex(last);
                break;
            case 'Enter': {
                event.preventDefault();
                const result = outcome.results[activeIndex];
                if (result) openResult(result);
                break;
            }
        }
    };

    const optionId = (index: number) => `${baseId}-option-${index}`;
    const articleRow = (
        article: HelpArticleMeta,
        source: HelpArticleSource,
        withSummary: boolean,
    ) => (
        <li key={article.id}>
            <button
                type="button"
                data-help-article={article.id}
                onClick={() => openArticle(article.id, source)}
                className={ROW_BUTTON}
            >
                <ChevronRight
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted"
                    aria-hidden="true"
                />
                <span className="min-w-0">
                    <span className="block text-sm font-medium text-text dark:text-text-dark">
                        {article.title}
                    </span>
                    {withSummary && (
                        <span className="mt-0.5 block text-xs text-text-secondary dark:text-text-secondary-dark">
                            {article.summary}
                        </span>
                    )}
                </span>
            </button>
        </li>
    );

    const resultIndex = new Map(outcome.results.map((result, index) => [result.article.id, index]));

    return (
        <div
            ref={panelRef}
            data-testid="help-center-panel"
            onKeyDown={onPanelKeyDown}
            className="space-y-5"
        >
            {view !== 'article' && (
                <div className="relative">
                    <Search
                        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
                        aria-hidden="true"
                    />
                    <input
                        ref={inputRef}
                        type="search"
                        role="combobox"
                        data-testid="help-search-input"
                        aria-label={t('searchLabel')}
                        aria-autocomplete="list"
                        aria-expanded={view === 'results'}
                        aria-controls={listboxId}
                        aria-activedescendant={
                            view === 'results' && outcome.total > 0
                                ? optionId(activeIndex)
                                : undefined
                        }
                        placeholder={t('searchPlaceholder')}
                        value={query}
                        onChange={(event) => {
                            setQuery(event.target.value);
                            setActiveIndex(0);
                        }}
                        onKeyDown={onInputKeyDown}
                        className="w-full min-h-11 rounded-lg border border-border bg-white py-2 pl-9 pr-9 text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 md:min-h-0 dark:border-border-dark dark:bg-surface-dark dark:text-text-dark"
                    />
                    {query && (
                        <button
                            type="button"
                            onClick={() => {
                                setQuery('');
                                setSettledQuery('');
                                inputRef.current?.focus();
                            }}
                            aria-label={t('clearSearch')}
                            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-text-muted hover:text-text"
                        >
                            <X className="h-4 w-4" aria-hidden="true" />
                        </button>
                    )}
                </div>
            )}

            {view === 'article' && selected && (
                <HelpArticleReader
                    key={`${selected.article.id}#${selected.headingId ?? ''}`}
                    article={selected.article}
                    headingId={selected.headingId}
                    mode="panel"
                    onBack={backFromArticle}
                    onNavigate={onClose}
                    onOpenArticle={(target) => openArticle(target, 'article_link')}
                />
            )}

            {view === 'results' && (
                <div data-testid="help-search-results">
                    {outcome.total === 0 ? (
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {t('noResults', { query: settledQuery.trim() })}
                        </p>
                    ) : (
                        <div
                            id={listboxId}
                            role="listbox"
                            aria-label={t('searchLabel')}
                            className="space-y-4"
                        >
                            {outcome.groups.map((group) => {
                                const headingId = `${baseId}-group-${group.section}`;
                                return (
                                    <div
                                        key={group.section}
                                        role="group"
                                        aria-labelledby={headingId}
                                    >
                                        <p
                                            id={headingId}
                                            role="presentation"
                                            className={GROUP_HEADING}
                                        >
                                            {t(helpSectionMessageKey(group.section))}
                                        </p>
                                        {group.results.map((result) => {
                                            const index = resultIndex.get(result.article.id) ?? 0;
                                            const active = index === activeIndex;
                                            return (
                                                <div
                                                    key={result.article.id}
                                                    id={optionId(index)}
                                                    role="option"
                                                    aria-selected={active}
                                                    data-help-result={result.article.id}
                                                    onMouseEnter={() => setActiveIndex(index)}
                                                    onClick={() => openResult(result)}
                                                    className={cn(
                                                        'cursor-pointer rounded-lg px-2 py-2',
                                                        active
                                                            ? 'bg-surface ring-1 ring-primary/40 dark:bg-surface-secondary-dark'
                                                            : 'hover:bg-surface dark:hover:bg-surface-secondary-dark',
                                                    )}
                                                >
                                                    <span className="block text-sm font-medium text-text dark:text-text-dark">
                                                        {result.article.title}
                                                    </span>
                                                    {result.heading ? (
                                                        <span className="mt-0.5 block text-xs text-text-secondary dark:text-text-secondary-dark">
                                                            → {result.heading.text}
                                                        </span>
                                                    ) : (
                                                        <span className="mt-0.5 block text-xs text-text-secondary dark:text-text-secondary-dark">
                                                            {result.article.summary}
                                                        </span>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    <p
                        className="mt-3 text-xs text-text-muted dark:text-text-muted-dark"
                        aria-hidden="true"
                    >
                        {t('resultCount', { count: outcome.total })}
                    </p>
                </div>
            )}
            <p
                role="status"
                aria-live="polite"
                className="sr-only"
                data-testid="help-result-announcement"
            >
                {view === 'results' ? t('resultCount', { count: outcome.total }) : ''}
            </p>

            {view === 'browse' && (
                <div className="space-y-6" data-testid="help-browse">
                    {lead}

                    {onThisScreen.length > 0 && (
                        <section
                            aria-labelledby={`${baseId}-on-this-screen`}
                            data-testid="help-on-this-screen"
                        >
                            <h3 id={`${baseId}-on-this-screen`} className={GROUP_HEADING}>
                                {t('onThisScreen')}
                            </h3>
                            <ul>
                                {onThisScreen.map((article) =>
                                    articleRow(article, 'on_this_screen', true),
                                )}
                            </ul>
                        </section>
                    )}

                    <section aria-labelledby={`${baseId}-browse`}>
                        <h3 id={`${baseId}-browse`} className={GROUP_HEADING}>
                            {t('browse')}
                        </h3>
                        <div className="divide-y divide-border rounded-xl border border-border dark:divide-border-dark dark:border-border-dark">
                            {sections.map((group) => (
                                <details
                                    key={group.section}
                                    data-help-section={group.section}
                                    className="group"
                                >
                                    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 md:min-h-0 [&::-webkit-details-marker]:hidden">
                                        <span className="flex items-center gap-2 text-sm font-medium text-text dark:text-text-dark">
                                            <ChevronRight
                                                className="h-3.5 w-3.5 text-text-muted transition-transform group-open:rotate-90"
                                                aria-hidden="true"
                                            />
                                            {t(helpSectionMessageKey(group.section))}
                                        </span>
                                        <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                            {t('articleCount', { count: group.articles.length })}
                                        </span>
                                    </summary>
                                    <ul className="px-1 pb-2">
                                        {group.articles.map((article) =>
                                            articleRow(article, 'browse', false),
                                        )}
                                    </ul>
                                </details>
                            ))}
                        </div>
                    </section>
                </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 dark:border-border-dark">
                <HelpBuildStamp />
                <Link
                    href={
                        selected
                            ? helpArticleHref(
                                  formatHelpTarget(selected.article.id, selected.headingId),
                              )
                            : ROUTES.DASHBOARD_HELP
                    }
                    onClick={onClose}
                    data-testid="help-open-full-page"
                    className="ml-auto text-xs font-medium text-primary hover:underline dark:text-primary-dark"
                >
                    {t('openFullPage')}
                </Link>
            </div>
        </div>
    );
}
