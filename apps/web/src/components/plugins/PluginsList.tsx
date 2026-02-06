'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { UserPlugin, PluginCategory } from '@/lib/api/plugins';
import { PluginCard } from './PluginCard';
import { cn } from '@/lib/utils/cn';
import { getCategoryLabel } from '@/lib/utils/plugin-category-icons';

interface PluginsListProps {
    plugins: UserPlugin[];
    categories?: PluginCategory[];
    capabilities?: string[];
}

export function PluginsList({ plugins, categories = [], capabilities = [] }: PluginsListProps) {
    const t = useTranslations('dashboard.plugins');
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
    const [showEnabledOnly, setShowEnabledOnly] = useState(false);

    // Filter plugins based on selection
    const filteredPlugins = plugins.filter((plugin) => {
        if (selectedCategory && plugin.category !== selectedCategory) {
            return false;
        }
        if (showEnabledOnly && !plugin.enabled) {
            return false;
        }
        return true;
    });

    // Sort: enabled/installed plugins first, then alphabetically by name
    const sortPlugins = (a: UserPlugin, b: UserPlugin) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        if (a.installed !== b.installed) return a.installed ? -1 : 1;
        return a.name.localeCompare(b.name);
    };

    // Group plugins by category for display
    const pluginsByCategory = filteredPlugins.reduce(
        (acc, plugin) => {
            const category = plugin.category;
            if (!acc[category]) {
                acc[category] = [];
            }
            acc[category].push(plugin);
            return acc;
        },
        {} as Record<string, UserPlugin[]>,
    );

    // Sort plugins within each category
    for (const plugins of Object.values(pluginsByCategory)) {
        plugins.sort(sortPlugins);
    }

    return (
        <div className="space-y-6">
            {/* Filters */}
            <div className="flex flex-wrap gap-4 items-center">
                <div className="flex flex-wrap gap-2">
                    <button
                        onClick={() => setSelectedCategory(null)}
                        className={cn(
                            'px-3 py-1.5 rounded-full text-sm font-medium transition-colors',
                            selectedCategory === null
                                ? 'bg-primary text-white'
                                : 'bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary dark:text-text-secondary-dark hover:bg-surface-tertiary dark:hover:bg-surface-tertiary-dark',
                        )}
                    >
                        {t('filters.all')}
                    </button>
                    {categories.map((category) => (
                        <button
                            key={category}
                            onClick={() => setSelectedCategory(category)}
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
                        onChange={(e) => setShowEnabledOnly(e.target.checked)}
                        className="rounded border-border dark:border-border-dark"
                    />
                    {t('filters.enabledOnly')}
                </label>
            </div>

            {/* Plugin Grid */}
            {filteredPlugins.length === 0 ? (
                <div className="text-center py-12">
                    <p className="text-text-muted dark:text-text-muted-dark">{t('empty')}</p>
                </div>
            ) : selectedCategory ? (
                // Show flat grid when filtering by category
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {[...filteredPlugins].sort(sortPlugins).map((plugin) => (
                        <PluginCard key={plugin.pluginId} plugin={plugin} />
                    ))}
                </div>
            ) : (
                // Show grouped by category when no filter
                <div className="space-y-8">
                    {Object.entries(pluginsByCategory).map(([category, categoryPlugins]) => (
                        <div key={category}>
                            <h2 className="text-lg font-semibold text-text dark:text-text-dark mb-4">
                                {getCategoryLabel(category)}
                            </h2>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                {categoryPlugins.map((plugin) => (
                                    <PluginCard key={plugin.pluginId} plugin={plugin} />
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
