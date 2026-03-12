'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, CheckCircle2, ShieldCheck } from 'lucide-react';
import type { PluginSettingsSchemaProperty } from '@/lib/api/plugins';
import { Button } from '@/components/ui/button';
import { PluginSettingsField } from '@/components/plugins/form/PluginSettingsField';

interface ClaudeCodeOnboardingWizardProps {
    pluginId: string;
    visibleProperties: Record<string, PluginSettingsSchemaProperty>;
    getFieldValue: (key: string, propSchema: PluginSettingsSchemaProperty) => unknown;
    handleFieldChange: (key: string, value: unknown, isSecret: boolean) => void;
    handleSave: () => Promise<void>;
    isSaving: boolean;
    saveSuccess: boolean;
    validationError: string | null;
    saveMessage: string | null;
}

export function ClaudeCodeOnboardingWizard({
    pluginId,
    visibleProperties,
    getFieldValue,
    handleFieldChange,
    handleSave,
    isSaving,
    saveSuccess,
    validationError,
    saveMessage,
}: ClaudeCodeOnboardingWizardProps) {
    const t = useTranslations('onboarding.claudeWizard');
    const [step, setStep] = useState(0);

    const modelSchema = visibleProperties.model;
    const oauthTokenSchema = visibleProperties.oauthToken;
    const apiKeySchema = visibleProperties.apiKey;

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

            <div className="grid gap-3 md:grid-cols-3">
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
                    <div className="grid gap-4 md:grid-cols-2">
                        {oauthTokenSchema && (
                            <PluginSettingsField
                                name="oauthToken"
                                schema={oauthTokenSchema}
                                value={getFieldValue('oauthToken', oauthTokenSchema)}
                                onChange={(value) => handleFieldChange('oauthToken', value, true)}
                                pluginId={pluginId}
                            />
                        )}
                        {apiKeySchema && (
                            <PluginSettingsField
                                name="apiKey"
                                schema={apiKeySchema}
                                value={getFieldValue('apiKey', apiKeySchema)}
                                onChange={(value) => handleFieldChange('apiKey', value, true)}
                                pluginId={pluginId}
                            />
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
