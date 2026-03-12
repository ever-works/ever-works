'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, BookOpen, CheckCircle2, Circle, FolderPlus } from 'lucide-react';
import { ONBOARDING_STORAGE_KEY, ROUTES } from '@/lib/constants';
import { Dialog, DialogContent, DialogDescription, DialogHeader } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';
import { Link } from '@/i18n/navigation';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import { OnboardingPluginStep } from './OnboardingPluginStep';
import type { UserPlugin } from '@/lib/api/plugins';
import type { OAuthConnectionInfo } from '@/lib/api/plugins-capabilities/oauth';

interface EverWorksOnboardingWizardProps {
    totalDirectories: number;
    plugins: UserPlugin[];
    oauthConnections: Record<string, OAuthConnectionInfo | null>;
}

interface OnboardingState {
    dismissed: boolean;
    step: number;
}

const DEFAULT_STATE: OnboardingState = { dismissed: false, step: 0 };

type WizardStep =
    | { kind: 'welcome' }
    | { kind: 'plugin'; plugin: UserPlugin }
    | { kind: 'directory' };

function isPluginConnected(plugin: UserPlugin, oauthConnections: Record<string, OAuthConnectionInfo | null>): boolean {
    const isOAuth = plugin.capabilities.includes('oauth');
    if (isOAuth) {
        return oauthConnections[plugin.pluginId]?.connected === true;
    }
    const fields = plugin.uiHints?.completionFields;
    if (fields && fields.length > 0) {
        return fields.every((f) => {
            const v = plugin.settings?.[f];
            return v !== undefined && v !== null && v !== '';
        });
    }
    return plugin.enabled;
}

