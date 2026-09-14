'use client';

import { useRef, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { CHANGELOG_CATEGORIES, type ChangelogCategory } from '@ever-works/contracts/api';
import { cn } from '@/lib/utils/cn';

interface ChangelogFilterChipsProps {
    /** `null` is the All chip. */
    value: ChangelogCategory | null;
    onChange: (value: ChangelogCategory | null) => void;
    /**
     * Categories with at least one visible entry. The rest render DISABLED,
     * not hidden (spec FR-37). `null` while unknown — every chip is enabled.
     */
    categoriesWithEntries: readonly ChangelogCategory[] | null;
}

type ChipValue = ChangelogCategory | null;

const CHIPS: readonly ChipValue[] = [null, ...CHANGELOG_CATEGORIES];

/**
 * What's new (AW-14) — `All` plus the six product areas, exactly one
 * selected (spec FR-33, FR-34).
 *
 * The row is a single tab stop with a roving tabindex: ←/→ move between the
 * enabled chips and selection follows focus; Enter/Space also select, for
 * assistive tech that does not follow focus (spec FR-52). A category with no
 * entry in this build is disabled with an explanatory tooltip, never hidden
 * (spec FR-37). Filtering never changes the unread badge (spec FR-38) — that
 * is the caller's contract, since the list response's count is unfiltered.
 */
export function ChangelogFilterChips({
    value,
    onChange,
    categoriesWithEntries,
}: ChangelogFilterChipsProps) {
    const t = useTranslations('dashboard.whatsNew');
    const buttons = useRef(new Map<string, HTMLButtonElement>());

    const keyOf = (chip: ChipValue) => chip ?? 'all';
    const isEnabled = (chip: ChipValue) =>
        chip === null || categoriesWithEntries === null || categoriesWithEntries.includes(chip);

    const select = (chip: ChipValue) => {
        if (!isEnabled(chip)) {
            return;
        }
        onChange(chip);
        buttons.current.get(keyOf(chip))?.focus();
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') {
            return;
        }
        event.preventDefault();
        const step = event.key === 'ArrowRight' ? 1 : -1;
        for (let offset = 1; offset <= CHIPS.length; offset += 1) {
            const candidate = CHIPS[(index + step * offset + CHIPS.length) % CHIPS.length];
            if (isEnabled(candidate)) {
                select(candidate);
                return;
            }
        }
    };

    return (
        <div
            role="radiogroup"
            aria-label={t('filters.label')}
            data-testid="whats-new-filters"
            className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
        >
            {CHIPS.map((chip, index) => {
                const selected = chip === value;
                const enabled = isEnabled(chip);
                const label = chip === null ? t('filters.all') : t(`filters.${chip}`);
                return (
                    <button
                        key={keyOf(chip)}
                        ref={(element) => {
                            if (element) {
                                buttons.current.set(keyOf(chip), element);
                            } else {
                                buttons.current.delete(keyOf(chip));
                            }
                        }}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-disabled={!enabled || undefined}
                        disabled={!enabled}
                        tabIndex={selected ? 0 : -1}
                        title={enabled ? undefined : t('filters.emptyTooltip')}
                        data-testid={`whats-new-filter-${keyOf(chip)}`}
                        onClick={() => select(chip)}
                        onKeyDown={(event) => handleKeyDown(event, index)}
                        className={cn(
                            'shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                            selected
                                ? 'border-primary bg-primary/10 text-text dark:text-text-dark'
                                : 'border-border text-text-secondary hover:text-text dark:border-border-dark dark:text-text-secondary-dark dark:hover:text-text-dark',
                            !enabled && 'cursor-not-allowed opacity-50 hover:text-text-secondary',
                        )}
                    >
                        {label}
                    </button>
                );
            })}
        </div>
    );
}
