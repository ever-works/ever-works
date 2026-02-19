'use client';

import { useState, useRef } from 'react';
import { UserPlugin, PluginCategory } from '@/lib/api/plugins';
import { getCategoryLabel } from '@/lib/utils/plugin-category-icons';
import { PluginSearchBar } from './PluginSearchBar';
import { PluginCategoryFilter } from './PluginCategoryFilter';
import { PluginGrid } from './PluginGrid';

interface PluginsListProps {
    plugins: UserPlugin[];
    categories?: PluginCategory[];
    capabilities?: string[];
}

function sortPlugins(a: UserPlugin, b: UserPlugin): number {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    if (a.installed !== b.installed) return a.installed ? -1 : 1;
    return a.name.localeCompare(b.name);
}

function matchesSearch(plugin: UserPlugin, query: string): boolean {
    const haystack = [
        plugin.name,
        plugin.description ?? '',
        getCategoryLabel(plugin.category),
        ...plugin.capabilities.map(getCategoryLabel),
    ]
        .join(' ')
        .toLowerCase();
    return haystack.includes(query);
}

export function PluginsList({ plugins, categories = [] }: PluginsListProps) {
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
    const [showEnabledOnly, setShowEnabledOnly] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');

    // Capture initial sort order once — prevents cards jumping when toggling a plugin.
    // Order refreshes on full page navigation.
    const initialOrderRef = useRef<Map<string, number> | null>(null);
    if (initialOrderRef.current === null) {
        const sorted = [...plugins].sort(sortPlugins);
        initialOrderRef.current = new Map(sorted.map((p, i) => [p.pluginId, i]));
    }

    const pluginMap = new Map(plugins.map((p) => [p.pluginId, p]));
    const stablePlugins = [...initialOrderRef.current.entries()]
        .sort(([, a], [, b]) => a - b)
        .map(([id]) => pluginMap.get(id))
        .filter((p): p is UserPlugin => p != null);

    const normalizedQuery = searchQuery.trim().toLowerCase();

    const filteredPlugins = stablePlugins.filter((plugin) => {
        if (selectedCategory && plugin.category !== selectedCategory) return false;
        if (showEnabledOnly && !plugin.enabled) return false;
        if (normalizedQuery && !matchesSearch(plugin, normalizedQuery)) return false;
        return true;
    });

    // Show flat grid when searching or filtering by category; grouped otherwise.
    const grouped = !normalizedQuery && !selectedCategory;

    return (
        <div className="space-y-5">
            <PluginSearchBar value={searchQuery} onChange={setSearchQuery} />

            <PluginCategoryFilter
                categories={categories}
                selectedCategory={selectedCategory}
                onSelectCategory={setSelectedCategory}
                showEnabledOnly={showEnabledOnly}
                onToggleEnabledOnly={setShowEnabledOnly}
            />

            <PluginGrid
                plugins={filteredPlugins}
                grouped={grouped}
                searchQuery={searchQuery.trim()}
                onClearSearch={() => setSearchQuery('')}
            />
        </div>
    );
}
