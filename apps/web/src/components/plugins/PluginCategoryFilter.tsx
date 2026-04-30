'use client';

import { useTranslations } from 'next-intl';
import { PluginCategory } from '@/lib/api/plugins';
import { cn } from '@/lib/utils/cn';
import { getCategoryLabel, compareCategoryOrder } from '@/lib/utils/plugin-category-icons';

interface PluginCategoryFilterProps {
    categories: PluginCategory[];
    selectedCategory: string | null;
    onSelectCategory: (category: string | null) => void;
    showEnabledOnly: boolean;
    onToggleEnabledOnly: (value: boolean) => void;
}

export function PluginCategoryFilter({
    categories,
    selectedCategory,
    onSelectCategory,
    showEnabledOnly,
    onToggleEnabledOnly,
}: PluginCategoryFilterProps) {
    const t = useTranslations('dashboard.plugins.filters');

    return (
        <div className="flex flex-wrap gap-4 items-center">
            <div className="flex flex-wrap gap-2">
                <button
                    onClick={() => onSelectCategory(null)}
                    className={cn(
                        'px-3 py-1 rounded-full text-xs transition-colors cursor-pointer',
                        selectedCategory === null
                            ? 'bg-button-primary dark:bg-button-primary-dark text-white dark:text-black'
                            : 'bg-surface-secondary dark:bg-white/9 text-text-secondary dark:text-text-secondary-dark hover:bg-surface-tertiary dark:hover:bg-white/20',
                    )}
                >
                    {t('all')}
                </button>
                {[...categories].sort(compareCategoryOrder).map((category) => (
                    <button
                        key={category}
                        onClick={() => onSelectCategory(category)}
                        className={cn(
                            'px-3 py-1 rounded-full text-xs transition-colors cursor-pointer',
                            selectedCategory === category
                                ? 'bg-button-primary dark:bg-button-primary-dark text-white dark:text-black'
                                : 'bg-surface-secondary dark:bg-white/9 text-text-secondary dark:text-text-secondary-dark hover:bg-surface-tertiary dark:hover:bg-white/20',
                        )}
                    >
                        {getCategoryLabel(category)}
                    </button>
                ))}
            </div>

            <label className="flex items-center gap-2 text-xs text-text-secondary dark:text-text-secondary-dark cursor-pointer">
                <input
                    type="checkbox"
                    checked={showEnabledOnly}
                    onChange={(e) => onToggleEnabledOnly(e.target.checked)}
                    className="rounded border-border dark:border-border-dark"
                />
                {t('enabledOnly')}
            </label>
        </div>
    );
}
