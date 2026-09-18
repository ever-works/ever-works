import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

describe('TimeZoneSetting (owner 2026-09-18 — replaces the "Times shown in UTC." note)', () => {
    beforeEach(() => {
        setProfileTimezone.mockReset();
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
});
