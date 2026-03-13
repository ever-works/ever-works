'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Save, CheckCircle2, AlertCircle } from 'lucide-react';
import type { UserPlugin } from '@/lib/api/plugins';
import type { OAuthConnectionInfo } from '@/lib/api/plugins-capabilities/oauth';
import { updatePluginSettings, validatePluginConnection } from '@/app/actions/plugins';
import { PluginOAuthConnection } from '@/components/settings/PluginOAuthConnection';
import { PluginSettingsFormFields } from '@/components/plugins/PluginSettingsFormFields';
import { Button } from '@/components/ui/button';
import { usePluginSettings } from '@/lib/hooks/use-plugin-settings';
import { ROUTES } from '@/lib/constants';

interface OnboardingPluginStepProps {
    plugin: UserPlugin;
    oauthConnection?: OAuthConnectionInfo | null;
    returnPath?: string;
}

function FieldBasedPluginStep({ plugin }: { plugin: UserPlugin }) {
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
            if (plugin.uiHints?.validateOnSave) {
                const validation = await validatePluginConnection(plugin.pluginId);
                if (!validation.success) {
                    return { validationError: validation.error };
                }
                return { validationSuccess: validation.data?.message };
            }
        },
        [plugin.pluginId, plugin.uiHints?.validateOnSave],
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
        scope: 'user',
    });

    const setupLink = plugin.uiHints?.setupLink;
    const showSetupButton =
        setupLink &&
        (!setupLink.showWhenEmpty || setupLink.showWhenEmpty.every((f) => !plugin.settings?.[f]));

    if (!hasSettings) {
        return (
            <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('noSettings')}</p>
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
    oauthConnection,
    returnPath,
}: OnboardingPluginStepProps) {
    const isOAuth = plugin.capabilities.includes('oauth');

    if (isOAuth && oauthConnection !== undefined) {
        return (
            <PluginOAuthConnection
                pluginId={plugin.pluginId}
                pluginName={plugin.name}
                connection={oauthConnection}
                returnPath={returnPath ?? ROUTES.DASHBOARD}
            />
        );
    }

    return <FieldBasedPluginStep plugin={plugin} />;
}
