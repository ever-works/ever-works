'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { ChevronDown, ChevronLeft, ExternalLink, X } from 'lucide-react';
import type { HelpArticleBody, HelpBlock } from '@ever-works/contracts/api';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { loadHelpArticleBody } from '@/lib/help/help-body';
import { getHelpArticle } from '@/lib/help/help-target';
import type { HelpArticleMeta } from '@/lib/help/help-types';
import { HelpArticleBlocks, isModifiedHelpClick } from './HelpArticleBlocks';
import { helpSectionMessageKey } from './help-section-label';

type BodyState =
    | { status: 'loading' }
    | { status: 'ready'; body: HelpArticleBody }
    | { status: 'unavailable' };

export interface HelpArticleReaderProps {
    article: HelpArticleMeta;
    /** Heading to open at; `null` opens the article at its top. */
    headingId: string | null;
    /** `panel` inside the Help drawer, `page` on `/help/[slug]`. */
    mode: 'panel' | 'page';
    /** Open another article or heading: in place in the panel, by navigating on the page. */
    onOpenArticle: (target: string) => void;
    /** Panel only — return to the browse or results view. */
    onBack?: () => void;
    /** Called when the reader follows an "Open {screen}" action, so the drawer can close. */
    onNavigate?: () => void;
    /** Test seam for the body request. */
    loadBody?: (articleId: string) => Promise<HelpArticleBody | null>;
}

/** Whether a body contains a heading with this anchor, at any depth. */
function bodyHasHeading(blocks: HelpBlock[], id: string): boolean {
    return blocks.some((block) => {
        switch (block.kind) {
            case 'heading':
                return block.id === id;
            case 'note':
                return bodyHasHeading(block.blocks, id);
            case 'orderedList':
            case 'unorderedList':
                return block.items.some((item) => bodyHasHeading(item.children, id));
            default:
                return false;
        }
    });
}

/** The first documented screen that is a plain dashboard path — the "Open {screen}" target. */
function primaryScreenHref(article: HelpArticleMeta): string | null {
    for (const key of article.documents) {
        const value = (ROUTES as Record<string, unknown>)[key];
        if (typeof value === 'string' && key.startsWith('DASHBOARD')) return value.split('#')[0];
    }
    return null;
}

/**
 * One article of the manual (AW-25, spec §6.3): section, title, reviewed date,
 * "On this page", the body, "Open {screen}" and related articles.
 *
 * The body is fetched from this deployment when the article opens; until it
 * arrives, and if it never does, the reader still shows the article's summary,
 * its headings and a link to the same page on the documentation site — reading
 * never ends in an error screen.
 */
