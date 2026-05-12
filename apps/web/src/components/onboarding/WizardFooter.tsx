'use client';

import { ArrowLeft, ArrowRight, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface WizardFooterProps {
    readonly stepIndex: number;
    readonly totalSteps: number;
    readonly canGoBack: boolean;
    readonly nextLabel: string;
    readonly skipLabel: string;
    readonly showSkip: boolean;
    readonly showNext: boolean;
    readonly showRefresh: boolean;
    readonly refreshing?: boolean;
    readonly onBack: () => void;
    readonly onSkip: () => void;
    readonly onRefresh: () => void;
    readonly onNext: () => void;
}

/**
 * Bottom action bar for the onboarding wizard. Renders Back / Skip /
 * Refresh / Next per the step's needs. Each control is opt-in via the
 * corresponding `show*` / `can*` prop so the same component drives every
 * step.
 */
export function WizardFooter({
    stepIndex,
    totalSteps,
    canGoBack,
    nextLabel,
    skipLabel,
    showSkip,
    showNext,
    showRefresh,
    refreshing = false,
    onBack,
    onSkip,
    onRefresh,
    onNext,
}: WizardFooterProps) {
    return (
        <div className="flex items-center justify-between gap-3 px-8 py-3 border-t border-border dark:border-border-dark bg-surface-secondary dark:bg-surface-secondary-dark/30">
            <div className="flex items-center gap-2">
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={onBack}
                    disabled={!canGoBack}
                    aria-label="Back"
                >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Back
                </Button>
                {showRefresh ? (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={onRefresh}
                        loading={refreshing}
                        aria-label="Refresh status"
                    >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Refresh
                    </Button>
                ) : null}
            </div>
            <span className="text-xs text-text-muted dark:text-text-muted-dark tabular-nums">
                Step {stepIndex + 1} of {totalSteps}
            </span>
            <div className="flex items-center gap-2">
                {showSkip ? (
                    <Button variant="ghost" size="sm" onClick={onSkip}>
                        {skipLabel}
                    </Button>
                ) : null}
                {showNext ? (
                    <Button variant="primary" size="sm" onClick={onNext}>
                        {nextLabel}
                        <ArrowRight className="h-3.5 w-3.5" />
                    </Button>
                ) : null}
            </div>
        </div>
    );
}
