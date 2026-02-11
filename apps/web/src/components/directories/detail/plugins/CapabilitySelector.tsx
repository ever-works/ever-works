'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DirectoryPlugin } from '@/lib/api/plugins';
import { cn } from '@/lib/utils/cn';
import { setActiveCapability } from '@/app/actions/plugins';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import { getCapabilityLabel } from '@/lib/utils/plugin-category-icons';

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
    const [isPending, startTransition] = useTransition();

    const handleSelect = async (pluginId: string) => {
        if (pluginId === activePluginId) return;

        startTransition(async () => {
            try {
                await setActiveCapability(directoryId, pluginId, capability);
                router.refresh();
            } catch (error) {
                console.error('Failed to set active capability:', error);
            }
        });
    };

    if (plugins.length === 0) {
        return null;
    }

    return (
        <div className="flex items-center gap-3 py-2">
            <div className="w-32 shrink-0">
                <span className="text-sm font-medium text-text dark:text-text-dark">
                    {getCapabilityLabel(capability)}
                </span>
            </div>

            <div className="flex-1 flex flex-wrap gap-2">
                {plugins.map((plugin) => {
                    const isActive = plugin.pluginId === activePluginId;
                    return (
                        <button
                            key={plugin.pluginId}
                            onClick={() => handleSelect(plugin.pluginId)}
                            disabled={isPending || isActive}
                            className={cn(
                                'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors',
                                'border',
                                isActive
                                    ? 'border-primary bg-primary/10 text-primary'
                                    : 'border-border dark:border-border-dark hover:border-primary/50 text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark',
                                isPending && 'opacity-50 cursor-wait',
                            )}
                        >
                            <PluginIcon icon={plugin.icon} name={plugin.name} size={20} />
                            <span>{plugin.name}</span>
                            {isActive && (
                                <svg
                                    className="w-4 h-4 text-primary"
                                    fill="currentColor"
                                    viewBox="0 0 20 20"
                                >
                                    <path
                                        fillRule="evenodd"
                                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                        clipRule="evenodd"
                                    />
                                </svg>
                            )}
                        </button>
                    );
                })}
            </div>

            {plugins.length === 0 && (
                <span className="text-sm text-text-muted dark:text-text-muted-dark italic">
                    {t('noProvidersAvailable')}
                </span>
            )}
        </div>
    );
}
