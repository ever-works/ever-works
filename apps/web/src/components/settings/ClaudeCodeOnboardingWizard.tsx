'use client';

import { useMemo, useState } from 'react';
import { ArrowRight, CheckCircle2, ExternalLink, ShieldCheck } from 'lucide-react';
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
    const [step, setStep] = useState(0);

    const modelSchema = visibleProperties.model;
    const oauthTokenSchema = visibleProperties.oauthToken;
    const apiKeySchema = visibleProperties.apiKey;

    const steps = useMemo(
        () => [
            {
                title: 'Connect to Claude',
                description:
                    'Open Claude in a new tab, approve access there, then return here to finish the setup.',
            },
            {
                title: 'Pick a model',
                description:
                    'Sonnet is preselected as the recommended balance of quality and speed, but you can switch to any supported model.',
            },
            {
                title: 'Add credentials',
                description:
                    'Paste your Claude Code OAuth token or an Anthropic API key. Either one works, and the wizard will verify it before completion.',
            },
            {
                title: 'Verify connection',
                description:
                    'Save settings and run a live connection check against Claude before finishing the setup.',
            },
        ],
        [],
    );

    return (
        <div className="rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-6 space-y-6">
            <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-text-muted dark:text-text-muted-dark">
                    Claude Code onboarding
                </p>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark">
                    Set up Claude Code in four quick steps
                </h2>
                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                    This flow keeps the recommended Claude configuration visible and verifies the
                    connection before you finish.
                </p>
            </div>

            <div className="grid gap-3 md:grid-cols-4">
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

                {step === 0 && (
                    <div className="space-y-3">
                        <a
                            href="https://claude.ai/login"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
                        >
                            Connect to Claude
                            <ExternalLink className="w-4 h-4" />
                        </a>
                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                            Keep this wizard open. After you approve access in Claude, return here
                            and continue to choose the model and verify credentials.
                        </p>
                    </div>
                )}

                {step === 1 && modelSchema && (
                    <PluginSettingsField
                        name="model"
                        schema={modelSchema}
                        value={getFieldValue('model', modelSchema)}
                        onChange={(value) => handleFieldChange('model', value, false)}
                        pluginId={pluginId}
                    />
                )}

                {step === 2 && (
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

                {step === 3 && (
                    <div className="space-y-4">
                        <div className="flex items-start gap-3 rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-4">
                            <ShieldCheck className="mt-0.5 w-5 h-5 text-primary" />
                            <div>
                                <p className="text-sm font-medium text-text dark:text-text-dark">
                                    Run a live Claude validation
                                </p>
                                <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                                    Saving here runs a Claude API or CLI verification, depending on
                                    which credential you supplied.
                                </p>
                            </div>
                        </div>

                        <Button onClick={handleSave} loading={isSaving}>
                            Verify and finish setup
                        </Button>

                        {saveSuccess && (
                            <p className="inline-flex items-center gap-2 text-sm text-success">
                                <CheckCircle2 className="w-4 h-4" />
                                {saveMessage || 'Claude connection verified.'}
                            </p>
                        )}

                        {validationError && (
                            <p className="text-sm text-danger">{validationError}</p>
                        )}
                    </div>
                )}

                {step < steps.length - 1 && (
                    <div className="flex justify-end">
                        <Button variant="secondary" onClick={() => setStep((current) => current + 1)}>
                            Continue
                            <ArrowRight className="w-4 h-4" />
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
}
