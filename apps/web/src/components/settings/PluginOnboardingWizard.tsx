'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PluginSettingsField } from '@/components/plugins/form/PluginSettingsField';
import { cn } from '@/lib/utils/cn';
import type {
    PluginLocalAuthStatus,
    PluginSettingsSchemaProperty,
    UserPlugin,
} from '@/lib/api/plugins';
import { getPluginLocalAuthStatus, startPluginLocalAuth } from '@/app/actions/plugins';

interface PluginOnboardingWizardProps {
    plugin: UserPlugin;
    initialSettings: Record<string, unknown>;
    initialLocalAuthStatus?: PluginLocalAuthStatus | null;
    visibleProperties: Record<string, PluginSettingsSchemaProperty>;
    getFieldValue: (key: string, propSchema: PluginSettingsSchemaProperty) => unknown;
    handleFieldChange: (key: string, value: unknown, isSecret: boolean) => void;
    handleSave: () => Promise<void>;
    isSaving: boolean;
    saveSuccess: boolean;
    validationError: string | null;
    saveMessage: string | null;
}

type StepConfig = {
    key: 'configure' | 'credentials' | 'verify';
    title: string;
    description: string;
};

type FieldEntry = [string, PluginSettingsSchemaProperty];

const CREDENTIAL_FIELD_NAMES = new Set(['apiKey', 'oauthToken']);

function StepNavigation({
    steps,
    step,
    onSelect,
    getStepLabel,
}: {
    steps: StepConfig[];
    step: number;
    onSelect: (index: number) => void;
    getStepLabel: (index: number) => string;
}) {
    return (
        <div className={cn('grid gap-3', steps.length >= 3 ? 'md:grid-cols-3' : 'md:grid-cols-2')}>
            {steps.map((item, index) => (
                <button
                    key={item.key}
                    type="button"
                    onClick={() => onSelect(index)}
                    className={cn(
                        'rounded-xl border px-4 py-3 text-left transition-colors',
                        index === step
                            ? 'border-primary bg-primary/8'
                            : 'border-border dark:border-border-dark hover:border-primary/40',
                    )}
                >
                    <div className="text-xs font-medium uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                        {getStepLabel(index + 1)}
                    </div>
                    <div className="mt-1 text-sm font-semibold text-text dark:text-text-dark">
                        {item.title}
                    </div>
                </button>
            ))}
        </div>
    );
}

function SettingsFieldList({
    fields,
    getFieldValue,
    handleFieldChange,
    pluginId,
}: {
    fields: FieldEntry[];
    getFieldValue: PluginOnboardingWizardProps['getFieldValue'];
    handleFieldChange: PluginOnboardingWizardProps['handleFieldChange'];
    pluginId: string;
}) {
    return (
        <div className="space-y-4">
            {fields.map(([key, schema]) => (
                <PluginSettingsField
                    key={key}
                    name={key}
                    schema={schema}
                    value={getFieldValue(key, schema)}
                    onChange={(value) => handleFieldChange(key, value, schema.secret || false)}
                    pluginId={pluginId}
                />
            ))}
        </div>
    );
}

function AuthModeOption({
    selected,
    title,
    description,
    badge,
    onClick,
}: {
    selected: boolean;
    title: string;
    description: string;
    badge?: { label: string; tone: 'success' | 'primary' };
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'rounded-xl border p-4 text-left transition-colors',
                selected
                    ? 'border-primary bg-primary/8'
                    : 'border-border dark:border-border-dark bg-surface dark:bg-surface-dark',
            )}
        >
            <div className="flex items-center justify-between gap-3">
                <div>
                    <p className="text-sm font-semibold text-text dark:text-text-dark">{title}</p>
                    <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                        {description}
                    </p>
                </div>
                {badge ? (
                    <span
                        className={cn(
                            'rounded-full px-2 py-1 text-xs font-medium',
                            badge.tone === 'success'
                                ? 'bg-success/10 text-success'
                                : 'bg-primary/10 text-primary',
                        )}
                    >
                        {badge.label}
                    </span>
                ) : (
                    selected && <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                )}
            </div>
        </button>
    );
}

