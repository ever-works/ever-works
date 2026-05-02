'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { DirectoryPlugin } from '@/lib/api/plugins';
import { DirectoryPluginCard } from './DirectoryPluginCard';
import { CapabilitySelector } from './CapabilitySelector';
import { cn } from '@/lib/utils/cn';
import { compareCategoryOrder, HIDDEN_CAPABILITIES } from '@/lib/utils/plugin-category-icons';
import { Layers } from 'lucide-react';

interface DirectoryPluginsListProps {
    directoryId: string;
    plugins: DirectoryPlugin[];
    capabilityProviders?: Record<string, string>;
}

export function DirectoryPluginsList({
    directoryId,
    plugins,
    capabilityProviders = {},
}: DirectoryPluginsListProps) {
    const t = useTranslations('dashboard.directoryPlugins');
    const [showInstalledOnly, setShowInstalledOnly] = useState(true);

    const filteredPlugins = useMemo(
        () =>
            showInstalledOnly
                ? plugins.filter(
                      (plugin) => plugin.systemPlugin || (plugin.installed && plugin.enabled),
                  )
                : plugins,
        [plugins, showInstalledOnly],
    );

    const capabilities = useMemo(() => {
        const visibleCapabilities = new Set<string>();
        for (const plugin of plugins) {
            for (const capability of plugin.capabilities) {
                if (!HIDDEN_CAPABILITIES.has(capability)) {
                    visibleCapabilities.add(capability);
                }
            }
        }

        return Array.from(visibleCapabilities).sort(compareCategoryOrder);
    }, [plugins]);

    const pluginsByCapability = useMemo(() => {
        return capabilities.reduce<Record<string, DirectoryPlugin[]>>((acc, capability) => {
            acc[capability] = plugins.filter(
                (plugin) =>
                    plugin.capabilities.includes(capability) &&
                    plugin.directoryEnabled &&
                    !plugin.supplementary,
            );
            return acc;
        }, {});
    }, [capabilities, plugins]);

    return (
        <div className="space-y-6">
            {/* Capability Providers Section */}
            {capabilities.length > 0 && (
                <div className="overflow-hidden rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark">
                    <div className="px-5 py-3.5 border-b border-border dark:border-border-dark bg-surface-secondary/50 dark:bg-surface-secondary-dark/50 flex items-center gap-3">
                        <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                            <Layers className="w-4 h-4 text-primary" />
                        </div>
                        <div>
                            <h3 className="text-sm font-semibold text-text dark:text-text-dark leading-tight">
                                {t('capabilityProviders')}
                            </h3>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5">
                                {t('capabilityProvidersDescription')}
                            </p>
                        </div>
                    </div>
                    <div className="divide-y divide-border dark:divide-border-dark">
                        {capabilities.map((capability) => {
                            const availablePlugins = pluginsByCapability[capability] || [];
                            const activePluginId = capabilityProviders[capability];

                            return (
                                <CapabilitySelector
                                    key={capability}
                                    directoryId={directoryId}
                                    capability={capability}
                                    plugins={availablePlugins}
                                    activePluginId={activePluginId}
                                />
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Filters */}
            <div className="flex items-center gap-3">
                <label className="flex items-center gap-2.5 text-sm text-text-secondary dark:text-text-secondary-dark cursor-pointer select-none group">
                    <span
                        className={cn(
                            'relative inline-flex w-8 h-4 rounded-full transition-colors duration-200 shrink-0 focus-within:outline-none focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-2 focus-within:ring-offset-background',
                            showInstalledOnly ? 'bg-primary' : 'bg-border dark:bg-border-dark',
                        )}
                    >
                        <span
                            className={cn(
                                'absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform duration-200',
                                showInstalledOnly ? 'translate-x-4' : 'translate-x-0',
                            )}
                        />
                        <input
                            type="checkbox"
                            checked={showInstalledOnly}
                            onChange={(e) => setShowInstalledOnly(e.target.checked)}
                            className="sr-only"
                        />
                    </span>
                    <span className="group-hover:text-text dark:group-hover:text-text-dark transition-colors">
                        {t('showInstalledOnly')}
                    </span>
                </label>
            </div>

            {/* Plugin Grid */}
            {filteredPlugins.length === 0 ? (
                <div className="text-center py-12 bg-surface dark:bg-surface-dark rounded-lg border border-border dark:border-border-dark">
                    <p className="text-text-muted dark:text-text-muted-dark">
                        {showInstalledOnly ? t('noInstalledPlugins') : t('noPlugins')}
                    </p>
                    {showInstalledOnly && (
                        <button
                            onClick={() => setShowInstalledOnly(false)}
                            className="text-primary hover:text-primary-hover mt-2 text-sm"
                        >
                            {t('showAllPlugins')}
                        </button>
                    )}
                </div>
            ) : (
                <div className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4">
                    {filteredPlugins.map((plugin) => (
                        <DirectoryPluginCard
                            key={plugin.pluginId}
                            directoryId={directoryId}
                            plugin={plugin}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
