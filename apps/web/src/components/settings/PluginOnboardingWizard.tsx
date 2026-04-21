'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
                setLocalAuthError(status.error || 'Failed to load local authentication status.');
                return;
            }

            setLocalAuthStatus(status.data);
        } finally {
            setIsLoadingLocalAuth(false);
        }
    }, [plugin.pluginId]);

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
    const credentialFieldNames = new Set(['apiKey', 'oauthToken']);
    const configurationFields = orderedFields.filter(([key, schema]) => {
        if (key === authModeField) {
            return false;
        }

        return !credentialFieldNames.has(key) && schema.secret !== true;
    });
    const credentialFields = orderedFields.filter(([key, schema]) => {
        if (key === authModeField) {
            return false;
        }

        return credentialFieldNames.has(key) || schema.secret === true;
    });

    const apiKeyField = credentialFields.find(([key]) => key === 'apiKey');
    const additionalCredentialFields = credentialFields.filter(([key]) => key !== 'apiKey');

    const steps = useMemo<StepConfig[]>(() => {
        const result: StepConfig[] = [];

        if (configurationFields.length > 0) {
            result.push({
                key: 'configure',
                title: 'Configuration',
                description:
                    plugin.uiHints?.onboardingDescription || `Configure ${plugin.name} settings.`,
            });
        }

        if (supportsLocalAuth || credentialFields.length > 0) {
            result.push({
                key: 'credentials',
                title: 'Credentials',
                description: `Configure credentials for ${plugin.name}.`,
            });
        }

        result.push({
            key: 'verify',
            title: 'Verify',
            description: 'Save settings and verify the connection.',
        });

        return result;
    }, [
        configurationFields.length,
        credentialFields.length,
        plugin.name,
        plugin.uiHints?.onboardingDescription,
        supportsLocalAuth,
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
                setLocalAuthError(result.error || 'Failed to start local authentication.');
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

    return (
        <div className="rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-6 space-y-6">
            <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-text-muted dark:text-text-muted-dark">
                    Setup
                </p>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark">
                    {plugin.name}
                </h2>
                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                    {plugin.uiHints?.onboardingDescription || plugin.description}
                </p>
            </div>

            <div
                className={`grid gap-3 ${steps.length > 2 ? '@lg/main:grid-cols-3' : '@lg/main:grid-cols-2'}`}
            >
                {steps.map((item, index) => (
                    <button
                        key={item.key}
                        type="button"
                        onClick={() => setStep(index)}
                        className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                            index === step
                                ? 'border-primary bg-primary/8'
                                : 'border-border dark:border-border-dark bg-surface-secondary/60 dark:bg-surface-secondary-dark/40'
                        }`}
                    >
                        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-text-muted dark:text-text-muted-dark">
                            Step {index + 1}
                        </div>
                        <div className="mt-1 text-sm font-semibold text-text dark:text-text-dark">
                            {item.title}
                        </div>
                    </button>
                ))}
            </div>

            <div className="rounded-xl border border-border dark:border-border-dark bg-surface-secondary/50 dark:bg-surface-secondary-dark/40 p-5 space-y-4">
                <div>
                    <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                        {currentStep.title}
                    </h3>
                    <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                        {currentStep.description}
                    </p>
                </div>

                {currentStep.key === 'configure' && (
                    <div className="space-y-4">
                        {configurationFields.map(([key, schema]) => (
                            <PluginSettingsField
                                key={key}
                                name={key}
                                schema={schema}
                                value={getFieldValue(key, schema)}
                                onChange={(value) =>
                                    handleFieldChange(key, value, schema.secret || false)
                                }
                                pluginId={plugin.pluginId}
                            />
                        ))}
                    </div>
                )}

                {currentStep.key === 'credentials' && (
                    <div className="space-y-4">
                        {supportsLocalAuth && (
                            <div className="space-y-4">
                                <div className="grid gap-4 @lg/main:grid-cols-2">
                                    {apiKeyField && (
                                        <button
                                            type="button"
                                            onClick={() => setAuthMode('api-key')}
                                            className={cn(
                                                'rounded-xl border p-4 text-left transition-colors',
                                                selectedAuthMode === 'api-key'
                                                    ? 'border-primary bg-primary/8'
                                                    : 'border-border dark:border-border-dark bg-surface dark:bg-surface-dark',
                                            )}
                                        >
                                            <div className="flex items-center justify-between gap-3">
                                                <div>
                                                    <p className="text-sm font-semibold text-text dark:text-text-dark">
                                                        API Key
                                                    </p>
                                                    <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                                                        Use a user-scoped API key for this plugin.
                                                    </p>
                                                </div>
                                                {selectedAuthMode === 'api-key' && (
                                                    <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                                                )}
                                            </div>
                                        </button>
                                    )}

                                    <button
                                        type="button"
                                        onClick={() => setAuthMode('local')}
                                        className={cn(
                                            'rounded-xl border p-4 text-left transition-colors',
                                            selectedAuthMode === 'local'
                                                ? 'border-primary bg-primary/8'
                                                : 'border-border dark:border-border-dark bg-surface dark:bg-surface-dark',
                                            localAuthStatus?.connected && 'ring-1 ring-primary/20',
                                        )}
                                    >
                                        <div className="flex items-center justify-between gap-3">
                                            <div>
                                                <p className="text-sm font-semibold text-text dark:text-text-dark">
                                                    Local Authentication
                                                </p>
                                                <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                                                    Authenticate on the backend machine for this
                                                    plugin.
                                                </p>
                                            </div>
                                            {localAuthStatus?.connected ? (
                                                <span className="rounded-full bg-success/10 px-2 py-1 text-xs font-medium text-success">
                                                    Connected
                                                </span>
                                            ) : localAuthStatus?.pending ? (
                                                <span className="rounded-full bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                                                    Pending
                                                </span>
                                            ) : null}
                                        </div>
                                    </button>
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
                                    <div className="rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-4 space-y-4">
                                        <div className="flex items-start justify-between gap-3">
                                            <div>
                                                <p className="text-sm font-medium text-text dark:text-text-dark">
                                                    Backend Machine Status
                                                </p>
                                                <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                                                    {localAuthStatus?.message ||
                                                        'Start or refresh local authentication for this backend instance.'}
                                                </p>
                                            </div>
                                            {(isLoadingLocalAuth || isStartingLocalAuth) && (
                                                <Loader2 className="w-4 h-4 animate-spin text-text-muted dark:text-text-muted-dark shrink-0" />
                                            )}
                                        </div>

                                        {localAuthStatus?.scope === 'machine-local' && (
                                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                                Local auth is machine-scoped and only works on the
                                                backend instance where it was created.
                                            </p>
                                        )}

                                        {localAuthStatus?.userCode && (
                                            <div className="rounded-lg bg-surface-secondary/70 dark:bg-surface-secondary-dark/60 px-4 py-3">
                                                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-text-muted dark:text-text-muted-dark">
                                                    Device Code
                                                </p>
                                                <p className="mt-2 font-mono text-lg font-semibold text-text dark:text-text-dark">
                                                    {localAuthStatus.userCode}
                                                </p>
                                            </div>
                                        )}

                                        {localAuthStatus?.verificationUri && (
                                            <p className="text-sm text-text-muted dark:text-text-muted-dark break-all">
                                                {localAuthStatus.verificationUri}
                                            </p>
                                        )}

                                        {localAuthError && (
                                            <p className="text-sm text-danger">{localAuthError}</p>
                                        )}

                                        <div className="flex flex-wrap gap-3">
                                            {!localAuthStatus?.installed ? (
                                                <p className="text-sm text-danger">
                                                    The required CLI is not installed on this
                                                    machine.
                                                </p>
                                            ) : localAuthStatus.connected ? (
                                                <span className="inline-flex items-center rounded-lg bg-success/10 px-3 py-2 text-sm font-medium text-success">
                                                    Local authentication connected
                                                </span>
                                            ) : (
                                                <Button
                                                    type="button"
                                                    onClick={() => void handleStartLocalAuth()}
                                                    loading={isStartingLocalAuth}
                                                >
                                                    {localAuthStatus?.pending
                                                        ? 'Restart Local Auth'
                                                        : 'Start Local Auth'}
                                                </Button>
                                            )}

                                            <Button
                                                type="button"
                                                variant="secondary"
                                                onClick={() => void refreshLocalAuthStatus()}
                                                disabled={isLoadingLocalAuth}
                                            >
                                                Refresh Status
                                            </Button>
                                        </div>
                                    </div>
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
                    <div className="space-y-4">
                        <div className="flex items-start gap-3 rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-4">
                            <ShieldCheck className="mt-0.5 w-5 h-5 text-primary" />
                            <div>
                                <p className="text-sm font-medium text-text dark:text-text-dark">
                                    Verify Connection
                                </p>
                                <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                                    Save the current settings and run the plugin connection
                                    validation.
                                </p>
                            </div>
                        </div>

                        <Button onClick={handleSave} loading={isSaving}>
                            Save and Verify
                        </Button>

                        {saveSuccess && (
                            <p className="inline-flex items-center gap-2 text-sm text-success">
                                <CheckCircle2 className="w-4 h-4" />
                                {saveMessage || 'Connection verified successfully.'}
                            </p>
                        )}

                        {validationError && (
                            <p className="text-sm text-danger">{validationError}</p>
                        )}
                    </div>
                )}

                {step < steps.length - 1 && (
                    <div className="flex justify-end">
                        <Button
                            variant="secondary"
                            onClick={() => setStep((current) => current + 1)}
                        >
                            Continue
                            <ArrowRight className="w-4 h-4" />
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
}
