'use client';

import { useMemo, useState, useTransition } from 'react';
import { ArrowRight, CheckCircle2, ExternalLink, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { UserPlugin } from '@/lib/api/plugins';
import type { GitProviderConnectionInfo } from '@/lib/api/plugins-capabilities/git-providers';
import { ROUTES } from '@/lib/constants';
import { Dialog, DialogContent, DialogDescription, DialogHeader } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';
import { validatePluginConnection } from '@/app/actions/plugins';
import { Link } from '@/i18n/navigation';

interface EverWorksOnboardingWizardProps {
    totalDirectories: number;
    claudePlugin: UserPlugin | null;
    openRouterPlugin: UserPlugin | null;
    vercelPlugin: UserPlugin | null;
    gitHubConnection: GitProviderConnectionInfo | null;
}

interface OnboardingState {
    dismissed: boolean;
    completed: boolean;
    step: number;
}

const DEFAULT_STATE: OnboardingState = {
    dismissed: false,
    completed: false,
    step: 0,
};

export function EverWorksOnboardingWizard({
    totalDirectories,
    claudePlugin,
    openRouterPlugin,
    vercelPlugin,
    gitHubConnection,
}: EverWorksOnboardingWizardProps) {
    const router = useRouter();
    const [storedState, setStoredState] = useLocalStorage<OnboardingState>(
        'ever-works-onboarding',
        DEFAULT_STATE,
        {
            serialize: JSON.stringify,
            deserialize: (raw) => JSON.parse(raw) as OnboardingState,
        },
    );
    const [validationError, setValidationError] = useState<string | null>(null);
    const [validationMessage, setValidationMessage] = useState<string | null>(null);
    const [isPending, startTransition] = useTransition();

    const hasClaude = Boolean(claudePlugin?.settings?.oauthToken || claudePlugin?.settings?.apiKey);
    const hasOpenRouter = Boolean(
        openRouterPlugin?.settings?.apiKey && openRouterPlugin?.settings?.defaultModel,
    );
    const hasVercel = Boolean(vercelPlugin?.settings?.apiToken);
    const hasGitHub = Boolean(gitHubConnection?.connected);

    const steps = useMemo(
        () => [
            {
                title: 'Claude Code',
                description: 'Connect Claude and choose the model Ever Works should use.',
                complete: hasClaude,
                href: ROUTES.DASHBOARD_PLUGIN_DETAIL('claude-code'),
            },
            {
                title: 'GitHub',
                description: 'Authorize GitHub so Ever Works can manage repositories and deployments.',
                complete: hasGitHub,
                href: ROUTES.DASHBOARD_PLUGIN_DETAIL('github'),
            },
            {
                title: 'OpenRouter',
                description: 'Add your OpenRouter key and default model for core AI generation.',
                complete: hasOpenRouter,
                href: ROUTES.DASHBOARD_PLUGIN_DETAIL('openrouter'),
            },
            {
                title: 'Vercel',
                description: 'Save a Vercel API token and verify that deployments can authenticate.',
                complete: hasVercel,
                href: ROUTES.DASHBOARD_PLUGIN_DETAIL('vercel'),
            },
            {
                title: 'Finish',
                description: 'Run live checks on the required integrations before closing onboarding.',
                complete: hasClaude && hasGitHub && hasOpenRouter && hasVercel,
                href: ROUTES.DASHBOARD,
            },
        ],
        [hasClaude, hasGitHub, hasOpenRouter, hasVercel],
    );

    const shouldOpen = totalDirectories === 0 && !storedState.completed && !storedState.dismissed;
    const activeStep = Math.min(storedState.step, steps.length - 1);

    const closeWizard = () => {
        setStoredState({ ...storedState, dismissed: true });
    };

    const completeWizard = () => {
        setStoredState({ dismissed: false, completed: true, step: steps.length - 1 });
    };

    const nextStep = () => {
        setStoredState({
            ...storedState,
            step: Math.min(activeStep + 1, steps.length - 1),
        });
    };

    const runValidation = () => {
        startTransition(async () => {
            setValidationError(null);
            setValidationMessage(null);

            if (!hasGitHub) {
                setValidationError('Connect GitHub before finishing onboarding.');
                return;
            }

            const pluginIds = ['claude-code', 'openrouter', 'vercel'];
            for (const pluginId of pluginIds) {
                const result = await validatePluginConnection(pluginId);
                if (!result.success) {
                    setValidationError(result.error || `Validation failed for ${pluginId}.`);
                    return;
                }
            }

            setValidationMessage('All required integrations are connected and validated.');
            completeWizard();
            router.refresh();
        });
    };

    if (!shouldOpen) {
        return null;
    }

    return (
        <Dialog open={shouldOpen} onOpenChange={(open) => !open && closeWizard()}>
            <DialogContent className="max-w-4xl p-0 overflow-hidden">
                <div className="grid gap-0 md:grid-cols-[260px_1fr]">
                    <aside className="border-r border-border dark:border-border-dark bg-surface-secondary/70 dark:bg-surface-secondary-dark/50 p-6">
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-text-muted dark:text-text-muted-dark">
                            First-time setup
                        </p>
                        <DialogHeader className="mt-3 mb-6">
                            <h2 className="text-2xl font-semibold text-text dark:text-text-dark">
                                Launch Ever Works with the core integrations ready
                            </h2>
                            <DialogDescription>
                                Progress is saved in this browser, so you can leave and resume
                                onboarding at any time.
                            </DialogDescription>
                        </DialogHeader>

                        <div className="space-y-3">
                            {steps.map((step, index) => (
                                <button
                                    key={step.title}
                                    type="button"
                                    onClick={() => setStoredState({ ...storedState, step: index })}
                                    className={`w-full rounded-xl border px-4 py-3 text-left transition-colors ${
                                        index === activeStep
                                            ? 'border-primary bg-primary/8'
                                            : 'border-border dark:border-border-dark bg-surface dark:bg-surface-dark'
                                    }`}
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="text-sm font-semibold text-text dark:text-text-dark">
                                            {step.title}
                                        </span>
                                        {step.complete && (
                                            <CheckCircle2 className="w-4 h-4 text-success" />
                                        )}
                                    </div>
                                    <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                                        Step {index + 1}
                                    </p>
                                </button>
                            ))}
                        </div>
                    </aside>

                    <section className="p-8">
                        <div className="max-w-2xl space-y-6">
                            <div>
                                <h3 className="text-2xl font-semibold text-text dark:text-text-dark">
                                    {steps[activeStep].title}
                                </h3>
                                <p className="mt-2 text-sm text-text-muted dark:text-text-muted-dark">
                                    {steps[activeStep].description}
                                </p>
                            </div>

                            {activeStep < 4 && (
                                <div className="rounded-2xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-6">
                                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                        Status:{' '}
                                        <span className="font-medium text-text dark:text-text-dark">
                                            {steps[activeStep].complete ? 'Connected' : 'Needs setup'}
                                        </span>
                                    </p>

                                    <div className="mt-5 flex flex-wrap gap-3">
                                        <Link
                                            href={steps[activeStep].href}
                                            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
                                        >
                                            Open integration settings
                                            <ArrowRight className="w-4 h-4" />
                                        </Link>

                                        {steps[activeStep].title === 'Claude Code' && (
                                            <a
                                                href="https://claude.ai/login"
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex items-center gap-2 rounded-lg border border-border dark:border-border-dark px-4 py-3 text-sm font-medium text-text dark:text-text-dark transition-colors hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark"
                                            >
                                                Connect to Claude
                                                <ExternalLink className="w-4 h-4" />
                                            </a>
                                        )}

                                        <Button variant="secondary" onClick={() => router.refresh()}>
                                            <RefreshCw className="w-4 h-4" />
                                            Refresh status
                                        </Button>
                                    </div>
                                </div>
                            )}

                            {activeStep === 4 && (
                                <div className="rounded-2xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-6 space-y-4">
                                    <div className="grid gap-3 sm:grid-cols-2">
                                        <div className="rounded-xl bg-surface-secondary/70 dark:bg-surface-secondary-dark/50 p-4">
                                            <p className="text-xs uppercase tracking-[0.16em] text-text-muted dark:text-text-muted-dark">
                                                Claude
                                            </p>
                                            <p className="mt-1 text-sm font-medium text-text dark:text-text-dark">
                                                {hasClaude ? 'Ready' : 'Missing'}
                                            </p>
                                        </div>
                                        <div className="rounded-xl bg-surface-secondary/70 dark:bg-surface-secondary-dark/50 p-4">
                                            <p className="text-xs uppercase tracking-[0.16em] text-text-muted dark:text-text-muted-dark">
                                                GitHub
                                            </p>
                                            <p className="mt-1 text-sm font-medium text-text dark:text-text-dark">
                                                {hasGitHub ? 'Ready' : 'Missing'}
                                            </p>
                                        </div>
                                        <div className="rounded-xl bg-surface-secondary/70 dark:bg-surface-secondary-dark/50 p-4">
                                            <p className="text-xs uppercase tracking-[0.16em] text-text-muted dark:text-text-muted-dark">
                                                OpenRouter
                                            </p>
                                            <p className="mt-1 text-sm font-medium text-text dark:text-text-dark">
                                                {hasOpenRouter ? 'Ready' : 'Missing'}
                                            </p>
                                        </div>
                                        <div className="rounded-xl bg-surface-secondary/70 dark:bg-surface-secondary-dark/50 p-4">
                                            <p className="text-xs uppercase tracking-[0.16em] text-text-muted dark:text-text-muted-dark">
                                                Vercel
                                            </p>
                                            <p className="mt-1 text-sm font-medium text-text dark:text-text-dark">
                                                {hasVercel ? 'Ready' : 'Missing'}
                                            </p>
                                        </div>
                                    </div>

                                    <Button onClick={runValidation} loading={isPending}>
                                        Validate connections and complete onboarding
                                    </Button>

                                    {validationMessage && (
                                        <p className="text-sm text-success">{validationMessage}</p>
                                    )}

                                    {validationError && (
                                        <p className="text-sm text-danger">{validationError}</p>
                                    )}
                                </div>
                            )}

                            <div className="flex items-center justify-between">
                                <Button variant="ghost" onClick={closeWizard}>
                                    Skip for now
                                </Button>

                                {activeStep < 4 && (
                                    <Button variant="secondary" onClick={nextStep}>
                                        Next step
                                        <ArrowRight className="w-4 h-4" />
                                    </Button>
                                )}
                            </div>
                        </div>
                    </section>
                </div>
            </DialogContent>
        </Dialog>
    );
}
