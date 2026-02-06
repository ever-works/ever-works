'use client';

import { useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { UserPlugin, PluginSettingsSchemaProperty } from '@/lib/api/plugins';
import { OAuthConnectionInfo } from '@/lib/api/oauth';
import { Button } from '@/components/ui/button';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Save, Check, AlertCircle } from 'lucide-react';
import { updatePluginSettings } from '@/app/actions/plugins';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import { PluginSettingsField } from '@/components/plugins/PluginSettingsField';
import { PluginOAuthConnection } from '@/components/settings/PluginOAuthConnection';
import { getCapabilityLabel } from '@/lib/utils/plugin-category-icons';

interface PluginSettingsInlineProps {
    plugin: UserPlugin;
    oauthConnection?: OAuthConnectionInfo | null;
    defaultExpanded?: boolean;
}

export function PluginSettingsInline({
    plugin,
    oauthConnection,
    defaultExpanded = false,
}: PluginSettingsInlineProps) {
    const t = useTranslations('dashboard.plugins');
    const router = useRouter();
    const [isSaving, setIsSaving] = useState(false);
    const [settings, setSettings] = useState<Record<string, unknown>>(plugin.settings || {});
    const [secretSettings, setSecretSettings] = useState<Record<string, unknown>>({});
    const [hasChanges, setHasChanges] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState(false);
    const [validationError, setValidationError] = useState<string | null>(null);

    const schema = plugin.settingsSchema;

    // Filter properties to show only 'global' or 'user' scoped settings
    const userScopeProperties = useMemo(() => {
        if (!schema?.properties) return {};
        return Object.fromEntries(
            Object.entries(schema.properties).filter(([_, propSchema]) => {
                const prop = propSchema as PluginSettingsSchemaProperty;
                const scope = prop.scope || 'global';
                // Show global and user-scoped settings in user settings page
                return scope === 'global' || scope === 'user';
            }),
        );
    }, [schema]);

    const hasSettings = Object.keys(userScopeProperties).length > 0;
    const hasOAuth = plugin.capabilities.includes('oauth') && oauthConnection !== undefined;

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

    const headerContent = (
        <div className="flex items-center gap-3 min-w-0">
            <PluginIcon
                icon={plugin.icon}
                name={plugin.name}
                size={36}
                className="shrink-0 rounded-lg"
            />
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-text dark:text-text-dark">
                        {plugin.name}
                    </span>
                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                        v{plugin.version}
                    </span>
                    {plugin.enabled && (
                        <span className="inline-flex items-center gap-1 text-xs text-success">
                            <span className="w-1.5 h-1.5 rounded-full bg-success" />
                            {t('enabled')}
                        </span>
                    )}
                    {plugin.capabilities
                        .filter((cap) => cap !== plugin.category)
                        .slice(0, 2)
                        .map((cap) => (
                            <span
                                key={cap}
                                className="text-xs px-1.5 py-0.5 rounded bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted dark:text-text-muted-dark"
                            >
                                {getCapabilityLabel(cap)}
                            </span>
                        ))}
                </div>
                {plugin.description && (
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5 line-clamp-1">
                        {plugin.description}
                    </p>
                )}
            </div>
        </div>
    );

    return (
        <CollapsibleCard header={headerContent} defaultExpanded={defaultExpanded}>
            <div className="p-5 space-y-5">
                {/* OAuth Connection Section */}
                {hasOAuth && (
                    <PluginOAuthConnection
                        pluginId={plugin.pluginId}
                        pluginName={plugin.name}
                        connection={oauthConnection!}
                    />
                )}

                {/* Settings Form */}
                {hasSettings ? (
                    <div className="space-y-4">
                        <div className="space-y-3">
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
                                <AlertCircle className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" />
                                <p className="text-sm text-danger">{validationError}</p>
                            </div>
                        )}

                        <div className="flex items-center gap-3 pt-3 border-t border-border dark:border-border-dark">
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={handleSave}
                                disabled={!hasChanges || isSaving}
                                loading={isSaving}
                            >
                                <Save className="w-3.5 h-3.5 mr-1.5" />
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
                ) : !hasOAuth ? (
                    <div className="py-4 text-center">
                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                            {t('noSettings')}
                        </p>
                    </div>
                ) : null}
            </div>
        </CollapsibleCard>
    );
}
