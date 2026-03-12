'use client';

import { useTranslations } from 'next-intl';
import { ArrowRight, BookOpen, FolderPlus, Rocket } from 'lucide-react';
import { ONBOARDING_STORAGE_KEY, ROUTES } from '@/lib/constants';
import { Dialog, DialogContent, DialogDescription, DialogHeader } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';
import { Link } from '@/i18n/navigation';

interface EverWorksOnboardingWizardProps {
    totalDirectories: number;
}

interface OnboardingState {
    dismissed: boolean;
    step: number;
}

const DEFAULT_STATE: OnboardingState = { dismissed: false, step: 0 };

export function EverWorksOnboardingWizard({ totalDirectories }: EverWorksOnboardingWizardProps) {
    const t = useTranslations('onboarding');
    const [storedState, setStoredState] = useLocalStorage<OnboardingState>(
        ONBOARDING_STORAGE_KEY,
        DEFAULT_STATE,
        {
            serialize: JSON.stringify,
            deserialize: (raw) => JSON.parse(raw) as OnboardingState,
        },
    );

    const steps = [
        {
            Icon: BookOpen,
            title: t('steps.welcome.title'),
            description: t('steps.welcome.description'),
        },
        {
            Icon: FolderPlus,
            title: t('steps.directory.title'),
            description: t('steps.directory.description'),
        },
        {
            Icon: Rocket,
            title: t('steps.publish.title'),
            description: t('steps.publish.description'),
        },
    ];

    const shouldOpen = totalDirectories === 0 && !storedState.dismissed;
    const activeStep = Math.min(storedState.step, steps.length - 1);
    const isLastStep = activeStep === steps.length - 1;
    const { Icon, title, description } = steps[activeStep];

    const setStep = (index: number) => setStoredState({ ...storedState, step: index });
    const dismiss = () => setStoredState({ ...storedState, dismissed: true });

    if (!shouldOpen) return null;

    return (
        <Dialog open={shouldOpen} onOpenChange={(open) => !open && dismiss()}>
            <DialogContent className="max-w-3xl p-0 overflow-hidden">
                <div className="grid gap-0 md:grid-cols-[220px_1fr]">
                    {/* Sidebar */}
                    <aside className="border-r border-border dark:border-border-dark bg-surface-secondary/70 dark:bg-surface-secondary-dark/50 p-6">
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-text-muted dark:text-text-muted-dark">
                            {t('label')}
                        </p>
                        <DialogHeader className="mt-3 mb-6">
                            <h2 className="text-xl font-semibold text-text dark:text-text-dark">
                                {t('title')}
                            </h2>
                            <DialogDescription>{t('subtitle')}</DialogDescription>
                        </DialogHeader>

                        <div className="space-y-2">
                            {steps.map((step, index) => (
                                <button
                                    key={step.title}
                                    type="button"
                                    onClick={() => setStep(index)}
                                    className={`w-full rounded-xl border px-4 py-3 text-left transition-colors ${
                                        index === activeStep
                                            ? 'border-primary bg-primary/8'
                                            : 'border-border dark:border-border-dark bg-surface dark:bg-surface-dark'
                                    }`}
                                >
                                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {t('stepIndex', { index: index + 1 })}
                                    </span>
                                    <p className="mt-0.5 text-sm font-semibold text-text dark:text-text-dark">
                                        {step.title}
                                    </p>
                                </button>
                            ))}
                        </div>
                    </aside>

                    {/* Main content */}
                    <section className="p-8 flex flex-col gap-6">
                        <div className="flex items-center gap-4">
                            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                                <Icon className="w-6 h-6 text-primary" />
                            </div>
                            <div>
                                <h3 className="text-xl font-semibold text-text dark:text-text-dark">
                                    {title}
                                </h3>
                                <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                                    {description}
                                </p>
                            </div>
                        </div>

                        <div className="rounded-2xl border border-border dark:border-border-dark bg-surface-secondary/50 dark:bg-surface-secondary-dark/40 p-6">
                            {activeStep === 0 && (
                                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                    {t('steps.welcome.detail')}
                                </p>
                            )}
                            {activeStep === 1 && (
                                <Link
                                    href={ROUTES.DASHBOARD_DIRECTORIES_NEW}
                                    className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
                                    onClick={dismiss}
                                >
                                    {t('steps.directory.action')}
                                    <ArrowRight className="w-4 h-4" />
                                </Link>
                            )}
                            {activeStep === 2 && (
                                <Link
                                    href={ROUTES.DASHBOARD_PLUGINS}
                                    className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
                                    onClick={dismiss}
                                >
                                    {t('steps.publish.action')}
                                    <ArrowRight className="w-4 h-4" />
                                </Link>
                            )}
                        </div>

                        <div className="flex items-center justify-between mt-auto">
                            <Button variant="ghost" onClick={dismiss}>
                                {t('skipButton')}
                            </Button>

                            {!isLastStep && (
                                <Button
                                    variant="secondary"
                                    onClick={() =>
                                        setStep(Math.min(activeStep + 1, steps.length - 1))
                                    }
                                >
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
