import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { ChangelogCategory } from '@ever-works/contracts/api';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { ChangelogFilterChips } from './ChangelogFilterChips';

function Controlled({
    categoriesWithEntries,
    onChange,
}: {
    categoriesWithEntries: ChangelogCategory[] | null;
    onChange?: (value: ChangelogCategory | null) => void;
}) {
    const [value, setValue] = useState<ChangelogCategory | null>(null);
    return (
        <ChangelogFilterChips
            value={value}
            onChange={(next) => {
                setValue(next);
                onChange?.(next);
            }}
            categoriesWithEntries={categoriesWithEntries}
        />
    );
}

/**
 * What's new (AW-14) — the filter row: All plus six areas, one selected, a
 * single tab stop, and areas with nothing to show disabled rather than
 * hidden (spec FR-33, FR-34, FR-37, FR-52).
 */
describe('ChangelogFilterChips', () => {
    it('FR-33/FR-34: renders seven chips with All selected by default', () => {
        render(<Controlled categoriesWithEntries={null} />);

        expect(screen.getAllByRole('radio')).toHaveLength(7);
        expect(screen.getByTestId('whats-new-filter-all')).toHaveAttribute('aria-checked', 'true');
    });

    it('FR-52: the row is a single tab stop on the selected chip', () => {
        render(<Controlled categoriesWithEntries={null} />);

        const tabbable = screen.getAllByRole('radio').filter((chip) => chip.tabIndex === 0);
        expect(tabbable).toEqual([screen.getByTestId('whats-new-filter-all')]);
    });

    it('FR-37: a category without entries is disabled with its tooltip, never hidden', () => {
        render(<Controlled categoriesWithEntries={['agents', 'platform']} />);

        const knowledge = screen.getByTestId('whats-new-filter-knowledge');
        expect(knowledge).toBeDisabled();
        expect(knowledge).toHaveAttribute('title', 'filters.emptyTooltip');
        expect(screen.getByTestId('whats-new-filter-agents')).toBeEnabled();
    });

    it('FR-52: → and ← move between enabled chips, selection follows focus, and wrap', () => {
        const onChange = vi.fn();
        render(<Controlled categoriesWithEntries={['agents', 'platform']} onChange={onChange} />);

        fireEvent.keyDown(screen.getByTestId('whats-new-filter-all'), { key: 'ArrowRight' });
        expect(onChange).toHaveBeenLastCalledWith('agents');
        expect(screen.getByTestId('whats-new-filter-agents')).toHaveFocus();
        expect(screen.getByTestId('whats-new-filter-agents')).toHaveAttribute(
            'aria-checked',
            'true',
        );

        // Skips the four disabled areas between agents and platform.
        fireEvent.keyDown(screen.getByTestId('whats-new-filter-agents'), { key: 'ArrowRight' });
        expect(onChange).toHaveBeenLastCalledWith('platform');

        fireEvent.keyDown(screen.getByTestId('whats-new-filter-platform'), { key: 'ArrowRight' });
        expect(onChange).toHaveBeenLastCalledWith(null);

        fireEvent.keyDown(screen.getByTestId('whats-new-filter-all'), { key: 'ArrowLeft' });
        expect(onChange).toHaveBeenLastCalledWith('platform');
    });

    it('selects on click and ignores a click on a disabled chip', () => {
        const onChange = vi.fn();
        render(<Controlled categoriesWithEntries={['costs']} onChange={onChange} />);

        fireEvent.click(screen.getByTestId('whats-new-filter-decisions'));
        expect(onChange).not.toHaveBeenCalled();

        fireEvent.click(screen.getByTestId('whats-new-filter-costs'));
        expect(onChange).toHaveBeenCalledWith('costs');
    });
});
