'use client';

import { useState, useTransition, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DirectoryPlugin } from '@/lib/api/plugins';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { Power, PowerOff, Settings, Shield } from 'lucide-react';
import { enableDirectoryPlugin, disableDirectoryPlugin } from '@/app/actions/plugins';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import { getCategoryLabel, getCapabilityLabel } from '@/lib/utils/plugin-category-icons';
import { DirectoryPluginSettingsModal } from './DirectoryPluginSettingsModal';

interface DirectoryPluginCardProps {
    directoryId: string;
    plugin: DirectoryPlugin;
}

export function DirectoryPluginCard({ directoryId, plugin }: DirectoryPluginCardProps) {
    const t = useTranslations('dashboard.directoryPlugins');
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [showModal, setShowModal] = useState(false);

    // Plugin must be enabled at user level to be enabled at directory level
    const canEnable = plugin.installed && plugin.enabled;
    const isEnabled = plugin.directoryEnabled;

    // Determine if plugin has directory-scoped settings
    const hasDirectorySettings = useMemo(() => {
        if (!plugin.settingsSchema?.properties) return false;
        return Object.values(plugin.settingsSchema.properties).some((prop) => {
            if (prop.hidden) return false;
            const scope = prop.scope || 'global';
            return scope === 'global' || scope === 'directory';
        });
    }, [plugin.settingsSchema]);

    const isClickable = isEnabled && hasDirectorySettings;

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

    const handleCardClick = () => {
        if (isClickable) {
            setShowModal(true);
        }
    };

    return (
        <>
            <div
                role={isClickable ? 'button' : undefined}
                tabIndex={isClickable ? 0 : undefined}
                onClick={handleCardClick}
                onKeyDown={
                    isClickable
                        ? (e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  setShowModal(true);
                              }
                          }
                        : undefined
                }
                className={cn(
                    'bg-surface dark:bg-surface-dark rounded-lg border border-border dark:border-border-dark p-4',
                    'transition-all',
                    isEnabled && 'ring-2 ring-primary/20',
                    !canEnable && !isEnabled && 'opacity-60',
                    isClickable && 'cursor-pointer hover:border-primary/40',
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

                    <div className="flex items-center gap-1.5">
                        {isClickable && (
                            <Settings className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                        )}
                        {plugin.systemPlugin ? (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary flex items-center gap-1">
                                <Shield className="w-3 h-3" />
                                System
                            </span>
                        ) : (
                            <Button
                                variant={isEnabled ? 'ghost' : 'primary'}
                                size="sm"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleToggle();
                                }}
                                disabled={isPending || (!canEnable && !isEnabled)}
                                loading={isPending}
                                className={cn(
                                    isEnabled && 'text-danger hover:text-danger hover:bg-danger/10',
                                )}
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
                                        <span className="sr-only md:not-sr-only md:ml-1">
                                            {t('disable')}
                                        </span>
                                    </>
                                ) : (
                                    <>
                                        <Power className="w-4 h-4" />
                                        <span className="sr-only md:not-sr-only md:ml-1">
                                            {t('enable')}
                                        </span>
                                    </>
                                )}
                            </Button>
                        )}
                    </div>
                </div>

                {!canEnable && !isEnabled && !plugin.systemPlugin && (
                    <p className="text-xs text-warning mt-2">
                        {plugin.installed ? t('disabledByUser') : t('enableAtUserLevelFirst')}
                    </p>
                )}

                {plugin.description && (
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-3 line-clamp-2">
                        {plugin.description}
                    </p>
                )}

                <div className="flex flex-wrap gap-1.5 mt-3">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary dark:text-text-secondary-dark">
                        {getCategoryLabel(plugin.category)}
                    </span>
                    {plugin.capabilities
                        .filter((cap) => cap !== plugin.category)
                        .slice(0, 2)
                        .map((cap) => (
                            <span
                                key={cap}
                                className={cn(
                                    'text-xs px-2 py-0.5 rounded-full',
                                    plugin.activeCapability === cap
                                        ? 'bg-primary/20 text-primary'
                                        : 'bg-surface-tertiary dark:bg-surface-tertiary-dark text-text-muted dark:text-text-muted-dark',
                                )}
                            >
                                {getCapabilityLabel(cap)}
                                {plugin.activeCapability === cap && ' ✓'}
                            </span>
                        ))}
                    {plugin.capabilities.filter((cap) => cap !== plugin.category).length > 2 && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-surface-tertiary dark:bg-surface-tertiary-dark text-text-muted dark:text-text-muted-dark">
                            +
                            {plugin.capabilities.filter((cap) => cap !== plugin.category).length -
                                2}
                        </span>
                    )}
                </div>

                {isClickable && (
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-2">
                        {t('clickToConfigure')}
                    </p>
                )}
            </div>

            {isClickable && (
                <DirectoryPluginSettingsModal
                    open={showModal}
                    onOpenChange={setShowModal}
                    directoryId={directoryId}
                    plugin={plugin}
                />
            )}
        </>
    );
}
