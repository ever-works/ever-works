'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Save, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import type { UserPlugin } from '@/lib/api/plugins';
import type { OAuthConnectionInfo } from '@/lib/api/plugins-capabilities/oauth';
import type { GitProviderConnectionInfo } from '@/lib/api/plugins-capabilities/git-providers';
import type { PluginDeviceAuthStatus } from '@/lib/api/plugins-capabilities/device-auth';
import { updatePluginSettings } from '@/app/actions/plugins';
import { PluginOAuthConnection } from '@/components/settings/PluginOAuthConnection';
import { PluginOnboardingWizard } from '@/components/settings/PluginOnboardingWizard';
import { PluginSettingsFormFields } from '@/components/plugins/PluginSettingsFormFields';
import { Button } from '@/components/ui/button';
import { usePluginSettings } from '@/lib/hooks/use-plugin-settings';
import { ROUTES } from '@/lib/constants';

interface OnboardingPluginStepProps {
    plugin: UserPlugin;
    connection?: OAuthConnectionInfo | GitProviderConnectionInfo | null;
    deviceAuthStatus?: PluginDeviceAuthStatus | null;
    isStatusLoading?: boolean;
    returnPath?: string;
}

function OnboardingStatusLoading() {
    const t = useTranslations('onboarding.pluginStep');

    return (
        <div className="rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-4">
            <div className="flex items-center gap-3 text-sm text-text-muted dark:text-text-muted-dark">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{t('loadingStatus')}</span>
            </div>
        </div>
    );
}

function FieldBasedPluginStep({
    plugin,
    deviceAuthStatus,
}: {
    plugin: UserPlugin;
    deviceAuthStatus?: PluginDeviceAuthStatus | null;
}) {
    const t = useTranslations('onboarding.pluginStep');

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

    const displaySettings = plugin.resolvedSettings || plugin.settings || {};
    const setupLink = plugin.uiHints?.setupLink;
    const showsOnboardingWizard = Boolean(plugin.uiHints?.onboardingWizard);
    const showSetupButton =
        setupLink &&
        (!setupLink.showWhenEmpty || setupLink.showWhenEmpty.every((f) => !displaySettings[f]));

    if (!hasSettings) {
        return (
            <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('noSettings')}</p>
        );
    }

    if (showsOnboardingWizard) {
        return (
            <PluginOnboardingWizard
                plugin={plugin}
                initialSettings={plugin.settings || {}}
                initialDeviceAuthStatus={deviceAuthStatus ?? null}
                visibleProperties={visibleProperties}
                getFieldValue={getFieldValue}
                handleFieldChange={handleFieldChange}
                handleSave={handleSave}
                isSaving={isSaving}
                saveSuccess={saveSuccess}
                validationError={validationError}
                saveMessage={saveMessage}
            />
        );
    }

    return (
        <div className="space-y-4">
            {showSetupButton && (
                <div className="rounded-xl border border-dashed border-border dark:border-border-dark bg-surface-secondary/40 dark:bg-surface-secondary-dark/30 p-4">
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('getTokenPrompt')}
                    </p>
                    <a
                        href={setupLink!.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-3 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
                    >
                        {setupLink!.buttonLabel ?? setupLink!.label}
                    </a>
                </div>
            )}

            <PluginSettingsFormFields
                visibleProperties={visibleProperties}
                getFieldValue={getFieldValue}
                handleFieldChange={handleFieldChange}
                settingsSchema={plugin.settingsSchema}
                pluginId={plugin.pluginId}
                validationError={validationError}
            />

            <div className="flex items-center gap-3 pt-2">
                <Button onClick={handleSave} loading={isSaving} size="sm">
                    <Save className="w-4 h-4 mr-1.5" />
                    {t('saveButton')}
                </Button>

                {saveSuccess && (
                    <span className="inline-flex items-center gap-1.5 text-sm text-success">
                        <CheckCircle2 className="w-4 h-4" />
                        {saveMessage || t('savedSuccess')}
                    </span>
                )}

                {validationError && !saveSuccess && (
                    <span className="inline-flex items-center gap-1.5 text-sm text-danger">
                        <AlertCircle className="w-4 h-4" />
                        {validationError}
                    </span>
                )}
            </div>
        </div>
    );
}

export function OnboardingPluginStep({
    plugin,
    connection,
    deviceAuthStatus,
    isStatusLoading = false,
    returnPath,
}: OnboardingPluginStepProps) {
    const isOAuth = plugin.capabilities.includes('oauth');
    const isGitProvider = plugin.capabilities.includes('git-provider');
    const needsRemoteStatus =
        isOAuth || isGitProvider || plugin.capabilities.includes('device-auth');

    if (isStatusLoading && needsRemoteStatus && !connection && !deviceAuthStatus) {
        return <OnboardingStatusLoading />;
    }

    if (isOAuth && connection !== undefined) {
        return (
            <PluginOAuthConnection
                pluginId={plugin.pluginId}
                pluginName={plugin.name}
                connection={connection}
                returnPath={returnPath ?? ROUTES.DASHBOARD}
                allowDisconnect={!isGitProvider}
            />
        );
    }

    return <FieldBasedPluginStep plugin={plugin} deviceAuthStatus={deviceAuthStatus} />;
}
