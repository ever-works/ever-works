import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InboxSourceFilter, InboxTabs, inboxSourceHref } from './InboxTabs';

/**
 * Self-build slice AU — the Inbox's "From your fleet" filter. It is a pair
 * of links, not client state, so a filtered Inbox is linkable and the 30s
 * poll (a refresh of the same URL) keeps it; the view (Active / Archived)
 * survives switching the filter either way.
 */

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

vi.mock('@/components/ui/button', () => ({
    Button: ({
        children,
        href,
        variant,
        size: _size,
        ...props
    }: {
        children: React.ReactNode;
        href: string;
        variant: string;
        size?: string;
    }) => (
        <a href={href} data-variant={variant} {...props}>
            {children}
        </a>
    ),
}));

describe('inboxSourceHref', () => {
    it('keeps the view and adds the filter only when asked', () => {
        expect(inboxSourceHref('active', false)).toBe('/inbox');
        expect(inboxSourceHref('active', true)).toBe('/inbox?source=fleet');
        expect(inboxSourceHref('archived', false)).toBe('/inbox?view=archived');
        expect(inboxSourceHref('archived', true)).toBe('/inbox?view=archived&source=fleet');
    });
});

describe('InboxSourceFilter', () => {
    it('marks "All" pressed by default and links the fleet view', () => {
        render(<InboxSourceFilter view="active" fleetOnly={false} />);
        const all = screen.getByTestId('inbox-source-all');
        const fleet = screen.getByTestId('inbox-source-fleet');
        expect(all.getAttribute('aria-pressed')).toBe('true');
        expect(fleet.getAttribute('aria-pressed')).toBe('false');
        expect(fleet.getAttribute('href')).toBe('/inbox?source=fleet');
        expect(fleet.textContent).toBe('dashboard.inbox.sourceFilter.fleet');
    });

    it('marks the fleet filter pressed in the archived view and links back to all archived', () => {
        render(<InboxSourceFilter view="archived" fleetOnly />);
        expect(screen.getByTestId('inbox-source-fleet').getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByTestId('inbox-source-all').getAttribute('href')).toBe(
            '/inbox?view=archived',
        );
    });
});

describe('InboxTabs — the fleet filter survives switching views (review)', () => {
    it('keeps `source=fleet` on the Active and Archived tabs, and leaves My Decisions alone', () => {
        render(<InboxTabs view="active" fleetOnly />);
        expect(screen.getByTestId('inbox-tab-active').getAttribute('href')).toBe(
            '/inbox?source=fleet',
        );
        expect(screen.getByTestId('inbox-tab-archived').getAttribute('href')).toBe(
            '/inbox?view=archived&source=fleet',
        );
        expect(screen.getByTestId('inbox-tab-decisions').getAttribute('href')).not.toContain(
            'source=',
        );
    });

    it('builds the plain links without the filter', () => {
        render(<InboxTabs view="archived" />);
        expect(screen.getByTestId('inbox-tab-active').getAttribute('href')).toBe('/inbox');
        expect(screen.getByTestId('inbox-tab-archived').getAttribute('href')).toBe(
            '/inbox?view=archived',
        );
    });
});
