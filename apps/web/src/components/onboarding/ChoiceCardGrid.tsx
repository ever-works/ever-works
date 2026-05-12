'use client';

import { ChoiceCard } from './ChoiceCard';
import { cn } from '@/lib/utils/cn';
import type { OnboardingCard } from '@ever-works/contracts/api';

export interface ChoiceCardGridProps<Choice extends string> {
    readonly cards: ReadonlyArray<OnboardingCard<Choice>>;
    readonly selected: Choice;
    readonly columns?: 2 | 3;
    readonly icons?: Partial<Record<Choice, React.ReactNode>>;
    readonly onSelect: (choice: Choice) => void;
    readonly onPlannedClick?: (choice: Choice) => void;
}

/**
 * Grid of `ChoiceCard`s. Forwards selections to `onSelect`; Planned cards
 * are not selectable but emit `onPlannedClick` so the parent can fire
 * telemetry (e.g. `onboarding_planned_card_clicked`).
 */
export function ChoiceCardGrid<Choice extends string>({
    cards,
    selected,
    columns = 2,
    icons,
    onSelect,
    onPlannedClick,
}: ChoiceCardGridProps<Choice>) {
    return (
        <div className={cn('grid gap-3', columns === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
            {cards.map((card) => (
                <ChoiceCard
                    key={card.choice}
                    title={card.title}
                    description={card.description}
                    selected={card.choice === selected}
                    available={card.available}
                    badges={card.badges}
                    icon={icons?.[card.choice]}
                    onSelect={() => {
                        if (!card.available) {
                            onPlannedClick?.(card.choice);
                            return;
                        }
                        onSelect(card.choice);
                    }}
                />
            ))}
        </div>
    );
}
