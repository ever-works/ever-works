'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import type { CodexLocalAuthStatus, PluginSettingsSchemaProperty } from '@/lib/api/plugins';
import { Button } from '@/components/ui/button';
import { PluginSettingsField } from '@/components/plugins/form/PluginSettingsField';
import { cn } from '@/lib/utils/cn';
import { getCodexLocalAuthStatus, startCodexLocalAuth } from '@/app/actions/plugins';

interface CodexOnboardingWizardProps {
    pluginId: string;
    initialSettings: Record<string, unknown>;
    visibleProperties: Record<string, PluginSettingsSchemaProperty>;
    getFieldValue: (key: string, propSchema: PluginSettingsSchemaProperty) => unknown;
    handleFieldChange: (key: string, value: unknown, isSecret: boolean) => void;
    handleSave: () => Promise<void>;
    isSaving: boolean;
    saveSuccess: boolean;
    validationError: string | null;
    saveMessage: string | null;
}

export function CodexOnboardingWizard({
    pluginId,
    initialSettings,
    visibleProperties,
    getFieldValue,
    handleFieldChange,
    handleSave,
    isSaving,
    saveSuccess,
    validationError,
    saveMessage,
}: CodexOnboardingWizardProps) {
    const t = useTranslations('onboarding.codexWizard');
    const [step, setStep] = useState(0);
    const [selectedAuthMode, setSelectedAuthMode] = useState<'api-key' | 'local'>('api-key');
    const [localAuthStatus, setLocalAuthStatus] = useState<CodexLocalAuthStatus | null>(null);
    const [localAuthError, setLocalAuthError] = useState<string | null>(null);
    const [isLoadingLocalAuth, setIsLoadingLocalAuth] = useState(false);
    const [isStartingLocalAuth, setIsStartingLocalAuth] = useState(false);
    const hasInitializedAuthMode = useRef(false);

    const modelSchema = visibleProperties.model;
    const apiKeySchema = visibleProperties.apiKey;
    const configuredAuthMode =
        typeof initialSettings.authMode === 'string' ? initialSettings.authMode : undefined;
    const hasSavedApiKey =
        typeof initialSettings.apiKey === 'string' && initialSettings.apiKey.length > 0;

    const loadLocalAuthStatus = useCallback(async () => {
        setIsLoadingLocalAuth(true);
        setLocalAuthError(null);
        const result = await getCodexLocalAuthStatus(pluginId);
        if (!result.success || !result.data) {
            setLocalAuthError(result.error || t('steps.credentials.local.error'));
            setIsLoadingLocalAuth(false);
            return;
        }

        setLocalAuthStatus(result.data);
        setIsLoadingLocalAuth(false);

        if (hasInitializedAuthMode.current) {
            return;
        }

        if (configuredAuthMode === 'api-key' || configuredAuthMode === 'local') {
            setSelectedAuthMode(configuredAuthMode);
            handleFieldChange('authMode', configuredAuthMode, false);
        } else if (hasSavedApiKey) {
            setSelectedAuthMode('api-key');
            handleFieldChange('authMode', 'api-key', false);
        } else if (result.data.connected) {
            setSelectedAuthMode('local');
            handleFieldChange('authMode', 'local', false);
        } else {
            setSelectedAuthMode('api-key');
            handleFieldChange('authMode', 'api-key', false);
        }

        hasInitializedAuthMode.current = true;
    }, [configuredAuthMode, hasSavedApiKey, pluginId, t, handleFieldChange]);

    useEffect(() => {
        void loadLocalAuthStatus();
    }, [loadLocalAuthStatus]);

    useEffect(() => {
        if (!localAuthStatus?.pending) {
            return;
        }

        const timer = window.setInterval(() => {
            void loadLocalAuthStatus();
        }, 2000);

        return () => window.clearInterval(timer);
    }, [localAuthStatus?.pending, loadLocalAuthStatus]);

    const steps = useMemo(
        () => [
            { title: t('steps.model.title'), description: t('steps.model.description') },
            {
                title: t('steps.credentials.title'),
                description: t('steps.credentials.description'),
            },
            { title: t('steps.verify.title'), description: t('steps.verify.description') },
        ],
        [t],
    );

    const setAuthMode = (mode: 'api-key' | 'local') => {
        setSelectedAuthMode(mode);
        handleFieldChange('authMode', mode, false);
    };

    const handleStartLocalAuth = async () => {
        setIsStartingLocalAuth(true);
        setLocalAuthError(null);

        const result = await startCodexLocalAuth(pluginId);
        if (!result.success || !result.data) {
            setLocalAuthError(result.error || t('steps.credentials.local.error'));
            setIsStartingLocalAuth(false);
            return;
        }

        setLocalAuthStatus(result.data);
        setAuthMode('local');
        setIsStartingLocalAuth(false);

        if (result.data.verificationUri) {
            window.open(result.data.verificationUri, '_blank', 'noopener,noreferrer');
        }
    };

    return (
        <div className="rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-6 space-y-6">
            <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-text-muted dark:text-text-muted-dark">
                    {t('label')}
                </p>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h2>
                <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('subtitle')}</p>
            </div>

            <div className="grid gap-3 @lg/main:grid-cols-3">
                {steps.map((item, index) => (
                    <button
                        key={item.title}
                        type="button"
                        onClick={() => setStep(index)}
                        className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                            index === step
                                ? 'border-primary bg-primary/8'
                                : 'border-border dark:border-border-dark bg-surface-secondary/60 dark:bg-surface-secondary-dark/40'
                        }`}
                    >
                        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-text-muted dark:text-text-muted-dark">
                            {t('stepIndex', { index: index + 1 })}
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
                        {steps[step].title}
                    </h3>
                    <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                        {steps[step].description}
                    </p>
                </div>

                {step === 0 && modelSchema && (
                    <PluginSettingsField
                        name="model"
                        schema={modelSchema}
                        value={getFieldValue('model', modelSchema)}
                        onChange={(value) => handleFieldChange('model', value, false)}
                        pluginId={pluginId}
                    />
                )}

                {step === 1 && (
                    <div className="space-y-4">
                        <div className="grid gap-4 @lg/main:grid-cols-2">
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
                                            {t('steps.credentials.api.title')}
                                        </p>
                                        <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                                            {t('steps.credentials.api.description')}
                                        </p>
                                    </div>
                                    {selectedAuthMode === 'api-key' && (
                                        <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                                    )}
                                </div>
                            </button>

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
                                            {t('steps.credentials.local.title')}
                                        </p>
                                        <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                                            {t('steps.credentials.local.description')}
                                        </p>
                                    </div>
                                    {localAuthStatus?.connected ? (
                                        <span className="rounded-full bg-success/10 px-2 py-1 text-xs font-medium text-success">
                                            {t('steps.credentials.local.connected')}
                                        </span>
                                    ) : localAuthStatus?.pending ? (
                                        <span className="rounded-full bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                                            {t('steps.credentials.local.pending')}
                                        </span>
                                    ) : null}
                                </div>
                            </button>
                        </div>

                        {selectedAuthMode === 'api-key' && apiKeySchema && (
                            <PluginSettingsField
                                name="apiKey"
                                schema={apiKeySchema}
                                value={getFieldValue('apiKey', apiKeySchema)}
                                onChange={(value) => handleFieldChange('apiKey', value, true)}
                                pluginId={pluginId}
                            />
                        )}

                        {selectedAuthMode === 'local' && (
                            <div className="rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-4 space-y-4">
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <p className="text-sm font-medium text-text dark:text-text-dark">
                                            {t('steps.credentials.local.machineTitle')}
                                        </p>
                                        <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                                            {localAuthStatus?.message ||
                                                t('steps.credentials.local.machineDescription')}
                                        </p>
                                    </div>
                                    {(isLoadingLocalAuth || isStartingLocalAuth) && (
                                        <Loader2 className="w-4 h-4 animate-spin text-text-muted dark:text-text-muted-dark shrink-0" />
                                    )}
                                </div>

                                {localAuthStatus?.userCode && (
                                    <div className="rounded-lg bg-surface-secondary/70 dark:bg-surface-secondary-dark/60 px-4 py-3">
                                        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-text-muted dark:text-text-muted-dark">
                                            {t('steps.credentials.local.codeLabel')}
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

                                {localAuthStatus?.authPath && (
                                    <p className="text-xs text-text-muted dark:text-text-muted-dark break-all">
                                        {t('steps.credentials.local.pathLabel', {
                                            path: localAuthStatus.authPath,
                                        })}
                                    </p>
                                )}

                                {localAuthError && (
                                    <p className="text-sm text-danger">{localAuthError}</p>
                                )}

                                {!localAuthStatus?.installed ? (
                                    <p className="text-sm text-danger">
                                        {t('steps.credentials.local.notInstalled')}
                                    </p>
                                ) : localAuthStatus.connected ? (
                                    <Button
                                        type="button"
                                        variant="secondary"
                                        className="bg-success/10 text-success hover:bg-success/15"
                                        onClick={() => void loadLocalAuthStatus()}
                                    >
                                        {t('steps.credentials.local.connectedButton')}
                                    </Button>
                                ) : (
                                    <Button
                                        type="button"
                                        onClick={() => void handleStartLocalAuth()}
                                        loading={isStartingLocalAuth}
                                    >
                                        {localAuthStatus?.pending
                                            ? t('steps.credentials.local.retryButton')
                                            : t('steps.credentials.local.connectButton')}
                                    </Button>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {step === 2 && (
                    <div className="space-y-4">
                        <div className="flex items-start gap-3 rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-4">
                            <ShieldCheck className="mt-0.5 w-5 h-5 text-primary" />
                            <div>
                                <p className="text-sm font-medium text-text dark:text-text-dark">
                                    {t('steps.verify.checkTitle')}
                                </p>
                                <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                                    {t('steps.verify.checkDescription')}
                                </p>
                            </div>
                        </div>

                        <Button onClick={handleSave} loading={isSaving}>
                            {t('steps.verify.button')}
                        </Button>

                        {saveSuccess && (
                            <p className="inline-flex items-center gap-2 text-sm text-success">
                                <CheckCircle2 className="w-4 h-4" />
                                {saveMessage || t('steps.verify.successDefault')}
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
                            {t('continueButton')}
                            <ArrowRight className="w-4 h-4" />
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
}