export function EverWorksOnboardingWizard({
    totalDirectories,
    plugins,
    oauthConnections,
}: EverWorksOnboardingWizardProps) {
    const t = useTranslations('onboarding');
    const [storedState, setStoredState] = useLocalStorage<OnboardingState>(
        ONBOARDING_STORAGE_KEY,
        DEFAULT_STATE,
        {
            serialize: JSON.stringify,
            deserialize: (raw) => JSON.parse(raw) as OnboardingState,
        },
    );

    const steps = useMemo<WizardStep[]>(
        () => [{ kind: 'welcome' }, ...plugins.map((p) => ({ kind: 'plugin' as const, plugin: p })), { kind: 'directory' }],
        [plugins],
    );

    const shouldOpen = totalDirectories === 0 && !storedState.dismissed;
    const activeStep = Math.min(storedState.step, steps.length - 1);
    const isLastStep = activeStep === steps.length - 1;

    const setStep = (index: number) => setStoredState({ ...storedState, step: index });
    const dismiss = () => setStoredState({ ...storedState, dismissed: true });
    const goNext = () => setStep(Math.min(activeStep + 1, steps.length - 1));

    if (!shouldOpen) return null;

    const currentStep = steps[activeStep];

    return (
        <Dialog open={shouldOpen} onOpenChange={(open) => !open && dismiss()}>
            <DialogContent className="max-w-3xl p-0 overflow-hidden">
                <div className="grid gap-0 md:grid-cols-[240px_1fr]">
                    {/* Sidebar */}
                    <aside className="border-r border-border dark:border-border-dark bg-surface-secondary/70 dark:bg-surface-secondary-dark/50 p-6 flex flex-col">
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-text-muted dark:text-text-muted-dark">
                            {t('label')}
                        </p>
                        <DialogHeader className="mt-3 mb-6">
                            <h2 className="text-xl font-semibold text-text dark:text-text-dark leading-snug">
                                {t('title')}
                            </h2>
                            <DialogDescription>{t('subtitle')}</DialogDescription>
                        </DialogHeader>

                        <nav className="space-y-1.5 flex-1">
                            {steps.map((step, index) => {
                                const isActive = index === activeStep;
                                const isDone = (() => {
                                    if (step.kind === 'plugin') {
                                        return isPluginConnected(step.plugin, oauthConnections);
                                    }
                                    return false;
                                })();

                                const label = (() => {
                                    if (step.kind === 'welcome') return t('steps.welcome.title');
                                    if (step.kind === 'directory') return t('steps.directory.title');
                                    return step.plugin.name;
                                })();

                                return (
                                    <button
                                        key={index}
                                        type="button"
                                        onClick={() => setStep(index)}
                                        className={`w-full flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                                            isActive
                                                ? 'border-primary bg-primary/8'
                                                : 'border-transparent hover:border-border dark:hover:border-border-dark hover:bg-surface dark:hover:bg-surface-dark'
                                        }`}
                                    >
                                        {isDone ? (
                                            <CheckCircle2 className="w-4 h-4 shrink-0 text-success" />
                                        ) : (
                                            <Circle
                                                className={`w-4 h-4 shrink-0 ${isActive ? 'text-primary' : 'text-text-muted dark:text-text-muted-dark'}`}
                                            />
                                        )}
                                        <div className="min-w-0">
                                            <p
                                                className={`text-sm font-medium truncate ${
                                                    isActive
                                                        ? 'text-primary'
                                                        : 'text-text dark:text-text-dark'
                                                }`}
                                            >
                                                {label}
                                            </p>
                                        </div>
                                    </button>
                                );
                            })}
                        </nav>

                        <div className="mt-6 pt-4 border-t border-border dark:border-border-dark">
                            <Button variant="ghost" size="sm" onClick={dismiss} className="w-full text-text-muted dark:text-text-muted-dark">
                                {t('skipButton')}
                            </Button>
                        </div>
                    </aside>

                    {/* Main content */}
                    <section className="p-8 flex flex-col gap-6 min-h-[440px]">
                        {/* Step header */}
                        {currentStep.kind === 'welcome' && (
                            <div className="flex items-center gap-4">
                                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                                    <BookOpen className="w-6 h-6 text-primary" />
                                </div>
                                <div>
                                    <h3 className="text-xl font-semibold text-text dark:text-text-dark">
                                        {t('steps.welcome.title')}
                                    </h3>
                                    <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                                        {t('steps.welcome.description')}
                                    </p>
                                </div>
                            </div>
                        )}

                        {currentStep.kind === 'plugin' && (
                            <div className="flex items-center gap-4">
                                <PluginIcon
                                    icon={currentStep.plugin.icon}
                                    name={currentStep.plugin.name}
                                    size={48}
                                    className="rounded-xl shrink-0"
                                />
                                <div>
                                    <h3 className="text-xl font-semibold text-text dark:text-text-dark">
                                        {currentStep.plugin.name}
                                    </h3>
                                    <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                                        {currentStep.plugin.uiHints?.onboardingDescription ??
                                            currentStep.plugin.description}
                                    </p>
                                </div>
                            </div>
                        )}

                        {currentStep.kind === 'directory' && (
                            <div className="flex items-center gap-4">
                                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                                    <FolderPlus className="w-6 h-6 text-primary" />
                                </div>
                                <div>
                                    <h3 className="text-xl font-semibold text-text dark:text-text-dark">
                                        {t('steps.directory.title')}
                                    </h3>
                                    <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                                        {t('steps.directory.description')}
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* Step body */}
                        <div className="flex-1">
                            {currentStep.kind === 'welcome' && (
                                <div className="rounded-2xl border border-border dark:border-border-dark bg-surface-secondary/50 dark:bg-surface-secondary-dark/40 p-6">
                                    <p className="text-sm text-text-muted dark:text-text-muted-dark leading-relaxed">
                                        {t('steps.welcome.detail')}
                                    </p>
                                    <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
                                        {[
                                            { title: t('steps.welcome.feature1.title'), description: t('steps.welcome.feature1.description') },
                                            { title: t('steps.welcome.feature2.title'), description: t('steps.welcome.feature2.description') },
                                            { title: t('steps.welcome.feature3.title'), description: t('steps.welcome.feature3.description') },
                                        ].map((feature) => (
                                            <div
                                                key={feature.title}
                                                className="rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-4 py-3"
                                            >
                                                <p className="text-xs font-semibold text-text dark:text-text-dark">
                                                    {feature.title}
                                                </p>
                                                <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                                                    {feature.description}
                                                </p>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {currentStep.kind === 'plugin' && (
                                <OnboardingPluginStep
                                    plugin={currentStep.plugin}
                                    oauthConnection={oauthConnections[currentStep.plugin.pluginId]}
                                    returnPath={ROUTES.DASHBOARD}
                                />
                            )}

                            {currentStep.kind === 'directory' && (
                                <div className="rounded-2xl border border-border dark:border-border-dark bg-surface-secondary/50 dark:bg-surface-secondary-dark/40 p-6 space-y-4">
                                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                        {t('steps.directory.detail')}
                                    </p>
                                    <Link
                                        href={ROUTES.DASHBOARD_DIRECTORIES_NEW}
                                        className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
                                        onClick={dismiss}
                                    >
                                        {t('steps.directory.action')}
                                        <ArrowRight className="w-4 h-4" />
                                    </Link>
                                </div>
                            )}
                        </div>

                        {/* Footer nav */}
                        <div className="flex items-center justify-between mt-auto pt-4 border-t border-border dark:border-border-dark">
                            <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('stepIndex', { index: activeStep + 1 })}
                                {' / '}
                                {steps.length}
                            </span>
                            {!isLastStep && (
                                <Button variant="secondary" onClick={goNext}>
                                    {t('nextButton')}
                                    <ArrowRight className="w-4 h-4" />
                                </Button>
                            )}
                        </div>
                    </section>
                </div>
            </DialogContent>
        </Dialog>
    );
}
