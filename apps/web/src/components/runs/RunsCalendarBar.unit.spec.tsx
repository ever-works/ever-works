import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunLedgerWindow } from '@ever-works/contracts';
import { RunsCalendarBar, formatWindowLabel } from './RunsCalendarBar';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
    useLocale: () => 'en-GB',
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

/**
 * Runs ledger (AW-09) — the calendar controls. Every shortcut has an
 * on-screen twin, the timezone in force is stated, the reach clamp is
 * announced rather than applied silently, and the window label is built
 * from calendar dates so it never drifts with the machine's timezone.
 */

function window(over: Partial<RunLedgerWindow> = {}): RunLedgerWindow {
    return {
        granularity: 'day',
        anchorDate: '2026-09-08',
        from: '2026-09-07T15:00:00.000Z',
        to: '2026-09-08T15:00:00.000Z',
        timezone: 'Asia/Tokyo',
        clamped: false,
        ...over,
    };
}

function renderBar(over: Partial<React.ComponentProps<typeof RunsCalendarBar>> = {}) {
    const props = {
        window: window(),
        granularity: 'day' as const,
        onGranularityChange: vi.fn(),
        onStep: vi.fn(),
        onToday: vi.fn(),
        onShowShortcuts: vi.fn(),
        ...over,
    };
    render(<RunsCalendarBar {...props} />);
    return props;
}

describe('RunsCalendarBar', () => {
    it('steps back and forward one window, and jumps to today', async () => {
        const props = renderBar();
        const user = userEvent.setup();

        await user.click(screen.getByRole('button', { name: 'previousWindow' }));
        await user.click(screen.getByRole('button', { name: 'nextWindow' }));
        await user.click(screen.getByRole('button', { name: 'today' }));

        expect(props.onStep).toHaveBeenNthCalledWith(1, -1);
        expect(props.onStep).toHaveBeenNthCalledWith(2, 1);
        expect(props.onToday).toHaveBeenCalledTimes(1);
    });

    it('offers Day, Week and Month with the active one pressed', async () => {
        const props = renderBar({ granularity: 'week', window: window({ granularity: 'week' }) });
        const user = userEvent.setup();

        expect(screen.getByTestId('runs-granularity-week').getAttribute('aria-pressed')).toBe(
            'true',
        );
        expect(screen.getByTestId('runs-granularity-day').getAttribute('aria-pressed')).toBe(
            'false',
        );
        await user.click(screen.getByTestId('runs-granularity-month'));

        expect(props.onGranularityChange).toHaveBeenCalledWith('month');
    });

    it('states the timezone every time on the page is shown in', () => {
        renderBar();
        expect(screen.getByTestId('runs-timezone').textContent).toBe(
            'timezoneNote:{"timezone":"Asia/Tokyo"}',
        );
    });

    it('announces a clamped window instead of moving it silently', () => {
        renderBar({ window: window({ clamped: true }) });
        expect(screen.getByTestId('runs-clamped-notice').textContent).toBe('clampedNotice');
    });

    it('shows no clamp notice for a window inside the reach', () => {
        renderBar();
        expect(screen.queryByTestId('runs-clamped-notice')).toBeNull();
    });

    it('opens the shortcut sheet from an on-screen control', async () => {
        const props = renderBar();
        await userEvent.setup().click(screen.getByRole('button', { name: 'shortcuts.button' }));
        expect(props.onShowShortcuts).toHaveBeenCalledTimes(1);
    });

    describe('formatWindowLabel', () => {
        it('labels a day, a Monday-to-Sunday week and a month from calendar dates', () => {
            // Punctuation varies across ICU versions; the calendar facts must not.
            expect(formatWindowLabel(window(), 'en-GB')).toMatch(/^Tuesday,? 8 September 2026$/);
            expect(
                formatWindowLabel(
                    window({ granularity: 'week', anchorDate: '2026-09-10' }),
                    'en-GB',
                ),
            ).toMatch(/^7\s?[–-]\s?13 September 2026$/);
            expect(formatWindowLabel(window({ granularity: 'month' }), 'en-GB')).toBe(
                'September 2026',
            );
        });
    });
});
