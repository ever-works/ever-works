// MeetingsList — the two chromes the catalog renders in: the standalone
// page (`variant="page"`, PageHeader + h1) it has always had, and the
// card-in-a-page panel the Memory page embeds (`variant="panel"`, no h1,
// every href rebased onto `/memory…#meetings`).

import React, { type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

vi.mock('./MeetingCard', () => ({
    MeetingCard: () => <div data-testid="meeting-card" />,
}));

import { MeetingsList } from './MeetingsList';
import type { Meeting } from '@/lib/api/meetings';

const meeting = {
    id: 'meet-1',
    title: 'Weekly sync',
    source: 'manual',
    startedAt: '2026-08-01T10:00:00.000Z',
    endedAt: null,
    hasTranscript: false,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
} as unknown as Meeting;

describe('MeetingsList — panel variant', () => {
    it('drops the PageHeader h1 and wraps the catalog in an anchored card', () => {
        const { container } = render(
            <MeetingsList
                meetings={[meeting]}
                variant="panel"
                basePath="/memory"
                hash="#meetings"
            />,
        );

        expect(container.querySelector('h1')).toBeNull();
        expect(container.querySelector('h2')).not.toBeNull();

        const shell = screen.getByTestId('meetings-shell');
        expect(shell.getAttribute('id')).toBe('meetings');
        expect(screen.getByTestId('meetings-grid')).not.toBeNull();
    });

    it('rebases the filter form and the reset link onto the host page', () => {
        const { container } = render(
            <MeetingsList
                meetings={[meeting]}
                variant="panel"
                basePath="/memory"
                hash="#meetings"
            />,
        );

        expect(container.querySelector('form')?.getAttribute('action')).toBe('/memory#meetings');
        const reset = screen.getByText('filterBar.reset').closest('a');
        expect(reset?.getAttribute('href')).toBe('/memory#meetings');
    });

    it('renders the optional host-page hint', () => {
        render(
            <MeetingsList
                meetings={[meeting]}
                variant="panel"
                basePath="/memory"
                hash="#meetings"
                hint="Meetings feed Memory."
            />,
        );
        expect(screen.getByTestId('meetings-panel-hint').textContent).toBe('Meetings feed Memory.');
    });

    it('keeps the load-error box instead of the grid when the fetch failed', () => {
        render(
            <MeetingsList
                meetings={[]}
                variant="panel"
                basePath="/memory"
                hash="#meetings"
                loadError="boom"
            />,
        );
        expect(screen.getByTestId('meetings-load-error')).not.toBeNull();
        expect(screen.queryByTestId('meetings-empty')).toBeNull();
        expect(screen.queryByTestId('meetings-grid')).toBeNull();
    });

    it('keeps the empty state when there are zero meetings', () => {
        render(<MeetingsList meetings={[]} variant="panel" basePath="/memory" hash="#meetings" />);
        expect(screen.getByTestId('meetings-empty')).not.toBeNull();
    });
});

describe('MeetingsList — page variant (default)', () => {
    it('keeps the PageHeader h1 and the /meetings hrefs', () => {
        const { container } = render(<MeetingsList meetings={[meeting]} />);

        expect(container.querySelector('h1')).not.toBeNull();
        expect(screen.getByTestId('meetings-shell').getAttribute('id')).toBeNull();
        // A page-variant GET form posts back to the page it is already on.
        expect(container.querySelector('form')?.getAttribute('action')).toBeNull();
        expect(screen.getByText('filterBar.reset').closest('a')?.getAttribute('href')).toBe(
            '/meetings',
        );
    });
});
