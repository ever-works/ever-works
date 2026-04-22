'use client';

import type { ComponentType } from 'react';
import { useCallback, useMemo, useState } from 'react';
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
import { ClaudeCodeOnboardingWizard } from '@/components/settings/ClaudeCodeOnboardingWizard';
import { GeminiOnboardingWizard } from '@/components/settings/GeminiOnboardingWizard';
import { GitHubOrganizationsSettings } from '@/components/settings/GitHubOrganizationsSettings';
import { SimAiOnboardingWizard } from '@/components/settings/SimAiOnboardingWizard';
import { getCategoryLabel, getCapabilityLabel } from '@/lib/utils/plugin-category-icons';
import { usePluginSettings } from '@/lib/hooks/use-plugin-settings';
import { usePluginToggle } from '@/lib/hooks/use-plugin-toggle';
import type { PluginSettingsSchemaProperty } from '@/lib/api/plugins';

type OnboardingWizardProps = {
    pluginId: string;
    visibleProperties: Record<string, PluginSettingsSchemaProperty>;
    getFieldValue: (key: string, propSchema: PluginSettingsSchemaProperty) => unknown;
    handleFieldChange: (key: string, value: unknown, isSecret: boolean) => void;
    handleSave: () => Promise<void>;
    isSaving: boolean;
    saveSuccess: boolean;
    validationError: string | null;
    saveMessage: string | null;
};

const WIZARD_COMPONENT_BY_PLUGIN_ID: Record<
    string,
    ComponentType<OnboardingWizardProps> | undefined
> = {
    'claude-code': ClaudeCodeOnboardingWizard,
    gemini: GeminiOnboardingWizard,
    'sim-ai': SimAiOnboardingWizard,
};

interface PluginSettingsProps {
    plugin: UserPlugin;
    oauthConnection?: OAuthConnectionInfo | null;
}

export function PluginSettings({ plugin, oauthConnection }: PluginSettingsProps) {
    const t = useTranslations('dashboard.plugins');
    const tOnboarding = useTranslations('onboarding.plugins');
    const byokTrigger = plugin.uiHints?.byok?.triggerField;
    const displaySettings = plugin.resolvedSettings || plugin.settings || {};
    const [byokRevealed, setByokRevealed] = useState(
        !plugin.uiHints?.byok || Boolean(byokTrigger && displaySettings[byokTrigger]),
    );

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
    const OnboardingWizard = plugin.uiHints?.onboardingWizard
        ? WIZARD_COMPONENT_BY_PLUGIN_ID[plugin.pluginId]
        : undefined;
    const usesCustomWizard = Boolean(OnboardingWizard);

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
                                        <h1
                                            className="text-xl font-semibold text-text dark:text-text-dark truncate"
                                            title={plugin.name}
                                        >
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
                                        size="sm"
                                        disabled={isPending}
                                        loading={isPending}
                                        className={cn(
                                            'shrink-0 gap-2',
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
                            <div className="flex flex-wrap gap-1.5 my-2">
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

            <PluginDisableWarning
                open={showDisableWarning}
                onCancel={handleCancelDisable}
                onConfirm={handleToggle}
                isPending={isPending}
            />

            <PluginEnablePanel
                open={showEnablePanel}
                autoEnableForDirs={autoEnableForDirs}
                onAutoEnableChange={setAutoEnableForDirs}
                onCancel={handleCancelEnable}
                onConfirm={handleToggle}
                isPending={isPending}
            />

            {/* OAuth Connection Section */}
            {plugin.capabilities.includes('oauth') && oauthConnection !== undefined && (
                <PluginOAuthConnection
                    pluginId={plugin.pluginId}
                    pluginName={plugin.name}
                    connection={oauthConnection}
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
                <div className="bg-surface dark:bg-surface-dark rounded-xl border border-border dark:border-border-dark">
                    <div className="flex items-center gap-2 px-6 py-3 border-b border-border dark:border-border-dark">
                        <Settings className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                        <h2 className="text-sm font-medium text-text dark:text-text-dark">
                            {t('settingsTitle')}
                        </h2>
                    </div>

                    <div className="p-6">
                        {usesCustomWizard ? (
                            OnboardingWizard ? (
                                <OnboardingWizard
                                    pluginId={plugin.pluginId}
                                    visibleProperties={visibleProperties}
                                    getFieldValue={getFieldValue}
                                    handleFieldChange={handleFieldChange}
                                    handleSave={handleSave}
                                    isSaving={isSaving}
                                    saveSuccess={saveSuccess}
                                    validationError={validationError}
                                    saveMessage={saveMessage}
                                />
                            ) : null
                        ) : (
                            <div className="space-y-5">
                                {plugin.uiHints?.byok && !byokRevealed && (
                                    <div className="rounded-xl border border-dashed border-border dark:border-border-dark bg-surface-secondary/40 dark:bg-surface-secondary-dark/30 p-4">
                                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                            {tOnboarding('byokDescription')}
                                        </p>
                                        <Button
                                            variant="secondary"
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
                                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                            {tOnboarding('setupTokenDescription')}
                                        </p>
                                        <a
                                            href={setupLink!.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="mt-3 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
                                        >
                                            {setupLink!.buttonLabel ?? setupLink!.label}
                                            <ExternalLink className="w-4 h-4" />
                                        </a>
                                    </div>
                                )}

                                {setupLink && (
                                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                        <a
                                            href={setupLink.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            aria-label={setupLink.label}
                                            className="text-primary hover:text-primary-hover underline"
                                        >
                                            {setupLink.url}
                                        </a>
                                    </p>
                                )}

                                <PluginSettingsFormFields
                                    visibleProperties={filteredVisibleProperties}
                                    getFieldValue={getFieldValue}
                                    handleFieldChange={handleFieldChange}
                                    settingsSchema={plugin.settingsSchema}
                                    pluginId={plugin.pluginId}
                                    validationError={validationError}
                                />
                            </div>
                        )}
                    </div>

                    {!usesCustomWizard && (
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
                                    {saveMessage || t('settingsSaved')}
                                </span>
                            )}
                        </div>
                    )}
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
                    <div className="py-10 pl-12 pr-24">
                        <PluginReadme content={plugin.readme} />
                    </div>
                </div>
            )}
        </div>
    );
}
