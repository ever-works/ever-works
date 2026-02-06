'use client';

import { useState, useTransition, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { UserPlugin, PluginSettingsSchemaProperty } from '@/lib/api/plugins';
import type { OAuthConnectionInfo } from '@/lib/api/oauth';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import {
    Power,
    PowerOff,
    Save,
    ArrowLeft,
    ExternalLink,
    Check,
    AlertCircle,
    BookOpen,
    Settings,
} from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { enablePlugin, disablePlugin, updatePluginSettings } from '@/app/actions/plugins';
import { PluginIcon } from './PluginIcon';
import { PluginSettingsField } from './PluginSettingsField';
import { PluginReadme } from './PluginReadme';
import { PluginOAuthConnection } from '@/components/settings/PluginOAuthConnection';
import { getCategoryLabel, getCapabilityLabel } from '@/lib/utils/plugin-category-icons';

interface PluginSettingsProps {
    plugin: UserPlugin;
    oauthConnection?: OAuthConnectionInfo | null;
}

export function PluginSettings({ plugin, oauthConnection }: PluginSettingsProps) {
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
    const userScopeProperties = useMemo(() => {
        if (!schema?.properties) return {};
        return Object.fromEntries(
            Object.entries(schema.properties).filter(([_, propSchema]) => {
                const prop = propSchema as PluginSettingsSchemaProperty;
                const scope = prop.scope || 'global';
                // Filter out hidden fields (writeOnly fields are shown - they're secret inputs)
                if (prop.hidden) return false;
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
            {/* Back link */}
            <Link
                href={ROUTES.DASHBOARD_PLUGINS}
                className="inline-flex items-center gap-1.5 text-sm text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark transition-colors"
            >
                <ArrowLeft className="w-4 h-4" />
                {t('backToPlugins')}
            </Link>

            {/* Plugin Header */}
            <div className="bg-surface dark:bg-surface-dark rounded-xl border border-border dark:border-border-dark overflow-hidden">
                <div className="p-6">
                    <div className="flex items-start gap-4">
                        <PluginIcon
                            icon={plugin.icon}
                            name={plugin.name}
                            size={56}
                            className="rounded-xl shrink-0"
                        />

                        <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <div className="flex items-center gap-2.5 flex-wrap">
                                        <h1 className="text-xl font-semibold text-text dark:text-text-dark">
                                            {plugin.name}
                                        </h1>
                                        <span className="text-xs font-mono text-text-muted dark:text-text-muted-dark bg-surface-secondary dark:bg-surface-secondary-dark px-1.5 py-0.5 rounded">
                                            v{plugin.version}
                                        </span>
                                        {plugin.systemPlugin && (
                                            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                                                {t('system')}
                                            </span>
                                        )}
                                        {plugin.builtIn && !plugin.systemPlugin && (
                                            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-surface-tertiary dark:bg-surface-tertiary-dark text-text-muted dark:text-text-muted-dark">
                                                {t('builtIn')}
                                            </span>
                                        )}
                                    </div>

                                    {plugin.description && (
                                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-2 leading-relaxed">
                                            {plugin.description}
                                        </p>
                                    )}
                                </div>

                                {!plugin.systemPlugin && (
                                    <Button
                                        variant={plugin.enabled ? 'ghost' : 'primary'}
                                        onClick={handleToggle}
                                        disabled={isPending}
                                        loading={isPending}
                                        className={cn(
                                            'shrink-0',
                                            plugin.enabled &&
                                                'text-danger hover:text-danger hover:bg-danger/10',
                                        )}
                                    >
                                        {plugin.enabled ? (
                                            <>
                                                <PowerOff className="w-4 h-4 mr-2" />
                                                {t('disable')}
                                            </>
                                        ) : (
                                            <>
                                                <Power className="w-4 h-4 mr-2" />
                                                {t('enable')}
                                            </>
                                        )}
                                    </Button>
                                )}
                            </div>

                            {/* Capability badges */}
                            <div className="flex flex-wrap gap-1.5 mt-3">
                                {plugin.capabilities
                                    .filter((cap) => cap !== plugin.category)
                                    .map((cap) => (
                                        <span
                                            key={cap}
                                            className="text-xs px-2 py-0.5 rounded-full bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary dark:text-text-secondary-dark"
                                        >
                                            {getCapabilityLabel(cap)}
                                        </span>
                                    ))}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Metadata footer */}
                {(plugin.author || plugin.homepage) && (
                    <div className="px-6 py-3 border-t border-border dark:border-border-dark bg-surface-secondary/30 dark:bg-surface-secondary-dark/30">
                        <div className="flex items-center gap-4 text-xs text-text-muted dark:text-text-muted-dark">
                            {plugin.author && (
                                <span>
                                    {t('author')}: {plugin.author.name}
                                </span>
                            )}
                            {plugin.author && plugin.homepage && (
                                <span className="text-border dark:text-border-dark">|</span>
                            )}
                            {plugin.homepage && (
                                <a
                                    href={plugin.homepage}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 hover:text-primary transition-colors"
                                >
                                    <ExternalLink className="w-3.5 h-3.5" />
                                    {t('documentation')}
                                </a>
                            )}
                            <span className="text-border dark:text-border-dark">|</span>
                            <span>{getCategoryLabel(plugin.category)}</span>
                        </div>
                    </div>
                )}
            </div>

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
                <div className="bg-surface dark:bg-surface-dark rounded-xl border border-border dark:border-border-dark">
                    <div className="flex items-center gap-2 px-6 py-3 border-b border-border dark:border-border-dark">
                        <Settings className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                        <h2 className="text-sm font-medium text-text dark:text-text-dark">
                            {t('settingsTitle')}
                        </h2>
                    </div>

                    <div className="p-6 space-y-4">
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
                        <div className="mx-6 mb-4 p-3 rounded-lg bg-danger/10 border border-danger/20 flex items-start gap-2">
                            <AlertCircle className="w-5 h-5 text-danger flex-shrink-0 mt-0.5" />
                            <p className="text-sm text-danger">{validationError}</p>
                        </div>
                    )}

                    <div className="flex items-center gap-3 px-6 py-4 border-t border-border dark:border-border-dark">
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
            ) : null}

            {/* Readme Section */}
            {plugin.readme && (
                <div className="bg-surface dark:bg-surface-dark rounded-xl border border-border dark:border-border-dark">
                    <div className="flex items-center gap-2 px-6 py-3 border-b border-border dark:border-border-dark">
                        <BookOpen className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                        <h2 className="text-sm font-medium text-text dark:text-text-dark">
                            {t('about')}
                        </h2>
                    </div>
                    <div className="p-6">
                        <PluginReadme content={plugin.readme} />
                    </div>
                </div>
            )}
        </div>
    );
}
