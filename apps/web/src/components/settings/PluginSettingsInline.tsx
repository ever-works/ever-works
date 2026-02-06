'use client';

import { useState, useTransition, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { UserPlugin, PluginSettingsSchemaProperty } from '@/lib/api/plugins';
import { OAuthConnectionInfo } from '@/lib/api/oauth';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { Power, PowerOff, Save, ExternalLink, Check, AlertCircle } from 'lucide-react';
import { updatePluginSettings, enablePlugin, disablePlugin } from '@/app/actions/plugins';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import { PluginSettingsField } from '@/components/plugins/PluginSettingsField';
import { PluginOAuthConnection } from '@/components/settings/PluginOAuthConnection';
import { getCategoryLabel, getCapabilityLabel } from '@/lib/utils/plugin-category-icons';

interface PluginSettingsInlineProps {
    plugin: UserPlugin;
    oauthConnection?: OAuthConnectionInfo | null;
}

export function PluginSettingsInline({ plugin, oauthConnection }: PluginSettingsInlineProps) {
    const t = useTranslations('dashboard.plugins');
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [isSaving, setIsSaving] = useState(false);
    const [settings, setSettings] = useState<Record<string, unknown>>(plugin.settings || {});
    const [secretSettings, setSecretSettings] = useState<Record<string, unknown>>({});
    const [hasChanges, setHasChanges] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState(false);
    const [validationError, setValidationError] = useState<string | null>(null);

    const schema = plugin.settingsSchema;

    // Filter properties to show only 'global' or 'user' scoped settings
    // Also filter out writeOnly fields which cannot be displayed after being set
    const userScopeProperties = useMemo(() => {
        if (!schema?.properties) return {};
        return Object.fromEntries(
            Object.entries(schema.properties).filter(([_, propSchema]) => {
                const prop = propSchema as PluginSettingsSchemaProperty;
                const scope = prop.scope || 'global';
                // Filter out writeOnly fields
                if (prop.writeOnly) return false;
                // Show global and user-scoped settings in user settings page
                return scope === 'global' || scope === 'user';
            }),
        );
    }, [schema]);

    const hasSettings = Object.keys(userScopeProperties).length > 0;

    // Get required fields for user scope (global and user scoped)
    const requiredFields = useMemo(() => {
        if (!schema?.required || !schema.properties) return [];
        return schema.required.filter((field) => {
            const propSchema = schema.properties?.[field] as
                | PluginSettingsSchemaProperty
                | undefined;
            if (!propSchema) return false;
            const scope = propSchema.scope || 'global';
            return scope === 'global' || scope === 'user';
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
        startTransition(async () => {
            try {
                if (plugin.enabled) {
                    await disablePlugin(plugin.pluginId);
                } else {
                    await enablePlugin(plugin.pluginId);
                }
                router.refresh();
            } catch (error) {
                console.error('Failed to toggle plugin:', error);
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

    const handleSave = async () => {
        // Validate required fields before saving
        const missingFields = validateRequiredFields();
        if (missingFields.length > 0) {
            setValidationError(t('missingRequiredFields', { fields: missingFields.join(', ') }));
            return;
        }

        setIsSaving(true);
        setValidationError(null);
        try {
            await updatePluginSettings(plugin.pluginId, {
                settings: Object.keys(settings).length > 0 ? settings : undefined,
                secretSettings: Object.keys(secretSettings).length > 0 ? secretSettings : undefined,
            });
            setHasChanges(false);
            setSaveSuccess(true);
            router.refresh();
            // Clear success message after 3 seconds
            setTimeout(() => setSaveSuccess(false), 3000);
        } catch (error) {
            console.error('Failed to save settings:', error);
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

    return (
        <div className="space-y-6">
            {/* Plugin Header */}
            <div className="flex items-start gap-4">
                <PluginIcon icon={plugin.icon} name={plugin.name} size={56} />

                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3">
                        <h2 className="text-xl font-semibold text-text dark:text-text-dark">
                            {plugin.name}
                        </h2>
                        <span className="text-sm text-text-muted dark:text-text-muted-dark">
                            v{plugin.version}
                        </span>
                        {plugin.builtIn && (
                            <span className="text-xs px-2 py-0.5 rounded bg-surface-tertiary dark:bg-surface-tertiary-dark text-text-muted dark:text-text-muted-dark">
                                {t('builtIn')}
                            </span>
                        )}
                    </div>

                    {plugin.description && (
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1 line-clamp-2">
                            {plugin.description}
                        </p>
                    )}

                    <div className="flex flex-wrap items-center gap-2 mt-2">
                        <span className="shrink-0 text-xs px-2 py-1 rounded-full bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary dark:text-text-secondary-dark">
                            {getCategoryLabel(plugin.category)}
                        </span>
                        {plugin.capabilities
                            .filter((cap) => cap !== plugin.category)
                            .slice(0, 3)
                            .map((cap) => (
                                <span
                                    key={cap}
                                    className="shrink-0 text-xs px-2 py-1 rounded-full bg-surface-tertiary dark:bg-surface-tertiary-dark text-text-muted dark:text-text-muted-dark"
                                >
                                    {getCapabilityLabel(cap)}
                                </span>
                            ))}

                        {(plugin.author || plugin.homepage) && (
                            <div className="flex items-center gap-3 ml-auto text-xs text-text-muted dark:text-text-muted-dark">
                                {plugin.author && <span>{plugin.author.name}</span>}
                                {plugin.homepage && (
                                    <a
                                        href={plugin.homepage}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 hover:text-primary"
                                    >
                                        <ExternalLink className="w-3 h-3" />
                                        Docs
                                    </a>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                {!plugin.systemPlugin && (
                    <Button
                        variant={plugin.enabled ? 'ghost' : 'primary'}
                        size="sm"
                        onClick={handleToggle}
                        disabled={isPending}
                        loading={isPending}
                        className={cn(
                            plugin.enabled && 'text-danger hover:text-danger hover:bg-danger/10',
                        )}
                    >
                        {plugin.enabled ? (
                            <>
                                <PowerOff className="w-4 h-4 mr-1.5" />
                                {t('disable')}
                            </>
                        ) : (
                            <>
                                <Power className="w-4 h-4 mr-1.5" />
                                {t('enable')}
                            </>
                        )}
                    </Button>
                )}
            </div>

            {/* Divider */}
            <hr className="border-border dark:border-border-dark" />

            {/* OAuth Connection Section */}
            {plugin.capabilities.includes('oauth') && oauthConnection !== undefined && (
                <PluginOAuthConnection
                    pluginId={plugin.pluginId}
                    pluginName={plugin.name}
                    connection={oauthConnection}
                />
            )}

            {/* Settings Form */}
            {hasSettings ? (
                <div className="space-y-6">
                    <h3 className="text-lg font-medium text-text dark:text-text-dark">
                        {t('settingsTitle')}
                    </h3>

                    <div className="space-y-4">
                        {Object.entries(userScopeProperties).map(([key, propSchema]) => (
                            <PluginSettingsField
                                key={key}
                                name={key}
                                schema={propSchema}
                                value={settings[key]}
                                required={schema?.required?.includes(key)}
                                onChange={(value) =>
                                    handleFieldChange(key, value, propSchema.secret || false)
                                }
                                pluginId={plugin.pluginId}
                            />
                        ))}
                    </div>

                    {validationError && (
                        <div className="p-3 rounded-lg bg-danger/10 border border-danger/20 flex items-start gap-2">
                            <AlertCircle className="w-5 h-5 text-danger flex-shrink-0 mt-0.5" />
                            <p className="text-sm text-danger">{validationError}</p>
                        </div>
                    )}

                    <div className="flex items-center gap-3 pt-4 border-t border-border dark:border-border-dark">
                        <Button
                            variant="primary"
                            onClick={handleSave}
                            disabled={!hasChanges || isSaving}
                            loading={isSaving}
                        >
                            <Save className="w-4 h-4 mr-2" />
                            {t('saveSettings')}
                        </Button>

                        {saveSuccess && (
                            <span className="inline-flex items-center gap-1 text-sm text-success">
                                <Check className="w-4 h-4" />
                                {t('settingsSaved')}
                            </span>
                        )}
                    </div>
                </div>
            ) : (
                <div className="py-8 text-center">
                    <p className="text-text-muted dark:text-text-muted-dark">{t('noSettings')}</p>
                </div>
            )}
        </div>
    );
}