export function HelpArticleReader({
    article,
    headingId,
    mode,
    onOpenArticle,
    onBack,
    onNavigate,
    loadBody = loadHelpArticleBody,
}: HelpArticleReaderProps) {
    const t = useTranslations('dashboard.helpCenter');
    const format = useFormatter();
    const locale = useLocale();
    const [attempt, setAttempt] = useState(0);
    const [loaded, setLoaded] = useState<{ key: string; body: HelpArticleBody | null } | null>(
        null,
    );
    const [movedDismissed, setMovedDismissed] = useState(false);
    const [tocOpen, setTocOpen] = useState(false);
    const containerRef = useRef<HTMLElement | null>(null);
    const idPrefix = mode === 'panel' ? 'help-drawer-' : '';

    // One request per article and retry; the state is keyed by both, so a
    // stale response can never show under a different article.
    const requestKey = `${article.id}:${attempt}`;
    useEffect(() => {
        let cancelled = false;
        loadBody(article.id).then((result) => {
            if (!cancelled) setLoaded({ key: requestKey, body: result });
        });
        return () => {
            cancelled = true;
        };
    }, [article.id, loadBody, requestKey]);

    const body: BodyState =
        loaded?.key !== requestKey
            ? { status: 'loading' }
            : loaded.body
              ? { status: 'ready', body: loaded.body }
              : { status: 'unavailable' };

    // A heading this build's article no longer has opens the article at its
    // top with one dismissible notice (spec S-15). Known once the body is in;
    // without a body, only an uncatalogued heading is known to be gone.
    const headingMoved =
        !movedDismissed &&
        headingId !== null &&
        (body.status === 'ready'
            ? !bodyHasHeading(body.body.blocks, headingId)
            : body.status === 'unavailable' &&
              !article.headings.some((heading) => heading.id === headingId));

    // Open at the named heading once the body is on screen, at the top otherwise.
    useEffect(() => {
        if (body.status === 'loading' && headingId) return;
        const element = headingId ? document.getElementById(`${idPrefix}${headingId}`) : null;
        (element ?? containerRef.current)?.scrollIntoView?.({ block: 'start' });
    }, [article.id, body.status, headingId, idPrefix]);

    const jumpTo = useCallback(
        (id: string) => {
            const element = document.getElementById(`${idPrefix}${id}`);
            if (element) {
                element.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
                if (mode === 'page') window.history.replaceState(null, '', `#${id}`);
            }
            setTocOpen(false);
        },
        [idPrefix, mode],
    );

    const TitleTag = mode === 'page' ? 'h1' : 'h2';
    const topHeadings = article.headings.filter((heading) => heading.level === 2);
    const screenHref = primaryScreenHref(article);
    const related = article.related
        .map((id) => getHelpArticle(id))
        .filter((entry): entry is HelpArticleMeta => entry !== null);
    const reviewed = Number.isNaN(Date.parse(article.reviewedAt))
        ? article.reviewedAt
        : format.dateTime(new Date(`${article.reviewedAt}T00:00:00Z`), {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
              timeZone: 'UTC',
          });

    return (
        <article
            ref={containerRef}
            data-testid="help-article"
            data-article-id={article.id}
            aria-labelledby={`${idPrefix}help-article-title`}
            className="space-y-5 scroll-mt-4"
        >
            {mode === 'panel' && onBack && (
                <button
                    type="button"
                    onClick={onBack}
                    data-testid="help-article-back"
                    className="inline-flex min-h-11 items-center gap-1 text-xs font-medium text-text-secondary hover:text-text md:min-h-0 dark:text-text-secondary-dark dark:hover:text-text-dark"
                >
                    <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                    {t('back')}
                </button>
            )}

            <header className="space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark">
                    {t(helpSectionMessageKey(article.section))}
                </p>
                <TitleTag
                    id={`${idPrefix}help-article-title`}
                    className={cn(
                        'font-semibold text-text dark:text-text-dark',
                        mode === 'page' ? 'text-2xl' : 'text-lg',
                    )}
                >
                    {article.title}
                </TitleTag>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('reviewedOn', { date: reviewed })}
                </p>
            </header>

            {headingMoved && (
                <div
                    role="status"
                    data-testid="help-heading-moved"
                    className="flex items-start justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-text dark:border-border-dark dark:bg-surface-secondary-dark dark:text-text-dark"
                >
                    <span>{t('headingMoved')}</span>
                    <button
                        type="button"
                        onClick={() => setMovedDismissed(true)}
                        aria-label={t('dismiss')}
                        className="shrink-0 rounded p-0.5 text-text-muted hover:text-text dark:text-text-muted-dark"
                    >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                </div>
            )}

            {topHeadings.length > 1 && (
                <nav
                    aria-label={t('onThisPage')}
                    data-testid="help-on-this-page"
                    className="print:hidden"
                >
                    <button
                        type="button"
                        aria-expanded={tocOpen}
                        onClick={() => setTocOpen((open) => !open)}
                        className="flex min-h-11 w-full items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-text-secondary md:hidden dark:text-text-secondary-dark"
                    >
                        {t('onThisPage')}
                        <ChevronDown
                            className={cn('h-4 w-4 transition-transform', tocOpen && 'rotate-180')}
                            aria-hidden="true"
                        />
                    </button>
                    <p className="mb-2 hidden text-[11px] font-semibold uppercase tracking-wider text-text-secondary md:block dark:text-text-secondary-dark">
                        {t('onThisPage')}
                    </p>
                    <ul
                        className={cn(
                            'flex-wrap gap-x-4 gap-y-1 md:flex',
                            tocOpen ? 'flex' : 'hidden',
                        )}
                    >
                        {topHeadings.map((heading) => (
                            <li key={heading.id}>
                                <a
                                    href={`#${heading.id}`}
                                    onClick={(event) => {
                                        event.preventDefault();
                                        jumpTo(heading.id);
                                    }}
                                    className="text-xs text-primary underline-offset-2 hover:underline dark:text-primary-dark"
                                >
                                    {heading.text}
                                </a>
                            </li>
                        ))}
                    </ul>
                </nav>
            )}

            {!locale.startsWith('en') && (
                <p
                    data-testid="help-english-only"
                    className="text-xs italic text-text-muted dark:text-text-muted-dark"
                >
                    {t('englishOnly')}
                </p>
            )}

            {body.status === 'ready' ? (
                <HelpArticleBlocks
                    blocks={body.body.blocks}
                    onOpenArticle={onOpenArticle}
                    idPrefix={idPrefix}
                    headingOffset={mode === 'panel' ? 1 : 0}
                />
            ) : (
                <div className="space-y-3 text-sm text-text-secondary dark:text-text-secondary-dark">
                    <p lang="en">{article.summary}</p>
                    {body.status === 'loading' ? (
                        <p
                            role="status"
                            className="text-xs text-text-muted dark:text-text-muted-dark"
                        >
                            {t('loadingArticle')}
                        </p>
                    ) : (
                        <div
                            role="status"
                            data-testid="help-body-unavailable"
                            className="space-y-2 text-xs"
                        >
                            <p>{t('bodyUnavailable')}</p>
                            <div className="flex flex-wrap items-center gap-3">
                                <button
                                    type="button"
                                    onClick={() => setAttempt((n) => n + 1)}
                                    className="font-medium text-primary hover:underline dark:text-primary-dark"
                                >
                                    {t('retry')}
                                </button>
                                <a
                                    href={article.docsUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 font-medium text-primary hover:underline dark:text-primary-dark"
                                >
                                    {t('readOnDocsSite')}
                                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                                    <span className="sr-only"> ({t('externalLink')})</span>
                                </a>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {screenHref && (
                <div className="print:hidden">
                    <Link
                        href={screenHref}
                        onClick={onNavigate}
                        data-testid="help-open-screen"
                        className="flex min-h-11 w-full items-center justify-center rounded-lg border border-border px-3 py-2 text-sm font-medium text-text hover:bg-surface md:min-h-0 dark:border-border-dark dark:text-text-dark dark:hover:bg-surface-secondary-dark"
                    >
                        {t('openScreen', { screen: article.label })}
                    </Link>
                </div>
            )}

            {related.length > 0 && (
                <section aria-labelledby={`${idPrefix}help-related`} className="print:hidden">
                    <h3
                        id={`${idPrefix}help-related`}
                        className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark"
                    >
                        {t('related')}
                    </h3>
                    <ul className="space-y-1">
                        {related.map((entry) => (
                            <li key={entry.id}>
                                <Link
                                    href={ROUTES.DASHBOARD_HELP_ARTICLE(entry.id)}
                                    data-help-related={entry.id}
                                    onClick={(event) => {
                                        if (isModifiedHelpClick(event)) return;
                                        event.preventDefault();
                                        onOpenArticle(entry.id);
                                    }}
                                    className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-2 hover:underline md:min-h-0 dark:text-primary-dark"
                                >
                                    {entry.title}
                                </Link>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </article>
    );
}
