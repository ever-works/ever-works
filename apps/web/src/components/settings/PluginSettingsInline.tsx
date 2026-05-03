'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { UserPlugin } from '@/lib/api/plugins';
import { OAuthConnectionInfo } from '@/lib/api/plugins-capabilities/oauth';
import type { PluginDeviceAuthStatus } from '@/lib/api/plugins-capabilities/device-auth';
import { Button } from '@/components/ui/button';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Save, Check, AlertCircle } from 'lucide-react';
import { updatePluginSettings } from '@/app/actions/plugins';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import { PluginSettingsField } from '@/components/plugins/form/PluginSettingsField';
import { GitHubOrganizationsSettings } from '@/components/settings/GitHubOrganizationsSettings';
import { PluginDeviceAuthConnection } from '@/components/settings/PluginDeviceAuthConnection';
import { PluginOAuthConnection } from '@/components/settings/PluginOAuthConnection';
import { getCapabilityLabel } from '@/lib/utils/plugin-category-icons';
import { usePluginSettings } from '@/lib/hooks/use-plugin-settings';
import { usePluginToggle } from '@/lib/hooks/use-plugin-toggle';

interface PluginSettingsInlineProps {
    plugin: UserPlugin;
    oauthConnection?: OAuthConnectionInfo | null;
    deviceAuthStatus?: PluginDeviceAuthStatus | null;
    defaultExpanded?: boolean;
}

export function PluginSettingsInline({
    plugin,
    oauthConnection,
    deviceAuthStatus,
    defaultExpanded = false,
}: PluginSettingsInlineProps) {
    const t = useTranslations('dashboard.plugins');
    const tOnboarding = useTranslations('onboarding.plugins');
    const byokTrigger = plugin.uiHints?.byok?.triggerField;
    const displaySettings = plugin.resolvedSettings || plugin.settings || {};
    const [byokRevealed, setByokRevealed] = useState(
        !plugin.uiHints?.byok || Boolean(byokTrigger && displaySettings[byokTrigger]),
    );

    const hasOAuth = plugin.capabilities.includes('oauth') && oauthConnection !== undefined;
    const hasDeviceAuth =
        plugin.capabilities.includes('device-auth') && deviceAuthStatus !== undefined;
    const deviceAuthModeField = plugin.uiHints?.deviceAuth?.authModeField ?? 'authMode';
    const { isPending, optimisticEnabled } = usePluginToggle({
        pluginId: plugin.pluginId,
        enabled: plugin.enabled,
        visibility: plugin.visibility,
    });
    const saveBlockedByEnableState = !optimisticEnabled || isPending;

    const onSave = useCallback(
        async (data: {
            settings?: Record<string, unknown>;
            secretSettings?: Record<string, unknown>;
        }) => {
            const result = await updatePluginSettings(plugin.pluginId, data);
            if (!result.success) {
                throw new Error(result.error);
            }

            const validation = (result.data as Record<string, unknown>)?.validation as
                | { success: boolean; message: string }
                | null
                | undefined;

            if (validation && !validation.success) {
                return { validationError: validation.message };
            }
            if (validation?.success) {
                return { validationSuccess: validation.message };
            }
        },
        [plugin.pluginId],
    );

    const {
        hasChanges,
        isSaving,
        saveSuccess,
        saveMessage,
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
        fallbackSettings: plugin.resolvedSettings,
        scope: 'user',
    });

    const filteredVisibleProperties = useMemo(() => {
        if (!plugin.uiHints?.byok || byokRevealed) {
            return visibleProperties;
        }
        return {};
    }, [plugin.uiHints?.byok, byokRevealed, visibleProperties]);

    const setupLink = plugin.uiHints?.setupLink;
    const showSetupButton =
        setupLink &&
        (!setupLink.showWhenEmpty || setupLink.showWhenEmpty.every((f) => !displaySettings[f]));

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
                    <span
                        className="text-sm font-semibold text-text dark:text-text-dark truncate"
                        title={plugin.name}
                    >
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

                {hasDeviceAuth && (
                    <PluginDeviceAuthConnection
                        pluginId={plugin.pluginId}
                        pluginName={plugin.name}
                        initialStatus={deviceAuthStatus ?? null}
                        onActivate={() =>
                            handleFieldChange(deviceAuthModeField, 'device-auth', false)
                        }
                    />
                )}

                {plugin.uiHints?.organizationSettings && (
                    <GitHubOrganizationsSettings
                        plugin={plugin}
                        connected={Boolean(oauthConnection?.connected)}
                    />
                )}

                {/* Settings Form */}
                {hasSettings ? (
                    <div className="space-y-4">
                        {plugin.uiHints?.byok && !byokRevealed && (
                            <div className="rounded-xl border border-dashed border-border dark:border-border-dark bg-surface-secondary/40 dark:bg-surface-secondary-dark/30 p-4">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    className="mt-3"
                                    onClick={() => setByokRevealed(true)}
                                >
                                    {plugin.uiHints.byok.buttonLabel ??
                                        tOnboarding('byokDefaultButton')}
                                </Button>
                            </div>
                        )}

                        {showSetupButton && (
                            <div className="rounded-xl border border-dashed border-border dark:border-border-dark bg-surface-secondary/40 dark:bg-surface-secondary-dark/30 p-4">
                                <a
                                    href={setupLink!.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    aria-label={setupLink!.label}
                                    className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium bg-button-primary dark:bg-button-primary-dark hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark text-button-primary-foreground dark:text-button-primary-foreground-dark rounded-sm"
                                >
                                    {setupLink!.buttonLabel ?? setupLink!.label}
                                </a>
                            </div>
                        )}

                        <div className="space-y-3">
                            {Object.entries(filteredVisibleProperties).map(([key, propSchema]) => (
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
                                disabled={!hasChanges || isSaving || saveBlockedByEnableState}
                                loading={isSaving}
                            >
                                <Save className="w-3.5 h-3.5 mr-1.5" />
                                {t('saveSettings')}
                            </Button>

                            {saveBlockedByEnableState && (
                                <span className="text-sm text-text-muted dark:text-text-muted-dark">
                                    {t('enableFirstToSave')}
                                </span>
                            )}

                            {saveSuccess && (
                                <span className="inline-flex items-center gap-1 text-sm text-success">
                                    <Check className="w-4 h-4" />
                                    {saveMessage || t('settingsSaved')}
                                </span>
                            )}
                        </div>
                    </div>
                ) : !hasOAuth && !hasDeviceAuth ? (
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
