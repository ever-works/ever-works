'use client';

import { ChoiceCardGrid } from '../ChoiceCardGrid';
import type { OnboardingCard } from '@ever-works/contracts/api';

export interface ChoiceStepProps<Choice extends string> {
    readonly title: string;
    readonly description: string;
    readonly cards: ReadonlyArray<OnboardingCard<Choice>>;
    readonly selected: Choice;
    readonly columns?: 2 | 3;
    readonly icons?: Partial<Record<Choice, React.ReactNode>>;
    readonly onSelect: (choice: Choice) => void;
    readonly onPlannedClick?: (choice: Choice) => void;
}

/**
 * Generic header + grid layout used by the AI / Storage / Deploy choice
 * steps. Kept dumb on purpose — the parent owns selection state and
 * forwards events.
 */
export function ChoiceStep<Choice extends string>({
    title,
    description,
    cards,
    selected,
    columns,
    icons,
    onSelect,
    onPlannedClick,
}: ChoiceStepProps<Choice>) {
    return (
        <div className="space-y-6 max-w-3xl">
            <header>
                <h3 className="text-lg font-semibold text-text dark:text-text-dark">{title}</h3>
                <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                    {description}
                </p>
            </header>
            <ChoiceCardGrid
                cards={cards}
                selected={selected}
                columns={columns}
                icons={icons}
                onSelect={onSelect}
                onPlannedClick={onPlannedClick}
            />
        </div>
    );
}
