'use client';

import { useMemo, useState } from 'react';
import { ArrowRight, CheckCircle2, ShieldCheck } from 'lucide-react';
import type { PluginSettingsSchemaProperty } from '@/lib/api/plugins';
import { Button } from '@/components/ui/button';
import { PluginSettingsField } from '@/components/plugins/form/PluginSettingsField';

interface OpenCodeOnboardingWizardProps {
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

export function OpenCodeOnboardingWizard({
    pluginId,
    visibleProperties,
    getFieldValue,
    handleFieldChange,
    handleSave,
    isSaving,
    saveSuccess,
    validationError,
    saveMessage,
}: OpenCodeOnboardingWizardProps) {
    const [step, setStep] = useState(0);

    const modelSchema = visibleProperties.model;
    const authModeSchema = visibleProperties.authMode;
    const providerSchema = visibleProperties.provider;
    const apiKeySchema = visibleProperties.apiKey;
    const authModeValue = authModeSchema
        ? String(getFieldValue('authMode', authModeSchema) ?? 'machine-local')
        : 'machine-local';
    const usesApiKey = authModeValue === 'api-key';

    const steps = useMemo(
        () => [
            {
                title: 'Pick a model',
                description: 'Choose the OpenCode model you want to run for directory generation.',
            },
            {
                title: 'Choose authentication',
                description:
                    'Use the machine-local OpenCode login on this server or provide an explicit provider API key.',
            },
            {
                title: 'Verify connection',
                description: 'Save settings and run a live OpenCode validation before finishing.',
            },
        ],
        [],
    );

    return (
        <div className="rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-6 space-y-6">
            <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-text-muted dark:text-text-muted-dark">
                    OpenCode setup
                </p>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark">
                    Set up OpenCode in three steps
                </h2>
                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                    This flow keeps the OpenCode authentication choices visible and verifies the
                    connection before you finish.
                </p>
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
                        {authModeSchema && (
                            <PluginSettingsField
                                name="authMode"
                                schema={authModeSchema}
                                value={getFieldValue('authMode', authModeSchema)}
                                onChange={(value) => handleFieldChange('authMode', value, false)}
                                pluginId={pluginId}
                            />
                        )}

                        {providerSchema && (
                            <PluginSettingsField
                                name="provider"
                                schema={providerSchema}
                                value={getFieldValue('provider', providerSchema)}
                                onChange={(value) => handleFieldChange('provider', value, false)}
                                pluginId={pluginId}
                            />
                        )}

                        {usesApiKey && apiKeySchema ? (
                            <PluginSettingsField
                                name="apiKey"
                                schema={apiKeySchema}
                                value={getFieldValue('apiKey', apiKeySchema)}
                                onChange={(value) => handleFieldChange('apiKey', value, true)}
                                pluginId={pluginId}
                            />
                        ) : (
                            <div className="rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-4">
                                <p className="text-sm font-medium text-text dark:text-text-dark">
                                    Machine-local OpenCode authentication
                                </p>
                                <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                                    OpenCode will use the existing login on this machine from{' '}
                                    <code>~/.local/share/opencode/auth.json</code>.
                                </p>
                                <p className="mt-2 text-sm text-text-muted dark:text-text-muted-dark">
                                    Run <code>opencode auth login</code> on the server first if the
                                    provider is not connected yet.
                                </p>
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
                                    Run a live OpenCode validation
                                </p>
                                <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                                    Saving here verifies either the machine-local OpenCode login or
                                    the provider API key, depending on the mode you selected.
                                </p>
                            </div>
                        </div>

                        <Button onClick={handleSave} loading={isSaving}>
                            Verify and finish setup
                        </Button>

                        {saveSuccess && (
                            <p className="inline-flex items-center gap-2 text-sm text-success">
                                <CheckCircle2 className="w-4 h-4" />
                                {saveMessage || 'OpenCode connection verified.'}
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
