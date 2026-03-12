'use client';

import { useOptimistic, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { DirectoryPlugin } from '@/lib/api/plugins';
import { cn } from '@/lib/utils/cn';
import { setActiveCapability } from '@/app/actions/plugins';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import { getCapabilityLabel } from '@/lib/utils/plugin-category-icons';
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
    const [isPending, startTransition] = useTransition();
    const [optimisticActiveId, setOptimisticActiveId] = useOptimistic(activePluginId);

    const handleSelect = (pluginId: string) => {
        if (pluginId === optimisticActiveId) return;

        startTransition(async () => {
            setOptimisticActiveId(pluginId);
            try {
                const result = await setActiveCapability(directoryId, pluginId, capability);
                if (!result.success) {
                    console.error('Failed to set active capability:', result.error);
                }
            } catch (error) {
                console.error('Failed to set active capability:', error);
            }
        });
    };

    if (plugins.length === 0) {
        return null;
    }

    return (
        <div className="flex items-center gap-4 px-5 py-3">
            <div className="w-36 shrink-0">
                <code className="text-xs font-mono font-medium text-text-secondary dark:text-text-secondary-dark bg-surface-secondary dark:bg-surface-secondary-dark px-1.5 py-0.5 rounded">
                    {getCapabilityLabel(capability)}
                </code>
            </div>

            <div className="flex-1 flex flex-wrap gap-1.5">
                {plugins.map((plugin) => {
                    const isActive = plugin.pluginId === optimisticActiveId;
                    return (
                        <button
                            key={plugin.pluginId}
                            onClick={() => handleSelect(plugin.pluginId)}
                            disabled={isPending}
                            className={cn(
                                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border transition-all duration-150',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                                isActive
                                    ? 'border-primary/40 bg-primary/10 text-primary shadow-sm'
                                    : 'border-border dark:border-border-dark bg-transparent text-text-secondary dark:text-text-secondary-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark hover:text-text dark:hover:text-text-dark hover:border-primary/30',
                                isPending && 'opacity-50 cursor-wait',
                            )}
                        >
                            <PluginIcon icon={plugin.icon} name={plugin.name} size={14} plain />
                            <span>{plugin.name}</span>
                            {isActive && <Check className="w-3 h-3 ml-0.5" />}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
