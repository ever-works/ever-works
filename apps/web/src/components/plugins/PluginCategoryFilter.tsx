'use client';

import { useTranslations } from 'next-intl';
import { PluginCategory } from '@/lib/api/plugins';
import { cn } from '@/lib/utils/cn';
import { getCategoryLabel } from '@/lib/utils/plugin-category-icons';

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
                        'px-3 py-1.5 rounded-full text-sm font-medium transition-colors',
                        selectedCategory === null
                            ? 'bg-primary text-white'
                            : 'bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary dark:text-text-secondary-dark hover:bg-surface-tertiary dark:hover:bg-surface-tertiary-dark',
                    )}
                >
                    {t('all')}
                </button>
                {categories.map((category) => (
                    <button
                        key={category}
                        onClick={() => onSelectCategory(category)}
                        className={cn(
                            'px-3 py-1.5 rounded-full text-sm font-medium transition-colors',
                            selectedCategory === category
                                ? 'bg-primary text-white'
                                : 'bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary dark:text-text-secondary-dark hover:bg-surface-tertiary dark:hover:bg-surface-tertiary-dark',
                        )}
                    >
                        {getCategoryLabel(category)}
                    </button>
                ))}
            </div>

            <label className="flex items-center gap-2 text-sm text-text-secondary dark:text-text-secondary-dark cursor-pointer">
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