function LocalAuthStatusPanel({
    localAuthStatus,
    localAuthError,
    isLoadingLocalAuth,
    isStartingLocalAuth,
    onStart,
    onRefresh,
    copy,
}: {
    localAuthStatus: PluginLocalAuthStatus | null;
    localAuthError: string | null;
    isLoadingLocalAuth: boolean;
    isStartingLocalAuth: boolean;
    onStart: () => void;
    onRefresh: () => void;
    copy: {
        title: string;
        fallbackMessage: string;
        machineScoped: string;
        deviceCode: string;
        verificationUrl: string;
        notInstalled: string;
        connected: string;
        start: string;
        restart: string;
        refresh: string;
    };
}) {
    return (
        <div className="rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-4 space-y-4">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {copy.title}
                    </p>
                    <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                        {localAuthStatus?.message || copy.fallbackMessage}
                    </p>
                </div>
                {(isLoadingLocalAuth || isStartingLocalAuth) && (
                    <Loader2 className="w-4 h-4 animate-spin text-text-muted dark:text-text-muted-dark shrink-0" />
                )}
            </div>

            {localAuthStatus?.scope === 'machine-local' && (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {copy.machineScoped}
                </p>
            )}

            {localAuthStatus?.userCode && (
                <div className="rounded-lg bg-surface-secondary/70 dark:bg-surface-secondary-dark/60 px-4 py-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-text-muted dark:text-text-muted-dark">
                        {copy.deviceCode}
                    </p>
                    <p className="mt-2 font-mono text-lg font-semibold text-text dark:text-text-dark">
                        {localAuthStatus.userCode}
                    </p>
                </div>
            )}

            {localAuthStatus?.verificationUri && (
                <div className="rounded-lg bg-surface-secondary/70 dark:bg-surface-secondary-dark/60 px-4 py-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-text-muted dark:text-text-muted-dark">
                        {copy.verificationUrl}
                    </p>
                    <p className="mt-2 text-sm text-text dark:text-text-dark break-all">
                        {localAuthStatus.verificationUri}
                    </p>
                </div>
            )}

            {localAuthError && <p className="text-sm text-danger">{localAuthError}</p>}

            <div className="flex flex-wrap gap-3">
                {!localAuthStatus?.installed ? (
                    <p className="text-sm text-danger">{copy.notInstalled}</p>
                ) : localAuthStatus.connected ? (
                    <span className="inline-flex items-center rounded-lg bg-success/10 px-3 py-2 text-sm font-medium text-success">
                        {copy.connected}
                    </span>
                ) : (
                    <Button type="button" onClick={onStart} loading={isStartingLocalAuth}>
                        {localAuthStatus?.pending ? copy.restart : copy.start}
                    </Button>
                )}

                <Button
                    type="button"
                    variant="secondary"
                    onClick={onRefresh}
                    disabled={isLoadingLocalAuth}
                >
                    {copy.refresh}
                </Button>
            </div>
        </div>
    );
}

function VerifyStepPanel({
    onSave,
    isSaving,
    saveSuccess,
    saveMessage,
    validationError,
    copy,
}: {
    onSave: () => Promise<void>;
    isSaving: boolean;
    saveSuccess: boolean;
    saveMessage: string | null;
    validationError: string | null;
    copy: {
        title: string;
        description: string;
        action: string;
        success: string;
    };
}) {
    return (
        <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-4">
                <ShieldCheck className="mt-0.5 w-5 h-5 text-primary" />
                <div>
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {copy.title}
                    </p>
                    <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                        {copy.description}
                    </p>
                </div>
            </div>

            <Button onClick={onSave} loading={isSaving}>
                {copy.action}
            </Button>

            {saveSuccess && (
                <p className="inline-flex items-center gap-2 text-sm text-success">
                    <CheckCircle2 className="w-4 h-4" />
                    {saveMessage || copy.success}
                </p>
            )}

            {validationError && <p className="text-sm text-danger">{validationError}</p>}
        </div>
    );
}

