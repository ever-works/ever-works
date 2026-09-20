import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActivityViewHeader } from './ActivityViewHeader';

/**
 * The one heading the Activity page's four views share.
 *
 * It is pinned because it is a CONTRACT, not a layout: the page's `h1` names the
 * page ("Activity"), and each view names itself with a section heading at this
 * weight. A view that grew its own full-size title back would be a second page
 * title for a view the reader has already chosen — which is exactly what the
 * Schedules view had before it adopted this.
 */
describe('ActivityViewHeader', () => {
    it('renders a level-2 heading with its explanatory line', () => {
        render(
            <ActivityViewHeader title="Schedules" subtitle="Everything that runs without you" />,
        );

        const heading = screen.getByRole('heading', { level: 2, name: 'Schedules' });
        // The Live Feed's own weight — a section heading, not a page title.
        expect(heading.className).toContain('text-base');
        expect(heading.className).toContain('font-semibold');
        expect(screen.getByText('Everything that runs without you').className).toContain('text-sm');
    });

    it('never renders a level-1 heading', () => {
        render(<ActivityViewHeader title="Runs" subtitle="Every agent execution" />);
        expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    });

    it('lets a view keep its own aria-labelledby target', () => {
        render(
            <ActivityViewHeader
                titleId="live-feed-title"
                title="Live Feed"
                subtitle="As it happens"
            />,
        );
        expect(screen.getByRole('heading', { level: 2 }).getAttribute('id')).toBe(
            'live-feed-title',
        );
    });

    it('carries the view’s own accent on the title row when it is given one', () => {
        const { rerender } = render(
            <ActivityViewHeader title="Schedules" subtitle="Everything that runs without you" />,
        );
        expect(screen.queryByTestId('accent')).toBeNull();

        rerender(
            <ActivityViewHeader
                title="Schedules"
                subtitle="Everything that runs without you"
                aside={<button data-testid="accent">Create</button>}
            />,
        );
        expect(screen.getByTestId('accent')).toBeTruthy();
        // Same row as the heading, so it reads as belonging to it.
        expect(screen.getByRole('heading', { level: 2 }).closest('div')?.parentElement).toBe(
            screen.getByTestId('activity-view-header'),
        );
    });
});
