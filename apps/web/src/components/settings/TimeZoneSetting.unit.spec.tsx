import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../../../messages/en.json';

const setProfileTimezone = vi.fn();
vi.mock('@/app/actions/notification-preferences', () => ({
    setProfileTimezone: (zone: string) => setProfileTimezone(zone),
}));

import { TimeZoneSetting } from './TimeZoneSetting';

function renderSetting(timezone: string | null) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <TimeZoneSetting timezone={timezone} />
        </NextIntlClientProvider>,
    );
}

const radio = (value: 'local' | 'utc') =>
    screen.getByTestId(`profile-timezone-${value}`).querySelector('input')!;

/**
 * Make `Intl.DateTimeFormat().resolvedOptions().timeZone` answer `zone`.
 *
 * Only `resolvedOptions` is replaced; the rest of the `Intl.DateTimeFormat`
 * instance is the real one, so `next-intl`'s own formatting still works.
 */
function pinBrowserZone(zone: string): void {
    const real = Intl.DateTimeFormat;
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(((...args: unknown[]) => {
        const formatter = new (real as unknown as new (...a: unknown[]) => Intl.DateTimeFormat)(
            ...args,
        );
        const resolved = formatter.resolvedOptions.bind(formatter);
        formatter.resolvedOptions = () => ({ ...resolved(), timeZone: zone });
        return formatter;
    }) as unknown as typeof Intl.DateTimeFormat);
}

/**
 * The browser zone this suite pretends to be in.
 *
 * `TimeZoneSetting` reads the REAL host zone through
 * `Intl.DateTimeFormat().resolvedOptions().timeZone`, which made two of the
 * cases below pass or fail depending on where they ran. CI run 35591005499
 * caught it: the self-hosted runners are on **UTC**, so `browserZone` was
 * `'UTC'`, the component's `modeOf('UTC')` correctly answered `'utc'`, and
 * "saves the browser zone when local time is picked" asserted the `local`
 * radio was checked when the product had every right to check `utc`. The
 * product was right and the test was not hermetic.
 *
 * Pinning it here makes every case deterministic on any machine. The real
 * UTC-browser behaviour is not swept away — it gets its own case at the end of
 * this file, which is the one that actually describes what a person in London
 * sees.
 */
const PINNED_BROWSER_ZONE = 'Europe/Kyiv';

describe('TimeZoneSetting (owner 2026-09-18 — replaces the "Times shown in UTC." note)', () => {
    beforeEach(() => {
        setProfileTimezone.mockReset();
        pinBrowserZone(PINNED_BROWSER_ZONE);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('offers exactly the two choices a person makes: my local time, or UTC', () => {
        renderSetting(null);

        const group = screen.getByTestId('profile-timezone');
        expect(group).toBeInTheDocument();
        expect(within(group).getAllByRole('radio')).toHaveLength(2);
        expect(
            within(screen.getByTestId('profile-timezone-local')).getByText('My local time'),
        ).toBeInTheDocument();
        expect(
            within(screen.getByTestId('profile-timezone-utc')).getByText('UTC'),
        ).toBeInTheDocument();
    });

    it('reads the stored zone back into the choice', () => {
        const { unmount } = renderSetting('UTC');
        expect(radio('utc')).toBeChecked();
        expect(radio('local')).not.toBeChecked();
        expect(screen.getByTestId('profile-timezone-current')).toHaveTextContent(
            'Times are shown in UTC.',
        );
        unmount();

        renderSetting('Europe/Kyiv');
        expect(radio('local')).toBeChecked();
        expect(radio('utc')).not.toBeChecked();
        expect(screen.getByTestId('profile-timezone-current')).toHaveTextContent(
            'Times are shown in Europe/Kyiv.',
        );
    });

    it('says so plainly when nothing has ever been chosen', () => {
        renderSetting(null);

        expect(radio('local')).not.toBeChecked();
        expect(radio('utc')).not.toBeChecked();
        expect(screen.getByTestId('profile-timezone-current')).toHaveTextContent(
            'No time zone chosen yet — times are shown in UTC.',
        );
    });

    it('saves the browser zone when local time is picked, and keeps it on success', async () => {
        const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        setProfileTimezone.mockResolvedValue({ success: true, data: { timezone: browserZone } });
        renderSetting(null);

        radio('local').click();

        await waitFor(() => expect(setProfileTimezone).toHaveBeenCalledWith(browserZone));
        await waitFor(() => expect(radio('local')).toBeChecked());
        expect(screen.getByTestId('profile-timezone-current')).toHaveTextContent(
            `Times are shown in ${browserZone}.`,
        );
    });

    it('checks UTC — not "local" — when the browser itself is in UTC', async () => {
        // The case the CI runners actually exercise, and the reason the suite is
        // pinned above. A person in London who picks "My local time" stores
        // `UTC`, and `modeOf('UTC')` is `'utc'` by design (`TimeZoneSetting.tsx`
        // FIXED_ZONES) — so the UTC row is the honest one to check. Asserting
        // `local` here would be asserting a bug.
        pinBrowserZone('UTC');
        setProfileTimezone.mockResolvedValue({ success: true, data: { timezone: 'UTC' } });
        renderSetting(null);

        radio('local').click();

        await waitFor(() => expect(setProfileTimezone).toHaveBeenCalledWith('UTC'));
        await waitFor(() => expect(radio('utc')).toBeChecked());
        expect(radio('local')).not.toBeChecked();
    });

    it('saves the fixed clock when UTC is picked', async () => {
        setProfileTimezone.mockResolvedValue({ success: true, data: { timezone: 'UTC' } });
        renderSetting('Europe/Kyiv');

        radio('utc').click();

        await waitFor(() => expect(setProfileTimezone).toHaveBeenCalledWith('UTC'));
        await waitFor(() => expect(radio('utc')).toBeChecked());
    });

    it('keeps the previous choice and says why when the save fails', async () => {
        setProfileTimezone.mockResolvedValue({ success: false, error: 'Failed to save' });
        renderSetting('Europe/Kyiv');

        radio('utc').click();

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Failed to save'));
        expect(radio('local')).toBeChecked();
        expect(screen.getByTestId('profile-timezone-current')).toHaveTextContent(
            'Times are shown in Europe/Kyiv.',
        );
    });

    /**
     * e2e run 36135997693: /settings threw React hydration error #418 because the
     * server rendered the hint with ITS zone (UTC in production) and the browser
     * hydrated with its own. The server render must not name any browser zone.
     */
    it('renders no browser zone on the server, so hydration cannot mismatch', () => {
        const html = renderToString(
            <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
                <TimeZoneSetting timezone="Europe/Kyiv" />
            </NextIntlClientProvider>,
        );

        // The stored zone is server data and may appear; the local-time HINT may not.
        expect(html).toContain('My local time');
        expect(html).not.toMatch(/<span[^>]*>Europe\/Kyiv<\/span>/);
    });

    it('shows the browser zone as the hint once mounted on the client', () => {
        renderSetting(null);

        expect(
            within(screen.getByTestId('profile-timezone-local')).getByText(PINNED_BROWSER_ZONE),
        ).toBeInTheDocument();
    });
});
