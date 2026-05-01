'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DirectoryPlugin } from '@/lib/api/plugins';
import { cn } from '@/lib/utils/cn';
import { setActiveCapability } from '@/app/actions/plugins';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import { getCapabilityLabel, getCategoryIcon } from '@/lib/utils/plugin-category-icons';
import { Check } from 'lucide-react';

interface CapabilitySelectorProps {
    directoryId: string;
    capability: string;
    plugins: DirectoryPlugin[];
    activePluginId?: string;
}

export function CapabilitySelector({
    directoryId,
    capability,
    plugins,
    activePluginId,
}: CapabilitySelectorProps) {
    const t = useTranslations('dashboard.directoryPlugins');
    const router = useRouter();
    const CapabilityIcon = getCategoryIcon(capability);
    const [isPending, startTransition] = useTransition();
    const [selectedPluginId, setSelectedPluginId] = useState(activePluginId);

    useEffect(() => {
        setSelectedPluginId(activePluginId);
    }, [activePluginId]);

    const handleSelect = (pluginId: string) => {
        if (pluginId === selectedPluginId || isPending) return;

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

            <div
                className="flex min-w-0 flex-wrap gap-1.5"
                role="group"
                aria-label={getCapabilityLabel(capability)}
            >
                {plugins.map((plugin) => {
                    const isActive = plugin.pluginId === selectedPluginId;
                    return (
                        <button
                            key={plugin.pluginId}
                            type="button"
                            aria-pressed={isActive}
                            onClick={() => handleSelect(plugin.pluginId)}
                            disabled={isPending}
                            className={cn(
                                'inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors duration-150',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                                isActive
                                    ? 'border-primary/40 bg-primary/10 text-primary'
                                    : 'border-border dark:border-border-dark bg-transparent text-text-secondary dark:text-text-secondary-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark hover:text-text dark:hover:text-text-dark hover:border-primary/30',
                                isPending && 'opacity-50 cursor-wait',
                            )}
                        >
                            <PluginIcon icon={plugin.icon} name={plugin.name} size={14} plain />
                            <span className="max-w-36 truncate">{plugin.name}</span>
                            {isActive && <Check className="w-3 h-3 ml-0.5" />}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
