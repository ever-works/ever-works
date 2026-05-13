'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { FEED_CATEGORIES, type FeedCategory } from '@/lib/api/works/activity-feed.types';

interface FeedFilterChipsProps {
    value: FeedCategory;
    onChange: (category: FeedCategory) => void;
}

export function FeedFilterChips({ value, onChange }: FeedFilterChipsProps) {
    const t = useTranslations('dashboard.workDetail.activity.filters');

    return (
        <div role="tablist" aria-label={t('label')} className="flex flex-wrap gap-1.5 mb-4">
            {FEED_CATEGORIES.map((cat) => {
                const isActive = cat === value;
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
                        )}
                    >
                        {t(cat)}
                    </button>
                );
            })}
        </div>
    );
}
