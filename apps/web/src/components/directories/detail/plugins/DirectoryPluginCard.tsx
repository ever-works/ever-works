'use client';

import { useState, useTransition, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DirectoryPlugin, PluginSettingsSchemaProperty } from '@/lib/api/plugins';
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

interface DirectoryPluginCardProps {
    directoryId: string;
    plugin: DirectoryPlugin;
}

export function DirectoryPluginCard({ directoryId, plugin }: DirectoryPluginCardProps) {
    const t = useTranslations('dashboard.directoryPlugins');
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [showSettings, setShowSettings] = useState(false);
    const [settings, setSettings] = useState<Record<string, unknown>>(
        plugin.directorySettings || {},
    );
    const [secretSettings, setSecretSettings] = useState<Record<string, unknown>>({});
    const [hasChanges, setHasChanges] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState(false);
    const [validationError, setValidationError] = useState<string | null>(null);

    const schema = plugin.settingsSchema;

    // Plugin must be enabled at user level to be enabled at directory level
    const canEnable = plugin.installed && plugin.enabled;
    const isEnabled = plugin.directoryEnabled;

    // Filter properties to show only 'global' or 'directory' scoped settings
    // Also filter out writeOnly fields which cannot be displayed after being set
    const directoryScopeProperties = useMemo(() => {
        if (!schema?.properties) return {};
        return Object.fromEntries(
            Object.entries(schema.properties).filter(([_, propSchema]) => {
                const prop = propSchema as PluginSettingsSchemaProperty;
                const scope = prop.scope || 'global';
                // Filter out writeOnly fields
                if (prop.writeOnly) return false;
                // Show global and directory-scoped settings in directory settings
                return scope === 'global' || scope === 'directory';
            }),
        );
    }, [schema]);

    const hasDirectorySettings = Object.keys(directoryScopeProperties).length > 0;

    // Get required fields for directory scope
    const requiredFields = useMemo(() => {
        if (!schema?.required || !schema.properties) return [];
        return schema.required.filter((field) => {
            const propSchema = schema.properties?.[field] as
                | PluginSettingsSchemaProperty
                | undefined;
            if (!propSchema) return false;
            const scope = propSchema.scope || 'global';
            return scope === 'global' || scope === 'directory';
        });
    }, [schema]);

    // Validate required fields before saving
    const validateRequiredFields = useCallback((): string[] => {
        const missingFields: string[] = [];
        for (const field of requiredFields) {
            const value = settings[field] ?? secretSettings[field];
            if (value === undefined || value === null || value === '') {
                const propSchema = schema?.properties?.[field] as
                    | PluginSettingsSchemaProperty
                    | undefined;
                const label = propSchema?.title || field;
                missingFields.push(label);
            }
        }
        return missingFields;
    }, [requiredFields, settings, secretSettings, schema]);

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

    const handleFieldChange = (key: string, value: unknown, isSecret: boolean) => {
        if (isSecret) {
            setSecretSettings((prev) => ({ ...prev, [key]: value }));
        } else {
            setSettings((prev) => ({ ...prev, [key]: value }));
        }
        setHasChanges(true);
        setSaveSuccess(false);
        setValidationError(null);
    };

    const handleSaveSettings = async () => {
        // Validate required fields before saving
        const missingFields = validateRequiredFields();
        if (missingFields.length > 0) {
            setValidationError(t('missingRequiredFields', { fields: missingFields.join(', ') }));
            return;
        }

        setIsSaving(true);
        setValidationError(null);
        try {
            await updateDirectoryPluginSettings(directoryId, plugin.pluginId, {
                settings: Object.keys(settings).length > 0 ? settings : undefined,
                secretSettings: Object.keys(secretSettings).length > 0 ? secretSettings : undefined,
            });
            setHasChanges(false);
            setSaveSuccess(true);
            router.refresh();
            // Clear success message after 3 seconds
            setTimeout(() => setSaveSuccess(false), 3000);
        } catch (error) {
            console.error('Failed to save directory settings:', error);
            // Extract error message from response if available
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : typeof error === 'object' && error !== null && 'message' in error
                      ? String((error as { message: unknown }).message)
                      : t('saveError');
            setValidationError(errorMessage);
        } finally {
            setIsSaving(false);
        }
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
                            {Object.entries(directoryScopeProperties).map(([key, propSchema]) => (
                                <PluginSettingsField
                                    key={key}
                                    name={key}
                                    schema={propSchema}
                                    value={settings[key]}
                                    required={schema?.required?.includes(key)}
                                    onChange={(value) =>
                                        handleFieldChange(key, value, propSchema.secret || false)
                                    }
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
                                    onClick={handleSaveSettings}
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
