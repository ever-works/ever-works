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
        const buttons = screen.getAllByRole('button');
        expect(buttons).toHaveLength(11);
        const active = buttons.find((b) => b.getAttribute('aria-pressed') === 'true');
        expect(active).toBeDefined();
        expect(active?.textContent).toBe('generation');
    });

    it('calls onChange with the clicked category', async () => {
        const onChange = vi.fn();
        render(<FeedFilterChips value="all" onChange={onChange} />);
        const usersChip = screen.getByRole('button', { name: 'users' });
        await userEvent.click(usersChip);
        expect(onChange).toHaveBeenCalledWith('users');
    });

    it('disables directory-site chips when directorySiteDisabled is true', () => {
        // Phase 5 (EW-120 dual-mode): when pull-mode sync is permanently
        // broken (disabled / not_provisioned), the website-only chips
        // (users/submissions/reports) get dimmed so the user doesn't click
        // into empty tabs.
        render(<FeedFilterChips value="all" onChange={() => undefined} directorySiteDisabled />);
        const dimmed = ['users', 'submissions', 'reports'];
        for (const cat of dimmed) {
            const chip = screen.getByRole('button', { name: cat });
            expect(chip.className).toContain('opacity-50');
            expect(chip).toBeDisabled();
        }
        // Non-directory chips are not dimmed.
        const platform = screen.getByRole('button', { name: 'deployment' });
        expect(platform.className).not.toContain('opacity-50');
    });
});
