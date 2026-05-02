'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PluginSettingsField } from '@/components/plugins/form/PluginSettingsField';
import { cn } from '@/lib/utils/cn';
import type { PluginSettingsSchemaProperty, UserPlugin } from '@/lib/api/plugins';
import type { PluginDeviceAuthStatus } from '@/lib/api/plugins-capabilities/device-auth';
import { usePluginDeviceAuth } from '@/lib/hooks/use-plugin-device-auth';

interface PluginOnboardingWizardProps {
    plugin: UserPlugin;
    initialSettings: Record<string, unknown>;
    initialDeviceAuthStatus?: PluginDeviceAuthStatus | null;
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

function fieldMatchesCondition(
    schema: PluginSettingsSchemaProperty,
    visibleProperties: Record<string, PluginSettingsSchemaProperty>,
    getFieldValue: PluginOnboardingWizardProps['getFieldValue'],
) {
    if (!schema.showIf) {
        return true;
    }

    const dependencySchema = visibleProperties[schema.showIf.field];
    if (!dependencySchema) {
        return false;
    }

    const dependencyValue = getFieldValue(schema.showIf.field, dependencySchema);
    return dependencyValue === schema.showIf.value;
}

function isAuthModeDependentField(
    key: string,
    schema: PluginSettingsSchemaProperty,
    authModeField: string,
) {
    if (key === authModeField) {
        return true;
    }

    return schema.showIf?.field === authModeField;
}

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

function DeviceAuthStatusPanel({
    deviceAuthStatus,
    deviceAuthError,
    isLoadingDeviceAuth,
    isStartingDeviceAuth,
    onStart,
    onRefresh,
    copy,
}: {
    deviceAuthStatus: PluginDeviceAuthStatus | null;
    deviceAuthError: string | null;
    isLoadingDeviceAuth: boolean;
    isStartingDeviceAuth: boolean;
    onStart: () => void;
    onRefresh: () => void;
    copy: {
        title: string;
        fallbackMessage: string;
        backendHint: string;
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
                        {deviceAuthStatus?.message || copy.fallbackMessage}
                    </p>
                </div>
                {(isLoadingDeviceAuth || isStartingDeviceAuth) && (
                    <Loader2 className="w-4 h-4 animate-spin text-text-muted dark:text-text-muted-dark shrink-0" />
                )}
            </div>

            {deviceAuthStatus && (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {copy.backendHint}
                </p>
            )}

            {deviceAuthStatus?.prompt?.userCode && (
                <div className="rounded-lg bg-surface-secondary/70 dark:bg-surface-secondary-dark/60 px-4 py-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-text-muted dark:text-text-muted-dark">
                        {copy.deviceCode}
                    </p>
                    <p className="mt-2 font-mono text-lg font-semibold text-text dark:text-text-dark">
                        {deviceAuthStatus.prompt.userCode}
                    </p>
                </div>
            )}

            {deviceAuthStatus?.prompt?.verificationUri && (
                <div className="rounded-lg bg-surface-secondary/70 dark:bg-surface-secondary-dark/60 px-4 py-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-text-muted dark:text-text-muted-dark">
                        {copy.verificationUrl}
                    </p>
                    <p className="mt-2 text-sm text-text dark:text-text-dark break-all">
                        {deviceAuthStatus.prompt.verificationUri}
                    </p>
                </div>
            )}

            {deviceAuthError && <p className="text-sm text-danger">{deviceAuthError}</p>}

            <div className="flex flex-wrap gap-3">
                {!deviceAuthStatus?.installed ? (
                    <p className="text-sm text-danger">{copy.notInstalled}</p>
                ) : deviceAuthStatus.connected ? (
                    <span className="inline-flex items-center rounded-lg bg-success/10 px-3 py-2 text-sm font-medium text-success">
                        {copy.connected}
                    </span>
                ) : (
                    <Button type="button" onClick={onStart} loading={isStartingDeviceAuth}>
                        {deviceAuthStatus?.pending ? copy.restart : copy.start}
                    </Button>
                )}

                <Button
                    type="button"
                    variant="secondary"
                    onClick={onRefresh}
                    disabled={isLoadingDeviceAuth}
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
    initialDeviceAuthStatus = null,
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
    const supportsDeviceAuth = plugin.capabilities.includes('device-auth');
    const authModeField = plugin.uiHints?.deviceAuth?.authModeField || 'authMode';
    const configuredAuthMode =
        typeof initialSettings[authModeField] === 'string' ? initialSettings[authModeField] : null;
    const [selectedAuthMode, setSelectedAuthMode] = useState<'api-key' | 'device-auth'>(() => {
        if (configuredAuthMode === 'api-key' || configuredAuthMode === 'device-auth') {
            return configuredAuthMode;
        }

        return supportsDeviceAuth && initialDeviceAuthStatus?.connected ? 'device-auth' : 'api-key';
    });
    const initializedAuthMode = useRef(false);
    const activateDeviceAuth = useCallback(() => {
        handleFieldChange(authModeField, 'device-auth', false);
        setSelectedAuthMode('device-auth');
    }, [authModeField, handleFieldChange]);

    const {
        status: deviceAuthStatus,
        error: deviceAuthError,
        isLoading: isLoadingDeviceAuth,
        isStarting: isStartingDeviceAuth,
        refresh: refreshDeviceAuthStatus,
        start: startDeviceAuth,
    } = usePluginDeviceAuth({
        pluginId: plugin.pluginId,
        initialStatus: initialDeviceAuthStatus,
        loadErrorMessage: tWizard('errors.loadStatus'),
        startErrorMessage: tWizard('errors.start'),
        onActivate: activateDeviceAuth,
    });

    useEffect(() => {
        if (!supportsDeviceAuth || initializedAuthMode.current) {
            return;
        }

        if (configuredAuthMode !== 'api-key' && configuredAuthMode !== 'device-auth') {
            handleFieldChange(authModeField, selectedAuthMode, false);
        }

        initializedAuthMode.current = true;
    }, [
        authModeField,
        configuredAuthMode,
        handleFieldChange,
        selectedAuthMode,
        supportsDeviceAuth,
    ]);

    const orderedFields = useMemo(() => Object.entries(visibleProperties), [visibleProperties]);
    const activeFields = orderedFields.filter(([, schema]) =>
        fieldMatchesCondition(schema, visibleProperties, getFieldValue),
    );

    const authModeSchema =
        !supportsDeviceAuth && authModeField in visibleProperties
            ? visibleProperties[authModeField]
            : undefined;

    const configurationFields = activeFields.filter(([key, schema]) => {
        if (isAuthModeDependentField(key, schema, authModeField)) {
            return false;
        }

        return !CREDENTIAL_FIELD_NAMES.has(key) && schema.secret !== true;
    });
    const credentialFields = activeFields.filter(([key, schema]) => {
        if (key === authModeField) {
            return false;
        }

        return (
            CREDENTIAL_FIELD_NAMES.has(key) ||
            schema.secret === true ||
            isAuthModeDependentField(key, schema, authModeField)
        );
    });

    const apiKeyField = credentialFields.find(([key]) => key === 'apiKey');
    const additionalCredentialFields = credentialFields.filter(([key]) => key !== 'apiKey');

    const steps: StepConfig[] = (() => {
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

        if (supportsDeviceAuth || authModeSchema || credentialFields.length > 0) {
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
    })();

    const currentStep = steps[step];

    const setAuthMode = (mode: 'api-key' | 'device-auth') => {
        setSelectedAuthMode(mode);
        handleFieldChange(authModeField, mode, false);
    };

    const currentAuthModeValue =
        authModeSchema && typeof getFieldValue(authModeField, authModeSchema) === 'string'
            ? (getFieldValue(authModeField, authModeSchema) as string)
            : configuredAuthMode;
    const setupStatusLabel = supportsDeviceAuth
        ? deviceAuthStatus?.connected
            ? tWizard('deviceAuth.badges.connected')
            : deviceAuthStatus?.pending
              ? tWizard('deviceAuth.badges.pending')
              : selectedAuthMode === 'device-auth'
                ? tWizard('authModes.deviceAuth.title')
                : tWizard('authModes.apiKey.title')
        : typeof currentAuthModeValue === 'string' && currentAuthModeValue.length > 0
          ? currentAuthModeValue
          : tWizard('steps.credentials.title');

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
                        {supportsDeviceAuth && (
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
                                        selected={selectedAuthMode === 'device-auth'}
                                        title={tWizard('authModes.deviceAuth.title')}
                                        description={tWizard('authModes.deviceAuth.description')}
                                        badge={
                                            deviceAuthStatus?.connected
                                                ? {
                                                      label: tWizard('deviceAuth.badges.connected'),
                                                      tone: 'success',
                                                  }
                                                : deviceAuthStatus?.pending
                                                  ? {
                                                        label: tWizard('deviceAuth.badges.pending'),
                                                        tone: 'primary',
                                                    }
                                                  : undefined
                                        }
                                        onClick={() => setAuthMode('device-auth')}
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

                                {selectedAuthMode === 'device-auth' && (
                                    <DeviceAuthStatusPanel
                                        deviceAuthStatus={deviceAuthStatus}
                                        deviceAuthError={deviceAuthError}
                                        isLoadingDeviceAuth={isLoadingDeviceAuth}
                                        isStartingDeviceAuth={isStartingDeviceAuth}
                                        onStart={() => void startDeviceAuth()}
                                        onRefresh={() => void refreshDeviceAuthStatus()}
                                        copy={{
                                            title: tWizard('deviceAuth.status.title'),
                                            fallbackMessage: tWizard('deviceAuth.status.fallback'),
                                            backendHint: tWizard('deviceAuth.status.backendHint'),
                                            deviceCode: tWizard('deviceAuth.status.deviceCode'),
                                            verificationUrl: tWizard(
                                                'deviceAuth.status.verificationUrl',
                                            ),
                                            notInstalled: tWizard(
                                                'deviceAuth.actions.notInstalled',
                                            ),
                                            connected: tWizard('deviceAuth.actions.connected'),
                                            start: tWizard('deviceAuth.actions.start'),
                                            restart: tWizard('deviceAuth.actions.restart'),
                                            refresh: tWizard('deviceAuth.actions.refresh'),
                                        }}
                                    />
                                )}
                            </div>
                        )}

                        {!supportsDeviceAuth && authModeSchema && (
                            <PluginSettingsField
                                name={authModeField}
                                schema={authModeSchema}
                                value={getFieldValue(authModeField, authModeSchema)}
                                onChange={(value) =>
                                    handleFieldChange(
                                        authModeField,
                                        value,
                                        authModeSchema.secret || false,
                                    )
                                }
                                pluginId={plugin.pluginId}
                            />
                        )}

                        {!supportsDeviceAuth &&
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

                        {supportsDeviceAuth &&
                            additionalCredentialFields.map(([key, schema]) => (
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
