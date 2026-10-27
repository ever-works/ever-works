import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FleetNodeView } from '@ever-works/contracts';

const { saveMock } = vi.hoisted(() => ({ saveMock: vi.fn() }));

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${JSON.stringify(values)}` : key,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/actions/settings/fleet', () => ({
    setFleetNodeDesktopRecordingSettingsAction: saveMock,
}));

import { DesktopRecordingSettings } from './DesktopRecordingSettings';

/** FL-07 P3: the owner's recording settings — each change saves exactly that setting. */
const node = (extra: Partial<FleetNodeView> = {}) =>
    ({
        id: 'node-1',
        name: 'studio',
        recordWatchSessions: false,
        recordingRetentionDays: 14,
        ...extra,
    }) as FleetNodeView;

describe('DesktopRecordingSettings', () => {
    afterEach(() => {
        cleanup();
        saveMock.mockReset();
    });

    it('turns on recording watching sessions', async () => {
        saveMock.mockResolvedValue({ success: true, data: null, error: null });
        render(<DesktopRecordingSettings node={node()} />);
        fireEvent.click(screen.getByTestId('fleet-desktop-record-watch-toggle'));
        await waitFor(() =>
            expect(saveMock).toHaveBeenCalledWith('node-1', { recordWatchSessions: true }),
        );
    });

    it('saves a new retention and puts the old one back when the save is refused', async () => {
        saveMock.mockResolvedValue({ success: false, data: null, error: 'nope' });
        render(<DesktopRecordingSettings node={node({ recordingRetentionDays: 21 })} />);
        const select = screen.getByTestId('fleet-desktop-recording-retention') as HTMLSelectElement;
        expect(select.value).toBe('21');
        fireEvent.change(select, { target: { value: '30' } });
        await waitFor(() =>
            expect(saveMock).toHaveBeenCalledWith('node-1', { recordingRetentionDays: 30 }),
        );
        await waitFor(() => expect(select.value).toBe('21'));
    });
});
