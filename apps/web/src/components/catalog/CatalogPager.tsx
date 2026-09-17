import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { CatalogPageWindow } from './workflow-pages';

const PAGER_LINK =
    'rounded-md border border-border/60 px-3 py-1.5 text-text hover:bg-surface-secondary dark:border-border-dark/60 dark:text-text-dark dark:hover:bg-surface-secondary-dark';

/**
 * Previous / Next links under a paged catalogue list, with where the current
 * page sits in the whole. Renders nothing when everything fits on one page.
 * Hrefs arrive already built, so the pager works in server and client trees.
 */
export function CatalogPager({
    page,
    previousHref,
    nextHref,
    label,
    testId,
}: {
    page: CatalogPageWindow;
    previousHref: string | null;
    nextHref: string | null;
    label: string;
    testId?: string;
}) {
    const t = useTranslations('dashboard.catalogPage.pagination');
    if (page.previousOffset === null && page.nextOffset === null) return null;

    return (
        <nav
            aria-label={label}
            data-testid={testId}
            className="flex flex-wrap items-center justify-between gap-3 text-xs text-text-muted dark:text-text-muted-dark"
        >
            <span>
                {page.to > 0
                    ? t('showing', { from: page.from, to: page.to, total: page.total })
                    : t('emptyPage')}
            </span>
            <div className="flex items-center gap-2">
                {page.previousOffset !== null && previousHref ? (
                    <Link href={previousHref} rel="prev" className={PAGER_LINK}>
                        {t('previous')}
                    </Link>
                ) : null}
                {page.nextOffset !== null && nextHref ? (
                    <Link href={nextHref} rel="next" className={PAGER_LINK}>
                        {t('next')}
                    </Link>
                ) : null}
            </div>
        </nav>
    );
}
