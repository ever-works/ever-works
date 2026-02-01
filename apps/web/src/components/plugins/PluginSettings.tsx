'use client';

import { useState, useTransition, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { UserPlugin, PluginSettingsSchemaProperty } from '@/lib/api/plugins';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { Power, PowerOff, Save, ArrowLeft, ExternalLink, Check } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { enablePlugin, disablePlugin, updatePluginSettings } from '@/app/actions/plugins';
import { PluginIcon } from './PluginIcon';
import { PluginSettingsField } from './PluginSettingsField';

interface PluginSettingsProps {
    plugin: UserPlugin;
}

export function PluginSettings({ plugin }: PluginSettingsProps) {
    const t = useTranslations('dashboard.plugins');
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [isSaving, setIsSaving] = useState(false);
    const [settings, setSettings] = useState<Record<string, unknown>>(plugin.settings || {});
    const [secretSettings, setSecretSettings] = useState<Record<string, unknown>>({});
    const [hasChanges, setHasChanges] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState(false);

    const schema = plugin.settingsSchema;

    // Filter properties to show only 'global' or 'user' scoped settings
    // Directory-scoped settings should only be shown in directory context
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
    };

    const handleSave = async () => {
        setIsSaving(true);
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
        <div className="space-y-6">
            {/* Back link */}
            <Link
                href={ROUTES.DASHBOARD_PLUGINS}
                className="inline-flex items-center gap-1 text-sm text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
            >
                <ArrowLeft className="w-4 h-4" />
                {t('backToPlugins')}
            </Link>

            {/* Plugin Header */}
            <div className="bg-surface dark:bg-surface-dark rounded-lg border border-border dark:border-border-dark p-6">
                <div className="flex items-start gap-4">
                    <PluginIcon icon={plugin.icon} name={plugin.name} size={64} />

                    <div className="flex-1">
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
                            <p className="text-text-secondary dark:text-text-secondary-dark mt-2">
                                {plugin.description}
                            </p>
                        )}

                        <div className="flex flex-wrap gap-2 mt-3">
                            <span className="text-xs px-2 py-1 rounded-full bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary dark:text-text-secondary-dark">
                                {categoryLabels[plugin.category] || plugin.category}
                            </span>
                            {plugin.capabilities.map((cap) => (
                                <span
                                    key={cap}
                                    className="text-xs px-2 py-1 rounded-full bg-surface-tertiary dark:bg-surface-tertiary-dark text-text-muted dark:text-text-muted-dark"
                                >
                                    {cap}
                                </span>
                            ))}
                        </div>

                        {(plugin.author || plugin.homepage) && (
                            <div className="flex items-center gap-4 mt-4 text-sm text-text-muted dark:text-text-muted-dark">
                                {plugin.author && (
                                    <span>
                                        {t('author')}: {plugin.author.name}
                                    </span>
                                )}
                                {plugin.homepage && (
                                    <a
                                        href={plugin.homepage}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 hover:text-primary"
                                    >
                                        <ExternalLink className="w-4 h-4" />
                                        {t('documentation')}
                                    </a>
                                )}
                            </div>
                        )}
                    </div>

                    <Button
                        variant={plugin.enabled ? 'ghost' : 'primary'}
                        onClick={handleToggle}
                        disabled={isPending}
                        loading={isPending}
                        className={cn(
                            plugin.enabled && 'text-danger hover:text-danger hover:bg-danger/10',
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
                </div>
            </div>

            {/* Settings Form */}
            {hasSettings ? (
                <div className="bg-surface dark:bg-surface-dark rounded-lg border border-border dark:border-border-dark p-6">
                    <h3 className="text-lg font-medium text-text dark:text-text-dark mb-4">
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
                            />
                        ))}
                    </div>

                    <div className="flex items-center gap-3 mt-6 pt-4 border-t border-border dark:border-border-dark">
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
                <div className="bg-surface dark:bg-surface-dark rounded-lg border border-border dark:border-border-dark p-6 text-center">
                    <p className="text-text-muted dark:text-text-muted-dark">{t('noSettings')}</p>
                </div>
            )}
        </div>
    );
}
