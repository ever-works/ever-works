'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { DirectoryPlugin } from '@/lib/api/plugins';
import { DirectoryPluginCard } from './DirectoryPluginCard';
import { CapabilitySelector } from './CapabilitySelector';
import { cn } from '@/lib/utils/cn';

/**
 * Internal capabilities that are not user-selectable per directory.
 * These represent implementation contracts, not switchable providers.
 */
const HIDDEN_CAPABILITIES = new Set(['form-schema-provider', 'pipeline-modifier', 'oauth']);

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

    // Filter to show only user-installed plugins or all plugins
    const filteredPlugins = showInstalledOnly
        ? plugins.filter((p) => p.systemPlugin || (p.installed && p.enabled))
        : plugins;

    // Get unique user-facing capabilities from all plugins (exclude internal ones)
    const allCapabilities = new Set<string>();
    plugins.forEach((p) =>
        p.capabilities
            .filter((c) => !HIDDEN_CAPABILITIES.has(c))
            .forEach((c) => allCapabilities.add(c)),
    );
    const capabilities = Array.from(allCapabilities);

    // Group enabled plugins by capability for the selector
    const pluginsByCapability = capabilities.reduce(
        (acc, capability) => {
            acc[capability] = plugins.filter(
                (p) => p.capabilities.includes(capability) && p.directoryEnabled && !p.supplementary,
            );
            return acc;
        },
        {} as Record<string, DirectoryPlugin[]>,
    );

    return (
        <div className="space-y-6">
            {/* Capability Providers Section */}
            {capabilities.length > 0 && (
                <div className="bg-surface dark:bg-surface-dark rounded-lg border border-border dark:border-border-dark p-4">
                    <h3 className="font-medium text-text dark:text-text-dark mb-3">
                        {t('capabilityProviders')}
                    </h3>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark mb-4">
                        {t('capabilityProvidersDescription')}
                    </p>

                    <div className="space-y-3">
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
            <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-sm text-text-secondary dark:text-text-secondary-dark cursor-pointer">
                    <input
                        type="checkbox"
                        checked={showInstalledOnly}
                        onChange={(e) => setShowInstalledOnly(e.target.checked)}
                        className="rounded border-border dark:border-border-dark"
                    />
                    {t('showInstalledOnly')}
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
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
