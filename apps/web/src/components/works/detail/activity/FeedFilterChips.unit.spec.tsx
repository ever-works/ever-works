import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { FeedFilterChips } from './FeedFilterChips';

describe('FeedFilterChips', () => {
    it('renders one chip per category and marks the active one', () => {
        render(<FeedFilterChips value="generation" onChange={() => undefined} />);
        const tabs = screen.getAllByRole('tab');
        expect(tabs).toHaveLength(10);
        const active = tabs.find((b) => b.getAttribute('aria-selected') === 'true');
        expect(active).toBeDefined();
        expect(active?.textContent).toBe('generation');
    });

    it('calls onChange with the clicked category', async () => {
        const onChange = vi.fn();
        render(<FeedFilterChips value="all" onChange={onChange} />);
        const usersChip = screen.getByRole('tab', { name: 'users' });
        await userEvent.click(usersChip);
        expect(onChange).toHaveBeenCalledWith('users');
    });
});
