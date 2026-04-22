'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
    ArrowRight,
    BookOpen,
    CheckCircle2,
    FolderPlus,
    Shield,
    Sparkles,
    Zap,
} from 'lucide-react';
import { ONBOARDING_STORAGE_KEY, ROUTES } from '@/lib/constants';
import { Dialog, DialogContent, DialogDescription, DialogHeader } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';
import { Link } from '@/i18n/navigation';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import { OnboardingPluginStep } from './OnboardingPluginStep';
import { useMounted } from '@/lib/hooks/use-mounted';
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

function isPluginConnected(
    plugin: UserPlugin,
    oauthConnections: Record<string, OAuthConnectionInfo | null>,
): boolean {
    const isOAuth = plugin.capabilities.includes('oauth');
    if (isOAuth) {
        return oauthConnections[plugin.pluginId]?.connected === true;
    }
    if (plugin.connectionStatus) {
        return plugin.connectionStatus.connected === true;
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
    const mounted = useMounted();
    const [storedState, setStoredState] = useLocalStorage<OnboardingState>(
        ONBOARDING_STORAGE_KEY,
        DEFAULT_STATE,
        {
            serialize: JSON.stringify,
            deserialize: (raw) => JSON.parse(raw) as OnboardingState,
        },
    );

    const steps = useMemo<WizardStep[]>(
        () => [
            { kind: 'welcome' },
            ...plugins.map((p) => ({ kind: 'plugin' as const, plugin: p })),
            { kind: 'directory' },
        ],
        [plugins],
    );

    const shouldOpen = totalDirectories === 0 && !storedState.dismissed;
    const activeStep = Math.min(storedState.step, steps.length - 1);
    const isLastStep = activeStep === steps.length - 1;

    const setStep = (index: number) => setStoredState({ ...storedState, step: index });
    const dismiss = () => setStoredState({ ...storedState, dismissed: true });
    const goNext = () => setStep(Math.min(activeStep + 1, steps.length - 1));

    if (!mounted || !shouldOpen) return null;

    const currentStep = steps[activeStep];
    const progressPercent = Math.round(((activeStep + 1) / steps.length) * 100);

    return (
        <Dialog open={shouldOpen} onOpenChange={(open) => !open && dismiss()}>
            <DialogContent className="max-w-5xl p-0 overflow-hidden rounded-lg shadow-2xl">
                {/* Top progress bar */}
                <div className="absolute top-0 left-0 right-0 h-[3px] bg-border dark:bg-border-dark z-10 rounded-t-lg">
                    <div
                        className="h-full bg-text dark:bg-white/70 transition-all duration-500 ease-out rounded-t-2xl"
                        style={{ width: `${progressPercent}%` }}
                    />
                </div>

                <div className="grid gap-0 md:grid-cols-[260px_1fr] min-h-[90dvh]">
                    {/* ── Sidebar ── */}
                    <aside className="relative flex flex-col bg-surface-secondary/50 dark:bg-surface-secondary-dark/60 border-r border-border dark:border-border-dark">
                        {/* Brand header */}
                        <div className="px-5 pt-8 pb-5">
                            <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-text-muted dark:text-text-muted-dark bg-surface-secondary dark:bg-white/5 px-2.5 py-1 rounded-full mb-3">
                                {t('label')}
                            </span>
                            <DialogHeader className="mt-2 space-y-1">
                                <h2 className="text-sm font-semibold text-text dark:text-text-dark leading-snug">
                                    {t('title')}
                                </h2>
                                <DialogDescription className="text-[11px] leading-relaxed">
                                    {t('subtitle')}
                                </DialogDescription>
                            </DialogHeader>
                        </div>

                        {/* Step list */}
                        <nav className="flex-1 px-3 pb-2 space-y-0.5 overflow-y-auto">
                            {steps.map((step, index) => {
                                const isActive = index === activeStep;
                                const isDone = (() => {
                                    if (step.kind === 'plugin') {
                                        return isPluginConnected(step.plugin, oauthConnections);
                                    }
                                    return false;
                                })();
                                const isPast = index < activeStep;

                                const label = (() => {
                                    if (step.kind === 'welcome') return t('steps.welcome.title');
                                    if (step.kind === 'directory')
                                        return t('steps.directory.title');
                                    return step.plugin.name;
                                })();

                                return (
                                    <button
                                        key={index}
                                        type="button"
                                        onClick={() => setStep(index)}
                                        className={cn(
                                            'w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-all',
                                            isActive
                                                ? 'bg-surface dark:bg-white/5'
                                                : 'hover:bg-surface dark:hover:bg-surface-dark',
                                        )}
                                    >
                                        {/* Numbered / check badge */}
                                        <span
                                            className={cn(
                                                'flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold transition-all',
                                                isDone
                                                    ? 'bg-success text-white'
                                                    : isActive
                                                      ? 'bg-text dark:bg-white text-white dark:text-black'
                                                      : isPast
                                                        ? 'bg-border dark:bg-border-dark text-text-muted dark:text-text-muted-dark'
                                                        : 'border border-border dark:border-border-dark text-text-muted dark:text-text-muted-dark',
                                            )}
                                        >
                                            {isDone ? (
                                                <CheckCircle2 className="w-3.5 h-3.5" />
                                            ) : (
                                                index + 1
                                            )}
                                        </span>

                                        <span
                                            className={cn(
                                                'text-sm truncate transition-colors',
                                                isDone
                                                    ? 'text-success'
                                                    : isActive
                                                      ? 'font-medium text-text dark:text-text-dark'
                                                      : 'text-text-secondary dark:text-text-secondary-dark',
                                            )}
                                        >
                                            {label}
                                        </span>
                                    </button>
                                );
                            })}
                        </nav>

                        {/* Skip button */}
                        <div className="px-3 py-2 mt-auto border-t border-border dark:border-border-dark">
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={dismiss}
                                className="w-4/5 mx-auto text-xs py-2.5 text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
                            >
                                {t('skipButton')}
                            </Button>
                        </div>
                    </aside>

                    {/* ── Main content ── */}
                    <section className="flex flex-col">
                        <div className="flex-1 overflow-y-auto px-8 pt-10 pb-6">
                            {/* Welcome */}
                            {currentStep.kind === 'welcome' && (
                                <div className="space-y-6 max-w-2xl">
                                    <div className="flex items-start gap-4">
                                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-secondary dark:bg-white/5">
                                            <BookOpen className="w-5 h-5 text-text-secondary dark:text-text-secondary-dark" />
                                        </div>
                                        <div>
                                            <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                                                {t('steps.welcome.title')}
                                            </h3>
                                            <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                                                {t('steps.welcome.description')}
                                            </p>
                                        </div>
                                    </div>

                                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark leading-relaxed">
                                        {t('steps.welcome.detail')}
                                    </p>

                                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                        {[
                                            {
                                                Icon: Sparkles,
                                                title: t('steps.welcome.feature1.title'),
                                                description: t(
                                                    'steps.welcome.feature1.description',
                                                ),
                                            },
                                            {
                                                Icon: Zap,
                                                title: t('steps.welcome.feature2.title'),
                                                description: t(
                                                    'steps.welcome.feature2.description',
                                                ),
                                            },
                                            {
                                                Icon: Shield,
                                                title: t('steps.welcome.feature3.title'),
                                                description: t(
                                                    'steps.welcome.feature3.description',
                                                ),
                                            },
                                        ].map((feature) => (
                                            <div
                                                key={feature.title}
                                                className="rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-4 hover:border-border-secondary dark:hover:border-white/20 hover:bg-surface-secondary dark:hover:bg-white/5 transition-all"
                                            >
                                                <feature.Icon className="w-4 h-4 text-text-secondary dark:text-text-secondary-dark mb-2.5" />
                                                <p className="text-xs font-semibold text-text dark:text-text-dark mb-1">
                                                    {feature.title}
                                                </p>
                                                <p className="text-xs text-text-muted dark:text-text-muted-dark leading-relaxed">
                                                    {feature.description}
                                                </p>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Plugin */}
                            {currentStep.kind === 'plugin' && (
                                <div className="space-y-5 max-w-2xl">
                                    <div className="flex items-start gap-4">
                                        <PluginIcon
                                            icon={currentStep.plugin.icon}
                                            name={currentStep.plugin.name}
                                            size={44}
                                            className="rounded-xl shrink-0"
                                        />
                                        <div>
                                            <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                                                {currentStep.plugin.name}
                                            </h3>
                                            <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                                                {currentStep.plugin.uiHints
                                                    ?.onboardingDescription ??
                                                    currentStep.plugin.description}
                                            </p>
                                        </div>
                                    </div>
                                    <OnboardingPluginStep
                                        plugin={currentStep.plugin}
                                        oauthConnection={
                                            oauthConnections[currentStep.plugin.pluginId]
                                        }
                                        returnPath={ROUTES.DASHBOARD}
                                    />
                                </div>
                            )}

                            {/* Directory */}
                            {currentStep.kind === 'directory' && (
                                <div className="space-y-5 max-w-lg">
                                    <div className="flex items-start gap-4">
                                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-secondary dark:bg-white/5">
                                            <FolderPlus className="w-5 h-5 text-text-secondary dark:text-text-secondary-dark" />
                                        </div>
                                        <div>
                                            <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                                                {t('steps.directory.title')}
                                            </h3>
                                            <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                                                {t('steps.directory.description')}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="rounded-xl border border-dashed border-border dark:border-border-dark bg-surface-secondary/40 dark:bg-surface-secondary-dark/30 p-5 space-y-4">
                                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark leading-relaxed">
                                            {t('steps.directory.detail')}
                                        </p>
                                        <Link
                                            href={ROUTES.DASHBOARD_DIRECTORIES_NEW}
                                            className="inline-flex items-center gap-2 rounded-lg bg-black dark:bg-button-primary-dark px-4 py-2.5 text-sm font-medium text-white dark:text-black transition-colors hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark"
                                            onClick={dismiss}
                                        >
                                            {t('steps.directory.action')}
                                            <ArrowRight className="w-4 h-4" />
                                        </Link>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Footer with dot stepper */}
                        <div className="flex items-center justify-between px-8 py-2 border-t border-border dark:border-border-dark bg-surface-secondary dark:bg-surface-secondary-dark/30">
                            <div className="flex items-center gap-1.5">
                                {steps.map((_, i) => (
                                    <button
                                        key={i}
                                        type="button"
                                        onClick={() => setStep(i)}
                                        aria-label={`Go to step ${i + 1}`}
                                        className={cn(
                                            'rounded-full transition-all duration-200',
                                            i === activeStep
                                                ? 'w-5 h-1.5 bg-text dark:bg-white'
                                                : i < activeStep
                                                  ? 'w-1.5 h-1.5 bg-border-secondary dark:bg-white/20'
                                                  : 'w-1.5 h-1.5 bg-border dark:bg-border-dark',
                                        )}
                                    />
                                ))}
                                <span className="ml-2 text-xs text-text-muted dark:text-text-muted-dark tabular-nums">
                                    {t('stepIndex', { index: activeStep + 1 })} / {steps.length}
                                </span>
                            </div>

                            {!isLastStep && (
                                <Button variant="primary" size="sm" onClick={goNext}>
                                    {t('nextButton')}
                                    <ArrowRight className="w-3.5 h-3.5" />
                                </Button>
                            )}
                        </div>
                    </section>
                </div>
            </DialogContent>
        </Dialog>
    );
}
