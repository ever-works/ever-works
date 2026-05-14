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
        <div role="tablist" aria-label={t('label')} className="flex flex-wrap gap-1.5 mb-4">
            {FEED_CATEGORIES.map((cat) => {
                const isActive = cat === value;
                const isDimmed = Boolean(directorySiteDisabled && DIRECTORY_CATEGORIES.has(cat));
                return (
                    <button
                        key={cat}
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        onClick={() => onChange(cat)}
                        className={cn(
                            'inline-flex items-center px-3 py-1 rounded-full text-xs font-medium transition-colors',
                            'border',
                            isActive
                                ? 'bg-primary text-primary-foreground border-primary'
                                : 'bg-card dark:bg-card-primary-dark/30 text-text-secondary dark:text-text-secondary-dark border-border dark:border-border-dark hover:bg-muted/30 dark:hover:bg-muted/10',
                            isDimmed && 'opacity-50',
                        )}
                    >
                        {t(cat)}
                    </button>
                );
            })}
        </div>
    );
}
