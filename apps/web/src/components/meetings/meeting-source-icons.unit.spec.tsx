import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { MeetingSourceIcon } from './meeting-source-icons';
import { SourceBadge, sourceIconMap } from './meeting-ui';
import { MEETING_SOURCES } from '@/lib/api/meetings.shared';

/**
 * Meeting source marks — every producing surface must render one, and the
 * vendor surfaces must be told apart by more than their label.
 *
 * The `Select` primitive only reserves the leading icon column when its
 * `iconMap` has a hit for the option's `data-icon`, so a source missing
 * from the map does not merely lose its mark — it pulls that row's label
 * out of line with the rest of the list. Hence the completeness check.
 */

/** Fill colours of the badge plate, in document order. */
function markFills(): string[] {
    const icon = screen.getByTestId('meeting-source-icon');
    return Array.from(icon.querySelectorAll('rect[fill], path[fill]')).map(
        (node) => node.getAttribute('fill') ?? '',
    );
}

describe('MeetingSourceIcon', () => {
    it('renders a mark for every source the API can return', () => {
        for (const source of MEETING_SOURCES) {
            const { unmount } = render(<MeetingSourceIcon source={source} />);
            expect(screen.getByTestId('meeting-source-icon'), source).toBeTruthy();
            unmount();
        }
    });

    it('falls back to a neutral mark for a source it has never seen', () => {
        // The API's source set is closed today, but a new provider must not
        // render a hole where the mark goes.
        render(<MeetingSourceIcon source="teams" />);
        expect(screen.getByTestId('meeting-source-icon')).toBeTruthy();
    });

    it('draws zoom and google-meet in their own brand colours', () => {
        const { unmount } = render(<MeetingSourceIcon source="zoom" />);
        const zoom = markFills();
        unmount();

        render(<MeetingSourceIcon source="google-meet" />);
        const meet = markFills();

        expect(zoom).toContain('#0B5CFF');
        expect(meet).toContain('#00832D');
        // Same silhouette family, but never the same plate — the two video
        // surfaces have to be distinguishable at 12px without reading.
        expect(zoom).not.toEqual(meet);
    });

    it('honours the requested size', () => {
        render(<MeetingSourceIcon source="zoom" size={14} />);
        const svg = screen.getByTestId('meeting-source-icon').querySelector('svg');
        expect(svg?.getAttribute('width')).toBe('14');
    });
});

describe('SourceBadge', () => {
    it('shows the mark next to the translated label', () => {
        render(<SourceBadge source="zoom" />);
        const badge = screen.getByTestId('meeting-source-badge');
        expect(badge.querySelector('[data-testid="meeting-source-icon"]')).toBeTruthy();
        expect(badge.textContent).toContain('sources.zoom');
    });

    it('still labels an unknown source verbatim, with a mark', () => {
        render(<SourceBadge source="teams" />);
        const badge = screen.getByTestId('meeting-source-badge');
        expect(badge.textContent).toContain('teams');
        expect(badge.querySelector('[data-testid="meeting-source-icon"]')).toBeTruthy();
    });
});

describe('sourceIconMap', () => {
    it('covers every source the pickers list', () => {
        const map = sourceIconMap(MEETING_SOURCES);
        for (const source of MEETING_SOURCES) {
            expect(map[source], `${source} has no icon`).toBeTruthy();
        }
    });
});
