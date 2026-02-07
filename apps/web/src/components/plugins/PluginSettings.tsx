'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { UserPlugin } from '@/lib/api/plugins';
import type { OAuthConnectionInfo } from '@/lib/api/plugins-capabilities/oauth';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import {
    Power,
    PowerOff,
    Save,
    ArrowLeft,
    ExternalLink,
    Check,
    BookOpen,
    Settings,
} from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { updatePluginSettings } from '@/app/actions/plugins';
import { PluginIcon } from './PluginIcon';
import { PluginSettingsFormFields } from './PluginSettingsFormFields';
import { PluginReadme } from './PluginReadme';
import { PluginEnablePanel } from './PluginEnablePanel';
import { PluginDisableWarning } from './PluginDisableWarning';
import { PluginOAuthConnection } from '@/components/settings/PluginOAuthConnection';
import { getCategoryLabel, getCapabilityLabel } from '@/lib/utils/plugin-category-icons';
import { usePluginSettings } from '@/lib/hooks/use-plugin-settings';
import { usePluginToggle } from '@/lib/hooks/use-plugin-toggle';

interface PluginSettingsProps {
    plugin: UserPlugin;
    oauthConnection?: OAuthConnectionInfo | null;
}

export function PluginSettings({ plugin, oauthConnection }: PluginSettingsProps) {
    const t = useTranslations('dashboard.plugins');

    const onSave = useCallback(
        async (data: {
            settings?: Record<string, unknown>;
            secretSettings?: Record<string, unknown>;
        }) => {
            await updatePluginSettings(plugin.pluginId, data);
        },
        [plugin.pluginId],
    );

    const {
        hasChanges,
        isSaving,
        saveSuccess,
        validationError,
        visibleProperties,
        hasSettings,
        handleFieldChange,
        handleSave,
        getFieldValue,
    } = usePluginSettings({
        schema: plugin.settingsSchema,
        initialSettings: plugin.settings || {},
        scopes: ['global', 'user'],
        onSave,
    });

    const {
        isPending,
        optimisticEnabled,
        showDisableWarning,
        showEnablePanel,
        autoEnableForDirs,
        setAutoEnableForDirs,
        handleToggle,
        handleCancelEnable,
        handleCancelDisable,
    } = usePluginToggle({
        pluginId: plugin.pluginId,
        enabled: plugin.enabled,
        visibility: plugin.visibility,
    });

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
                                        variant={optimisticEnabled ? 'ghost' : 'primary'}
                                        onClick={handleToggle}
                                        disabled={isPending}
                                        loading={isPending}
                                        className={cn(
                                            'shrink-0',
                                            optimisticEnabled &&
                                                'text-danger hover:text-danger hover:bg-danger/10',
                                        )}
                                    >
                                        {optimisticEnabled ? (
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

            {showDisableWarning && (
                <PluginDisableWarning
                    onCancel={handleCancelDisable}
                    onConfirm={handleToggle}
                    isPending={isPending}
                />
            )}

            {showEnablePanel && (
                <PluginEnablePanel
                    autoEnableForDirs={autoEnableForDirs}
                    onAutoEnableChange={setAutoEnableForDirs}
                    onCancel={handleCancelEnable}
                    onConfirm={handleToggle}
                    isPending={isPending}
                />
            )}

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

                    <div className="p-6">
                        <PluginSettingsFormFields
                            visibleProperties={visibleProperties}
                            getFieldValue={getFieldValue}
                            handleFieldChange={handleFieldChange}
                            settingsSchema={plugin.settingsSchema}
                            pluginId={plugin.pluginId}
                            validationError={validationError}
                        />
                    </div>

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
