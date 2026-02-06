'use client';

import { useState, useTransition, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DirectoryPlugin } from '@/lib/api/plugins';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { Power, PowerOff, Settings, Save, Check, AlertCircle } from 'lucide-react';
import {
    enableDirectoryPlugin,
    disableDirectoryPlugin,
    updateDirectoryPluginSettings,
} from '@/app/actions/plugins';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import { PluginSettingsField } from '@/components/plugins/PluginSettingsField';
import { getCategoryLabel, getCapabilityLabel } from '@/lib/utils/plugin-category-icons';
import { usePluginSettings } from '@/lib/hooks/use-plugin-settings';

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

    const onSave = useCallback(
        async (data: {
            settings?: Record<string, unknown>;
            secretSettings?: Record<string, unknown>;
        }) => {
            await updateDirectoryPluginSettings(directoryId, plugin.pluginId, data);
        },
        [directoryId, plugin.pluginId],
    );

    const {
        hasChanges,
        isSaving,
        saveSuccess,
        validationError,
        visibleProperties,
        hasSettings: hasDirectorySettings,
        handleFieldChange,
        handleSave,
        getFieldValue,
    } = usePluginSettings({
        schema: plugin.settingsSchema,
        initialSettings: plugin.directorySettings || {},
        scopes: ['global', 'directory'],
        onSave,
    });

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

                {!plugin.systemPlugin && (
                    <Button
                        variant={isEnabled ? 'ghost' : 'primary'}
                        size="sm"
                        onClick={handleToggle}
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
                        +{plugin.capabilities.filter((cap) => cap !== plugin.category).length - 2}
                    </span>
                )}
            </div>

            {isEnabled && hasDirectorySettings && (
                <div className="mt-3 pt-3 border-t border-border dark:border-border-dark">
                    <button
                        onClick={() => setShowSettings(!showSettings)}
                        className="text-sm text-primary hover:text-primary-hover flex items-center gap-1"
                    >
                        <Settings className="w-4 h-4" />
                        {showSettings ? t('hideSettings') : t('showSettings')}
                    </button>

                    {showSettings && (
                        <div className="mt-3 space-y-3">
                            {Object.entries(visibleProperties).map(([key, propSchema]) => (
                                <PluginSettingsField
                                    key={key}
                                    name={key}
                                    schema={propSchema}
                                    value={getFieldValue(key, propSchema)}
                                    required={plugin.settingsSchema?.required?.includes(key)}
                                    onChange={(value) =>
                                        handleFieldChange(key, value, propSchema.secret || false)
                                    }
                                    pluginId={plugin.pluginId}
                                />
                            ))}
                            {validationError && (
                                <div className="p-2 rounded bg-danger/10 border border-danger/20 flex items-start gap-2">
                                    <AlertCircle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
                                    <p className="text-xs text-danger">{validationError}</p>
                                </div>
                            )}
                            <div className="flex items-center gap-2 pt-2">
                                <Button
                                    size="sm"
                                    onClick={handleSave}
                                    disabled={!hasChanges || isSaving}
                                    loading={isSaving}
                                >
                                    <Save className="w-3 h-3 mr-1" />
                                    {t('save')}
                                </Button>
                                {saveSuccess && (
                                    <span className="inline-flex items-center gap-1 text-sm text-success">
                                        <Check className="w-4 h-4" />
                                        {t('saved')}
                                    </span>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
