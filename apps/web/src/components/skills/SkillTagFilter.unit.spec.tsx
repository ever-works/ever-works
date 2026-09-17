import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, params?: Record<string, string | number>) =>
        params ? `${key}(${Object.values(params).join(',')})` : key,
}));

import { SkillTagFilter, type SkillTagFacetItem } from './SkillTagFilter';

const facets: SkillTagFacetItem[] = Array.from({ length: 16 }, (_, i) => ({
    tag: `tag-${String(i).padStart(2, '0')}`,
    count: 20 - i,
}));

function Harness({
    initial = [],
    onChange,
}: {
    initial?: string[];
    onChange?: (tags: string[]) => void;
}) {
    const [selected, setSelected] = useState<string[]>(initial);
    return (
        <SkillTagFilter
            facets={facets}
            selected={selected}
            onChange={(next) => {
                setSelected(next);
                onChange?.(next);
            }}
        />
    );
}

const chip = (tag: string) =>
    screen
        .getAllByTestId('skill-tag-chip')
        .find((element) => element.getAttribute('data-tag') === tag)!;

describe('SkillTagFilter', () => {
    it('shows the 12 most-used tags with counts, and the rest behind "+N more"', () => {
        render(<Harness />);
        expect(screen.getAllByTestId('skill-tag-chip')).toHaveLength(12);
        expect(screen.getByTestId('skill-tag-more').textContent).toBe('tagsMore(4)');
        expect(chip('tag-00').textContent).toContain('20');
    });

    it('accumulates selection (AND) and shows Clear only when something is selected', () => {
        const onChange = vi.fn();
        render(<Harness onChange={onChange} />);
        expect(screen.queryByTestId('skill-tag-clear')).toBeNull();
        fireEvent.click(chip('tag-00'));
        fireEvent.click(chip('tag-01'));
        expect(onChange).toHaveBeenLastCalledWith(['tag-00', 'tag-01']);
        expect(chip('tag-00').getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(screen.getByTestId('skill-tag-clear'));
        expect(onChange).toHaveBeenLastCalledWith([]);
    });

    it('disables the seventh chip with the limit tooltip once six are selected', () => {
        const onChange = vi.fn();
        const six = facets.slice(0, 6).map((facet) => facet.tag);
        render(<Harness initial={six} onChange={onChange} />);
        const seventh = chip('tag-06');
        expect(seventh.getAttribute('aria-disabled')).toBe('true');
        expect(seventh.getAttribute('title')).toBe('tagsLimitTooltip');
        fireEvent.click(seventh);
        expect(onChange).not.toHaveBeenCalled();
        // A selected chip still deselects at the cap.
        fireEvent.click(chip('tag-00'));
        expect(onChange).toHaveBeenLastCalledWith(six.slice(1));
    });

    it('the overflow panel searches the remaining tags and selects from them', () => {
        const onChange = vi.fn();
        render(<Harness onChange={onChange} />);
        fireEvent.click(screen.getByTestId('skill-tag-more'));
        expect(screen.getAllByTestId('skill-tag-more-option')).toHaveLength(4);
        fireEvent.change(screen.getByPlaceholderText('tagsSearchPlaceholder'), {
            target: { value: '15' },
        });
        const options = screen.getAllByTestId('skill-tag-more-option');
        expect(options).toHaveLength(1);
        fireEvent.click(options[0]);
        expect(onChange).toHaveBeenLastCalledWith(['tag-15']);
        // The selected overflow tag now shows inline so it can be removed.
        expect(chip('tag-15')).toBeTruthy();
        fireEvent.change(screen.getByPlaceholderText('tagsSearchPlaceholder'), {
            target: { value: 'nope' },
        });
        expect(screen.getByText('tagsNoMatch')).toBeTruthy();
    });

    it('roving tabindex: arrows move focus, Backspace deselects', () => {
        const onChange = vi.fn();
        render(<Harness initial={['tag-01']} onChange={onChange} />);
        const first = chip('tag-00');
        expect(first.tabIndex).toBe(0);
        expect(chip('tag-01').tabIndex).toBe(-1);
        first.focus();
        fireEvent.keyDown(first, { key: 'ArrowRight' });
        expect(document.activeElement).toBe(chip('tag-01'));
        expect(chip('tag-01').tabIndex).toBe(0);
        fireEvent.keyDown(chip('tag-01'), { key: 'Backspace' });
        expect(onChange).toHaveBeenLastCalledWith([]);
        fireEvent.keyDown(chip('tag-01'), { key: 'ArrowLeft' });
        expect(document.activeElement).toBe(chip('tag-00'));
        fireEvent.keyDown(chip('tag-00'), { key: 'ArrowLeft' });
        expect(document.activeElement).toBe(chip('tag-11'));
    });

    it('renders nothing when there are no tags and nothing selected', () => {
        const { container } = render(
            <SkillTagFilter facets={[]} selected={[]} onChange={() => undefined} />,
        );
        expect(container.firstChild).toBeNull();
    });
});
