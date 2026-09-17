import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Link } from '@/i18n/navigation';

interface CatalogSectionProps {
    id: string;
    title: string;
    /** The section's true total, shown on the See-all control. */
    total: number;
    /** Matches while a search is active; `null` when not searching. */
    matchCount: number | null;
    seeAllHref?: string;
    /** For a section with no page of its own: expand in place instead of linking. */
    onSeeAll?: () => void;
    error: boolean;
    onRetry?: () => void;
    /** Rendered when the section loaded but has nothing to show. */
    empty: ReactNode;
    isEmpty: boolean;
    children: ReactNode;
    headerExtra?: ReactNode;
}

/**
 * One catalogue section: heading, true total, its own error state and its
 * own empty state. A failing section never takes the others down, and an
 * empty section still renders so the capability stays discoverable.
 */
export function CatalogSection({
    id,
    title,
    total,
    matchCount,
    seeAllHref,
    onSeeAll,
    error,
    onRetry,
    empty,
    isEmpty,
    children,
    headerExtra,
}: CatalogSectionProps) {
    const t = useTranslations('dashboard.catalogPage');
    const headingId = `catalog-section-${id}`;

    return (
        <section
            aria-labelledby={headingId}
            data-testid={`catalog-section-${id}`}
            className="space-y-3"
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-baseline gap-3">
                    <h2
                        id={headingId}
                        className="text-base font-semibold text-text dark:text-text-dark"
                    >
                        {title}
                    </h2>
                    {matchCount !== null && (
                        <span
                            data-testid="catalog-section-count"
                            className="text-xs text-text-muted dark:text-text-muted-dark"
                        >
                            {t('sectionCount', { count: matchCount })}
                        </span>
                    )}
                </div>
                {onSeeAll && !seeAllHref && !error && (
                    <button
                        type="button"
                        onClick={onSeeAll}
                        className="text-xs font-medium text-primary hover:underline"
                    >
                        {t('seeAll', { count: total })}
                    </button>
                )}
                {seeAllHref && !error && (
                    <Link
                        href={seeAllHref}
                        className="text-xs font-medium text-primary hover:underline"
                    >
                        {t('seeAll', { count: total })}
                    </Link>
                )}
            </div>
            {headerExtra}
            {error ? (
                <div
                    role="alert"
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning/5 p-4 text-sm"
                >
                    <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                        <p className="font-medium text-text dark:text-text-dark">
                            {t('error.section')}
                        </p>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('error.sectionHint')}
                        </p>
                    </div>
                    {onRetry && (
                        <button
                            type="button"
                            onClick={onRetry}
                            className="rounded-md border border-border dark:border-border-dark px-3 py-1 text-xs font-medium hover:bg-surface-secondary dark:hover:bg-white/9"
                        >
                            {t('error.sectionAction')}
                        </button>
                    )}
                </div>
            ) : isEmpty ? (
                empty
            ) : (
                children
            )}
        </section>
    );
}
