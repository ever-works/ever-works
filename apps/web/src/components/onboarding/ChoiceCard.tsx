'use client';

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { OnboardingCardBadge } from '@ever-works/contracts/api';

export interface ChoiceCardProps {
    readonly title: string;
    readonly description: string;
    readonly selected: boolean;
    readonly available: boolean;
    readonly badges: ReadonlyArray<OnboardingCardBadge>;
    readonly icon?: React.ReactNode;
    readonly onSelect: () => void;
}

const BADGE_LABEL: Record<OnboardingCardBadge, string> = {
    default: 'Default',
    byok: 'BYOK',
    planned: 'Coming soon',
};

const BADGE_CLASSES: Record<OnboardingCardBadge, string> = {
    default:
        'bg-primary/10 text-primary dark:bg-primary/20 dark:text-primary-foreground border-primary/30',
    byok: 'bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary dark:text-text-secondary-dark border-border dark:border-border-dark',
    planned:
        'bg-warning/10 text-warning border-warning/30 dark:bg-warning/20 dark:text-warning-foreground',
};

/**
 * A single radio-style choice card used inside the onboarding wizard's
 * choice steps (AI / Storage / Deploy). Planned cards are visually
 * disabled and ignore selection — the consumer suppresses `onSelect` for
 * them and emits a `planned_card_clicked` telemetry event instead.
 */
export function ChoiceCard({
    title,
    description,
    selected,
    available,
    badges,
    icon,
    onSelect,
}: ChoiceCardProps) {
    const disabled = !available;

    return (
        <button
            type="button"
            onClick={onSelect}
            disabled={disabled}
            aria-pressed={selected}
            className={cn(
                'group relative w-full text-left rounded-xl border bg-surface dark:bg-surface-dark p-4 transition-all',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                disabled
                    ? 'opacity-60 cursor-not-allowed border-border dark:border-border-dark'
                    : 'cursor-pointer hover:border-primary/40 hover:bg-surface-secondary/40 dark:hover:bg-white/5',
                selected
                    ? 'border-primary ring-1 ring-primary/40 shadow-sm'
                    : 'border-border dark:border-border-dark',
            )}
        >
            <div className="flex items-start gap-3">
                {icon ? (
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-secondary dark:bg-white/5">
                        {icon}
                    </div>
                ) : null}
                <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                        <h4 className="text-sm font-semibold text-text dark:text-text-dark truncate">
                            {title}
                        </h4>
                        {selected ? (
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-white">
                                <Check className="h-3 w-3" />
                            </span>
                        ) : null}
                    </div>
                    <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark leading-relaxed">
                        {description}
                    </p>
                    {badges.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                            {badges.map((badge) => (
                                <span
                                    key={badge}
                                    className={cn(
                                        'inline-flex items-center text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded border',
                                        BADGE_CLASSES[badge],
                                    )}
                                >
                                    {BADGE_LABEL[badge]}
                                </span>
                            ))}
                        </div>
                    ) : null}
                </div>
            </div>
        </button>
    );
}