export function PluginOnboardingWizard({
    plugin,
    initialSettings,
    initialLocalAuthStatus = null,
    visibleProperties,
    getFieldValue,
    handleFieldChange,
    handleSave,
    isSaving,
    saveSuccess,
    validationError,
    saveMessage,
}: PluginOnboardingWizardProps) {
    const tOnboarding = useTranslations('onboarding');
    const tWizard = useTranslations('onboarding.plugins.wizard');
    const [step, setStep] = useState(0);
    const [localAuthStatus, setLocalAuthStatus] = useState<PluginLocalAuthStatus | null>(
        initialLocalAuthStatus,
    );
    const [localAuthError, setLocalAuthError] = useState<string | null>(null);
    const [isLoadingLocalAuth, setIsLoadingLocalAuth] = useState(false);
    const [isStartingLocalAuth, setIsStartingLocalAuth] = useState(false);

    const supportsLocalAuth =
        plugin.capabilities.includes('local-auth') || Boolean(plugin.uiHints?.localAuth);
    const authModeField = plugin.uiHints?.localAuth?.authModeField || 'authMode';
    const configuredAuthMode =
        typeof initialSettings[authModeField] === 'string' ? initialSettings[authModeField] : null;
    const [selectedAuthMode, setSelectedAuthMode] = useState<'api-key' | 'local'>(() => {
        if (configuredAuthMode === 'api-key' || configuredAuthMode === 'local') {
            return configuredAuthMode;
        }

        return supportsLocalAuth && initialLocalAuthStatus?.connected ? 'local' : 'api-key';
    });
    const initializedAuthMode = useRef(false);

    useEffect(() => {
        if (!supportsLocalAuth || initializedAuthMode.current) {
            return;
        }

        if (configuredAuthMode !== 'api-key' && configuredAuthMode !== 'local') {
            handleFieldChange(authModeField, selectedAuthMode, false);
        }

        initializedAuthMode.current = true;
    }, [authModeField, configuredAuthMode, handleFieldChange, selectedAuthMode, supportsLocalAuth]);

    const refreshLocalAuthStatus = useCallback(async () => {
        setIsLoadingLocalAuth(true);
        setLocalAuthError(null);

        try {
            const status = await getPluginLocalAuthStatus(plugin.pluginId);
            if (!status.success || !status.data) {
                setLocalAuthError(status.error || tWizard('errors.loadStatus'));
                return;
            }

            setLocalAuthStatus(status.data);
        } finally {
            setIsLoadingLocalAuth(false);
        }
    }, [plugin.pluginId, tWizard]);

    useEffect(() => {
        if (!localAuthStatus?.pending) {
            return;
        }

        const timer = window.setInterval(() => {
            void refreshLocalAuthStatus();
        }, 2000);

        return () => window.clearInterval(timer);
    }, [localAuthStatus?.pending, refreshLocalAuthStatus]);

    const orderedFields = useMemo(() => Object.entries(visibleProperties), [visibleProperties]);
    const configurationFields = orderedFields.filter(([key, schema]) => {
        if (key === authModeField) {
            return false;
        }

        return !CREDENTIAL_FIELD_NAMES.has(key) && schema.secret !== true;
    });
    const credentialFields = orderedFields.filter(([key, schema]) => {
        if (key === authModeField) {
            return false;
        }

        return CREDENTIAL_FIELD_NAMES.has(key) || schema.secret === true;
    });

    const apiKeyField = credentialFields.find(([key]) => key === 'apiKey');
    const additionalCredentialFields = credentialFields.filter(([key]) => key !== 'apiKey');

    const steps = useMemo<StepConfig[]>(() => {
        const result: StepConfig[] = [];

        if (configurationFields.length > 0) {
            result.push({
                key: 'configure',
                title: tWizard('steps.configure.title'),
                description:
                    plugin.uiHints?.onboardingDescription ||
                    tWizard('steps.configure.description', { pluginName: plugin.name }),
            });
        }

        if (supportsLocalAuth || credentialFields.length > 0) {
            result.push({
                key: 'credentials',
                title: tWizard('steps.credentials.title'),
                description: tWizard('steps.credentials.description', { pluginName: plugin.name }),
            });
        }

        result.push({
            key: 'verify',
            title: tWizard('steps.verify.title'),
            description: tWizard('steps.verify.description'),
        });

        return result;
    }, [
        configurationFields.length,
        credentialFields.length,
        plugin.name,
        plugin.uiHints?.onboardingDescription,
        supportsLocalAuth,
        tWizard,
    ]);

    const currentStep = steps[step];

    const setAuthMode = (mode: 'api-key' | 'local') => {
        setSelectedAuthMode(mode);
        handleFieldChange(authModeField, mode, false);
    };

    const handleStartLocalAuth = async () => {
        setIsStartingLocalAuth(true);
        setLocalAuthError(null);

        try {
            const result = await startPluginLocalAuth(plugin.pluginId);
            if (!result.success || !result.data) {
                setLocalAuthError(result.error || tWizard('errors.start'));
                return;
            }

            setLocalAuthStatus(result.data);
            setAuthMode('local');

            if (result.data.verificationUri) {
                window.open(result.data.verificationUri, '_blank', 'noopener,noreferrer');
            }
        } finally {
            setIsStartingLocalAuth(false);
        }
    };

    const setupStatusLabel = localAuthStatus?.connected
        ? tWizard('localAuth.badges.connected')
        : localAuthStatus?.pending
          ? tWizard('localAuth.badges.pending')
          : selectedAuthMode === 'local'
            ? tWizard('authModes.local.title')
            : tWizard('authModes.apiKey.title');

    return (
        <div className="rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-6 space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <p className="text-sm font-medium text-text-muted dark:text-text-muted-dark">
                        {tWizard('setupLabel')}
                    </p>
                    <h2 className="mt-1 text-lg font-semibold text-text dark:text-text-dark">
                        {plugin.name}
                    </h2>
                    <p className="mt-2 text-sm text-text-muted dark:text-text-muted-dark">
                        {plugin.uiHints?.onboardingDescription || plugin.description}
                    </p>
                </div>
                <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                    {setupStatusLabel}
                </span>
            </div>

            <StepNavigation
                steps={steps}
                step={step}
                onSelect={setStep}
                getStepLabel={(index) => tOnboarding('stepIndex', { index })}
            />

            <div className="rounded-xl border border-border dark:border-border-dark p-5 space-y-4">
                <div>
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {currentStep.title}
                    </p>
                    <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                        {currentStep.description}
                    </p>
                </div>

                {currentStep.key === 'configure' && (
                    <SettingsFieldList
                        fields={configurationFields}
                        getFieldValue={getFieldValue}
                        handleFieldChange={handleFieldChange}
                        pluginId={plugin.pluginId}
                    />
                )}

                {currentStep.key === 'credentials' && (
                    <div className="space-y-4">
                        {supportsLocalAuth && (
                            <div className="space-y-4">
                                <div className="grid gap-4 md:grid-cols-2">
                                    {apiKeyField && (
                                        <AuthModeOption
                                            selected={selectedAuthMode === 'api-key'}
                                            title={tWizard('authModes.apiKey.title')}
                                            description={tWizard('authModes.apiKey.description')}
                                            onClick={() => setAuthMode('api-key')}
                                        />
                                    )}

                                    <AuthModeOption
                                        selected={selectedAuthMode === 'local'}
                                        title={tWizard('authModes.local.title')}
                                        description={tWizard('authModes.local.description')}
                                        badge={
                                            localAuthStatus?.connected
                                                ? {
                                                      label: tWizard('localAuth.badges.connected'),
                                                      tone: 'success',
                                                  }
                                                : localAuthStatus?.pending
                                                  ? {
                                                        label: tWizard('localAuth.badges.pending'),
                                                        tone: 'primary',
                                                    }
                                                  : undefined
                                        }
                                        onClick={() => setAuthMode('local')}
                                    />
                                </div>

                                {selectedAuthMode === 'api-key' && apiKeyField && (
                                    <PluginSettingsField
                                        name={apiKeyField[0]}
                                        schema={apiKeyField[1]}
                                        value={getFieldValue(apiKeyField[0], apiKeyField[1])}
                                        onChange={(value) =>
                                            handleFieldChange(
                                                apiKeyField[0],
                                                value,
                                                apiKeyField[1].secret || true,
                                            )
                                        }
                                        pluginId={plugin.pluginId}
                                    />
                                )}

                                {selectedAuthMode === 'local' && (
                                    <LocalAuthStatusPanel
                                        localAuthStatus={localAuthStatus}
                                        localAuthError={localAuthError}
                                        isLoadingLocalAuth={isLoadingLocalAuth}
                                        isStartingLocalAuth={isStartingLocalAuth}
                                        onStart={() => void handleStartLocalAuth()}
                                        onRefresh={() => void refreshLocalAuthStatus()}
                                        copy={{
                                            title: tWizard('localAuth.status.title'),
                                            fallbackMessage: tWizard('localAuth.status.fallback'),
                                            machineScoped: tWizard(
                                                'localAuth.status.machineScoped',
                                            ),
                                            deviceCode: tWizard('localAuth.status.deviceCode'),
                                            verificationUrl: tWizard(
                                                'localAuth.status.verificationUrl',
                                            ),
                                            notInstalled: tWizard('localAuth.actions.notInstalled'),
                                            connected: tWizard('localAuth.actions.connected'),
                                            start: tWizard('localAuth.actions.start'),
                                            restart: tWizard('localAuth.actions.restart'),
                                            refresh: tWizard('localAuth.actions.refresh'),
                                        }}
                                    />
                                )}
                            </div>
                        )}

                        {!supportsLocalAuth &&
                            credentialFields.map(([key, schema]) => (
                                <PluginSettingsField
                                    key={key}
                                    name={key}
                                    schema={schema}
                                    value={getFieldValue(key, schema)}
                                    onChange={(value) =>
                                        handleFieldChange(key, value, schema.secret || true)
                                    }
                                    pluginId={plugin.pluginId}
                                />
                            ))}

                        {additionalCredentialFields.map(([key, schema]) => (
                            <PluginSettingsField
                                key={key}
                                name={key}
                                schema={schema}
                                value={getFieldValue(key, schema)}
                                onChange={(value) =>
                                    handleFieldChange(key, value, schema.secret || true)
                                }
                                pluginId={plugin.pluginId}
                            />
                        ))}
                    </div>
                )}

                {currentStep.key === 'verify' && (
                    <VerifyStepPanel
                        onSave={handleSave}
                        isSaving={isSaving}
                        saveSuccess={saveSuccess}
                        saveMessage={saveMessage}
                        validationError={validationError}
                        copy={{
                            title: tWizard('steps.verify.cardTitle'),
                            description: tWizard('steps.verify.cardDescription'),
                            action: tWizard('steps.verify.action'),
                            success: tWizard('steps.verify.successDefault'),
                        }}
                    />
                )}

                {step < steps.length - 1 && (
                    <div className="flex justify-end">
                        <Button
                            variant="secondary"
                            onClick={() => setStep((current) => current + 1)}
                        >
                            {tWizard('continue')}
                            <ArrowRight className="w-4 h-4" />
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
}
