'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Search } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { rankHelpArticles } from '@/lib/help/help-search';
import {
    formatHelpTarget,
    getHelpArticles,
    groupHelpArticlesBySection,
} from '@/lib/help/help-target';
import { HelpBuildStamp } from './HelpBuildStamp';
import { helpArticleHref } from './HelpArticleBlocks';
import { helpSectionMessageKey } from './help-section-label';

/**
 * `/help` — the whole manual on one page (AW-25, spec §6.7): every section
 * with its articles, a search over the same catalog the drawer uses, and the
 * build stamp.
 */
export function HelpManualIndex() {
    const t = useTranslations('dashboard.helpCenter');
    const [query, setQuery] = useState('');
    const articles = getHelpArticles();
    const sections = useMemo(() => groupHelpArticlesBySection(articles), [articles]);
    const outcome = useMemo(() => rankHelpArticles({ query, articles }), [articles, query]);
    const searching = query.trim().length >= 2;

    return (
        <div data-testid="help-manual-index" className="mx-auto max-w-4xl space-y-8">
            <header className="space-y-1">
                <h1 className="text-2xl font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h1>
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                    {t('pageSubtitle')}
                </p>
            </header>

            <div className="relative max-w-md print:hidden">
                <Search
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
                    aria-hidden="true"
                />
                <input
                    type="search"
                    data-testid="help-page-search-input"
                    aria-label={t('searchLabel')}
                    placeholder={t('searchPlaceholder')}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className="w-full rounded-lg border border-border bg-white py-2 pl-9 pr-3 text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 dark:border-border-dark dark:bg-surface-dark dark:text-text-dark"
                />
            </div>

            {searching ? (
                <section aria-live="polite" className="space-y-5">
                    {outcome.total === 0 ? (
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {t('noResults', { query: query.trim() })}
                        </p>
                    ) : (
                        outcome.groups.map((group) => (
                            <div key={group.section} className="space-y-2">
                                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark">
                                    {t(helpSectionMessageKey(group.section))}
                                </h2>
                                <ul className="space-y-2">
                                    {group.results.map((result) => (
                                        <li key={result.article.id}>
                                            <Link
                                                href={helpArticleHref(
                                                    formatHelpTarget(
                                                        result.article.id,
                                                        result.heading?.id,
                                                    ),
                                                )}
                                                className="text-sm font-medium text-primary hover:underline dark:text-primary-dark"
                                            >
                                                {result.article.title}
                                            </Link>
                                            <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                                {result.heading
                                                    ? `→ ${result.heading.text}`
                                                    : result.article.summary}
                                            </p>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))
                    )}
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('resultCount', { count: outcome.total })}
                    </p>
                </section>
            ) : (
                <div className="grid gap-8 md:grid-cols-2">
                    {sections.map((group) => (
                        <section
                            key={group.section}
                            data-help-section={group.section}
                            aria-labelledby={`help-index-${group.section}`}
                            className="space-y-3"
                        >
                            <h2
                                id={`help-index-${group.section}`}
                                className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark"
                            >
                                {t(helpSectionMessageKey(group.section))}
                            </h2>
                            <ul className="space-y-3">
                                {group.articles.map((article) => (
                                    <li key={article.id}>
                                        <Link
                                            href={ROUTES.DASHBOARD_HELP_ARTICLE(article.id)}
                                            data-help-article={article.id}
                                            className="text-sm font-medium text-text hover:text-primary hover:underline dark:text-text-dark"
                                        >
                                            {article.title}
                                        </Link>
                                        <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                            {article.summary}
                                        </p>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))}
                </div>
            )}

            <HelpBuildStamp className="border-t border-border pt-4 dark:border-border-dark" />
        </div>
    );
}
