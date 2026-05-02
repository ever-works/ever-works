'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DirectoryPlugin } from '@/lib/api/plugins';
import { setActiveCapability } from '@/app/actions/plugins';
import { getCapabilityLabel, getCategoryIcon } from '@/lib/utils/plugin-category-icons';
import { DirectoryPluginSettingsModal } from './DirectoryPluginSettingsModal';
import { ProviderChoiceButton } from './ProviderChoiceButton';
import { ActiveProviderModels } from './ActiveProviderModels';

interface CapabilitySelectorProps {
    directoryId?: string;
    capability: string;
    plugins: DirectoryPlugin[];
    activePluginId?: string;
    scope?: 'directory' | 'user';
}

export function CapabilitySelector({
    directoryId,
    capability,
    plugins,
    activePluginId,
    scope = 'directory',
}: CapabilitySelectorProps) {
    const t = useTranslations('dashboard.directoryPlugins');
    const router = useRouter();
    const CapabilityIcon = getCategoryIcon(capability);
    const [isPending, startTransition] = useTransition();
    const [selectedPluginId, setSelectedPluginId] = useState(activePluginId);
    const [settingsPluginId, setSettingsPluginId] = useState<string | null>(null);
    const settingsPlugin = plugins.find((plugin) => plugin.pluginId === settingsPluginId) ?? null;
    const canConfigureDirectoryModels = scope === 'directory' && Boolean(directoryId);
    const activePlugin = plugins.find((plugin) => plugin.pluginId === selectedPluginId);
    const activePluginModels =
        capability === 'ai-provider' && activePlugin?.models?.length
            ? activePlugin.models
            : undefined;

    useEffect(() => {
        setSelectedPluginId(activePluginId);
    }, [activePluginId]);

    const handleSelect = (pluginId: string) => {
        if (!directoryId || pluginId === selectedPluginId || isPending) return;

        const previousPluginId = selectedPluginId;
        setSelectedPluginId(pluginId);
        startTransition(async () => {
            try {
                const result = await setActiveCapability(directoryId, pluginId, capability);
                if (!result.success) {
                    console.error('Failed to set active capability:', result.error);
                    setSelectedPluginId(previousPluginId);
                    return;
                }
                router.refresh();
            } catch (error) {
                console.error('Failed to set active capability:', error);
                setSelectedPluginId(previousPluginId);
            }
        });
    };

    if (plugins.length === 0) {
        return (
            <div className="grid gap-2 px-5 py-3 @sm/main:grid-cols-[11rem_1fr] @sm/main:items-center">
                <div className="flex min-w-0 items-center gap-2">
                    <CapabilityIcon className="h-3.5 w-3.5 shrink-0 text-text-muted dark:text-text-muted-dark" />
                    <span className="truncate text-xs font-medium text-text-secondary dark:text-text-secondary-dark">
                        {getCapabilityLabel(capability)}
                    </span>
                </div>
                <div className="flex-1 text-xs text-text-secondary dark:text-text-secondary-dark italic">
                    {t('noProvidersAvailable')}
                </div>
            </div>
        );
    }

    return (
        <div className="grid gap-2 px-5 py-3 @sm/main:grid-cols-[11rem_1fr] @sm/main:items-center">
            <div className="flex min-w-0 items-center gap-2">
                <CapabilityIcon className="h-3.5 w-3.5 shrink-0 text-text-muted dark:text-text-muted-dark" />
                <span className="truncate text-xs font-medium text-text-secondary dark:text-text-secondary-dark">
                    {getCapabilityLabel(capability)}
                </span>
            </div>

            <div className="min-w-0">
                <div
                    className="flex min-w-0 flex-wrap gap-1.5"
                    role="group"
                    aria-label={getCapabilityLabel(capability)}
                >
                    {plugins.map((plugin) => {
                        const isActive = plugin.pluginId === selectedPluginId;
                        return (
                            <ProviderChoiceButton
                                key={plugin.pluginId}
                                name={plugin.name}
                                icon={plugin.icon}
                                isActive={isActive}
                                disabled={isPending}
                                nameClassName="max-w-36 truncate"
                                onSelect={() => handleSelect(plugin.pluginId)}
                            />
                        );
                    })}
                </div>
                <ActiveProviderModels
                    models={activePluginModels}
                    changeLabel={t('changeModels')}
                    onConfigure={
                        activePluginModels && activePlugin && canConfigureDirectoryModels
                            ? () => setSettingsPluginId(activePlugin.pluginId)
                            : undefined
                    }
                />
            </div>
            {settingsPlugin && canConfigureDirectoryModels && directoryId && (
                <DirectoryPluginSettingsModal
                    open={settingsPluginId !== null}
                    onOpenChange={(open) => {
                        if (!open) setSettingsPluginId(null);
                    }}
                    directoryId={directoryId}
                    plugin={settingsPlugin}
                />
            )}
        </div>
    );
}
