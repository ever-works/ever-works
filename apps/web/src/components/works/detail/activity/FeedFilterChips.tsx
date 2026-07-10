'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { FEED_CATEGORIES, type FeedCategory } from '@/lib/api/works/activity-feed.types';

interface FeedFilterChipsProps {
    value: FeedCategory;
    onChange: (category: FeedCategory) => void;
    /** When true, dim the website-sourced category chips. Used when pull-mode
     *  sync is permanently broken (disabled / not_provisioned) so the user
     *  doesn't keep clicking into empty Users/Submissions/Reports tabs. */
    directorySiteDisabled?: boolean;
}

const DIRECTORY_CATEGORIES: ReadonlySet<FeedCategory> = new Set([
    'users',
    'submissions',
    'reports',
]);

export function FeedFilterChips({ value, onChange, directorySiteDisabled }: FeedFilterChipsProps) {
    const t = useTranslations('dashboard.workDetail.activity.filters');

    return (
        <div role="group" aria-label={t('label')} className="flex flex-wrap gap-1.5 mb-4">
            {FEED_CATEGORIES.map((cat) => {
                const isActive = cat === value;
                const isDimmed = Boolean(directorySiteDisabled && DIRECTORY_CATEGORIES.has(cat));
                return (
                    <button
                        key={cat}
                        type="button"
                        aria-pressed={isActive}
                        disabled={isDimmed}
                        onClick={() => onChange(cat)}
                        className={cn(
                            // Mirrors the category filter pills on /plugins
                            // (PluginCategoryFilter.tsx) so filters look the
                            // same across dashboard pages.
                            'inline-flex items-center px-3 py-1 rounded-full text-xs transition-colors cursor-pointer',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                            isActive
                                ? 'bg-button-primary dark:bg-button-primary-dark text-white dark:text-black'
                                : 'bg-surface-secondary dark:bg-white/9 text-text-secondary dark:text-text-secondary-dark hover:bg-surface-tertiary dark:hover:bg-white/20',
                            isDimmed && 'opacity-50 cursor-not-allowed',
                        )}
                    >
                        {t(cat)}
                    </button>
                );
            })}
        </div>
    );
}
