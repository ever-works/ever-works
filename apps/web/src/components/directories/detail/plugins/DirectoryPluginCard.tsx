'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DirectoryPlugin } from '@/lib/api/plugins';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { Power, PowerOff, Settings } from 'lucide-react';
import { enableDirectoryPlugin, disableDirectoryPlugin } from '@/app/actions/plugins';
import { PluginIcon } from '@/components/plugins/PluginIcon';

interface DirectoryPluginCardProps {
    directoryId: string;
    plugin: DirectoryPlugin;
}

export function DirectoryPluginCard({ directoryId, plugin }: DirectoryPluginCardProps) {
    const t = useTranslations('dashboard.directoryPlugins');
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [showSettings, setShowSettings] = useState(false);

    // Plugin must be enabled at user level to be enabled at directory level
    const canEnable = plugin.installed && plugin.enabled;
    const isEnabled = plugin.directoryEnabled;

    const handleToggle = async () => {
        if (!canEnable && !isEnabled) {
            return;
        }

        startTransition(async () => {
            try {
                if (isEnabled) {
                    await disableDirectoryPlugin(directoryId, plugin.pluginId);
                } else {
                    await enableDirectoryPlugin(directoryId, plugin.pluginId);
                }
                router.refresh();
            } catch (error) {
                console.error('Failed to toggle directory plugin:', error);
            }
        });
    };

    const categoryLabels: Record<string, string> = {
        git: t('categories.git'),
        deployment: t('categories.deployment'),
        screenshot: t('categories.screenshot'),
        search: t('categories.search'),
        content: t('categories.content'),
        'data-source': t('categories.dataSource'),
        ai: t('categories.ai'),
        pipeline: t('categories.pipeline'),
    };

    return (
        <div
            className={cn(
                'bg-surface dark:bg-surface-dark rounded-lg border border-border dark:border-border-dark p-4',
                'transition-all',
                isEnabled && 'ring-2 ring-primary/20',
                !canEnable && !isEnabled && 'opacity-60',
            )}
        >
            <div className="flex items-start gap-3">
                <PluginIcon icon={plugin.icon} name={plugin.name} size={40} />

                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <h3 className="font-medium text-text dark:text-text-dark truncate">
                            {plugin.name}
                        </h3>
                        {isEnabled && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-success/20 text-success">
                                {t('active')}
                            </span>
                        )}
                    </div>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark mt-0.5">
                        v{plugin.version}
                    </p>
                </div>

                <Button
                    variant={isEnabled ? 'ghost' : 'primary'}
                    size="sm"
                    onClick={handleToggle}
                    disabled={isPending || (!canEnable && !isEnabled)}
                    loading={isPending}
                    className={cn(isEnabled && 'text-danger hover:text-danger hover:bg-danger/10')}
                    title={
                        !canEnable && !isEnabled
                            ? t('enableAtUserLevelFirst')
                            : isEnabled
                              ? t('disableForDirectory')
                              : t('enableForDirectory')
                    }
                >
                    {isEnabled ? (
                        <>
                            <PowerOff className="w-4 h-4" />
                            <span className="sr-only md:not-sr-only md:ml-1">{t('disable')}</span>
                        </>
                    ) : (
                        <>
                            <Power className="w-4 h-4" />
                            <span className="sr-only md:not-sr-only md:ml-1">{t('enable')}</span>
                        </>
                    )}
                </Button>
            </div>

            {!canEnable && !isEnabled && (
                <p className="text-xs text-warning mt-2">{t('enableAtUserLevelFirst')}</p>
            )}

            {plugin.description && (
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-3 line-clamp-2">
                    {plugin.description}
                </p>
            )}

            <div className="flex flex-wrap gap-1.5 mt-3">
                <span className="text-xs px-2 py-0.5 rounded-full bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary dark:text-text-secondary-dark">
                    {categoryLabels[plugin.category] || plugin.category}
                </span>
                {plugin.capabilities.slice(0, 2).map((cap) => (
                    <span
                        key={cap}
                        className={cn(
                            'text-xs px-2 py-0.5 rounded-full',
                            plugin.activeCapability === cap
                                ? 'bg-primary/20 text-primary'
                                : 'bg-surface-tertiary dark:bg-surface-tertiary-dark text-text-muted dark:text-text-muted-dark',
                        )}
                    >
                        {cap}
                        {plugin.activeCapability === cap && ' ✓'}
                    </span>
                ))}
                {plugin.capabilities.length > 2 && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-surface-tertiary dark:bg-surface-tertiary-dark text-text-muted dark:text-text-muted-dark">
                        +{plugin.capabilities.length - 2}
                    </span>
                )}
            </div>

            {isEnabled && plugin.settingsSchema && (
                <div className="mt-3 pt-3 border-t border-border dark:border-border-dark">
                    <button
                        onClick={() => setShowSettings(!showSettings)}
                        className="text-sm text-primary hover:text-primary-hover flex items-center gap-1"
                    >
                        <Settings className="w-4 h-4" />
                        {showSettings ? t('hideSettings') : t('showSettings')}
                    </button>

                    {showSettings && (
                        <div className="mt-3 text-sm text-text-muted dark:text-text-muted-dark">
                            {/* Directory-specific settings could be rendered here */}
                            <p>{t('directorySettingsInfo')}</p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
