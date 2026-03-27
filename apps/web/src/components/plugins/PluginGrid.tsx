'use client';

import { useTranslations } from 'next-intl';
import { Search } from 'lucide-react';
import { UserPlugin } from '@/lib/api/plugins';
import { PluginCard } from './PluginCard';
import { getCategoryLabel, compareCategoryOrder } from '@/lib/utils/plugin-category-icons';

interface PluginGridProps {
    plugins: UserPlugin[];
    /** Render plugins grouped by category instead of a flat grid. */
    grouped: boolean;
    /** Active search query — drives the contextual empty state. */
    searchQuery: string;
    onClearSearch: () => void;
}

function groupByCategory(plugins: UserPlugin[]): Record<string, UserPlugin[]> {
    return plugins.reduce(
        (acc, plugin) => {
            (acc[plugin.category] ??= []).push(plugin);
            return acc;
        },
        {} as Record<string, UserPlugin[]>,
    );
}

const GRID = 'grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4';

export function PluginGrid({ plugins, grouped, searchQuery, onClearSearch }: PluginGridProps) {
    const t = useTranslations('dashboard.plugins');

    if (plugins.length === 0) {
        return (
            <div className="text-center py-16">
                {searchQuery ? (
                    <>
                        <Search className="w-10 h-10 text-text-muted dark:text-text-muted-dark mx-auto mb-3 opacity-40" />
                        <p className="text-text-secondary dark:text-text-secondary-dark font-medium">
                            {t('searchEmpty', { query: searchQuery })}
                        </p>
                        <button
                            onClick={onClearSearch}
                            className="mt-2 text-sm text-primary hover:text-primary-hover"
                        >
                            {t('filters.clearSearch')}
                        </button>
                    </>
                ) : (
                    <p className="text-text-muted dark:text-text-muted-dark">{t('empty')}</p>
                )}
            </div>
        );
    }

    if (!grouped) {
        return (
            <div className={GRID}>
                {plugins.map((plugin) => (
                    <PluginCard key={plugin.pluginId} plugin={plugin} />
                ))}
            </div>
        );
    }

    return (
        <div className="space-y-8">
            {Object.entries(groupByCategory(plugins))
                .sort(([a], [b]) => compareCategoryOrder(a, b))
                .map(([category, categoryPlugins]) => (
                    <div key={category}>
                        <h2 className="text-lg font-semibold text-text dark:text-text-dark mb-4">
                            {getCategoryLabel(category)}
                        </h2>
                        <div className={GRID}>
                            {categoryPlugins.map((plugin) => (
                                <PluginCard key={plugin.pluginId} plugin={plugin} />
                            ))}
                        </div>
                    </div>
                ))}
        </div>
    );
}
