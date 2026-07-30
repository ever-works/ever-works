import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { MemoryConsolidationSettings } from './MemoryConsolidationSettings';

/**
 * Scheduled Memory Consolidation settings panel.
 *
 * The behaviour worth pinning is the failure path. This control writes
 * the column the scheduler selects on, so a save that appears to succeed
 * but stored nothing leaves the user believing consolidation is on when
 * it is not — the same class of silent wrongness the underlying feature
 * had before it was configurable at all.
 */

const SETTINGS = {
    enabled: false,
    cadence: 'weekly',
    mode: 'dry-run',
    notify: true,
    lastRunAt: null,
};

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
    return vi.fn((url: string, init?: RequestInit) => {
        const result = handler(url, init) as { ok: boolean; json?: () => unknown };
        return Promise.resolve({
            ok: result.ok,
            json: () => Promise.resolve(result.json ? result.json() : {}),
        });
    });
}

describe('MemoryConsolidationSettings', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    beforeEach(() => {
        vi.stubGlobal('fetch', mockFetch(() => ({ ok: true, json: () => SETTINGS })));
    });

    it('renders nothing until the current settings are known', () => {
        // Showing controls before the state is read would display defaults
        // as if they were the stored configuration.
        vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
        const { container } = render(<MemoryConsolidationSettings />);
        expect(container.firstChild).toBeNull();
    });

    it('sends only the field that changed', async () => {
        const fetchMock = mockFetch((url, init) =>
            init?.method === 'PUT'
                ? { ok: true, json: () => ({ ...SETTINGS, enabled: true }) }
                : { ok: true, json: () => SETTINGS },
        );
        vi.stubGlobal('fetch', fetchMock);

        render(<MemoryConsolidationSettings />);
        const toggle = await screen.findByTestId('memory-schedule-enabled');
        fireEvent.click(toggle);

        await waitFor(() => {
            const put = fetchMock.mock.calls.find(
                (c) => (c[1] as RequestInit | undefined)?.method === 'PUT',
            );
            expect(put).toBeTruthy();
            // A partial patch, so flipping the switch cannot clobber
            // cadence or mode.
            expect(JSON.parse((put![1] as RequestInit).body as string)).toEqual({ enabled: true });
        });
    });

    it('rolls back when the save fails, so a failed write never reads as success', async () => {
        const fetchMock = mockFetch((url, init) =>
            init?.method === 'PUT'
                ? { ok: false, json: () => ({}) }
                : { ok: true, json: () => SETTINGS },
        );
        vi.stubGlobal('fetch', fetchMock);

        render(<MemoryConsolidationSettings />);
        const toggle = (await screen.findByTestId('memory-schedule-enabled')) as HTMLInputElement;
        expect(toggle.checked).toBe(false);

        fireEvent.click(toggle);

        // Optimistically true for a moment, then restored once the write
        // is known to have failed.
        await waitFor(() => {
            const current = screen.getByTestId('memory-schedule-enabled') as HTMLInputElement;
            expect(current.checked).toBe(false);
        });
    });

    it('rolls back when the request throws', async () => {
        const fetchMock = vi.fn((url: string, init?: RequestInit) => {
            if (init?.method === 'PUT') return Promise.reject(new Error('offline'));
            return Promise.resolve({ ok: true, json: () => Promise.resolve(SETTINGS) });
        });
        vi.stubGlobal('fetch', fetchMock);

        render(<MemoryConsolidationSettings />);
        const toggle = (await screen.findByTestId('memory-schedule-enabled')) as HTMLInputElement;
        fireEvent.click(toggle);

        await waitFor(() => {
            const current = screen.getByTestId('memory-schedule-enabled') as HTMLInputElement;
            expect(current.checked).toBe(false);
        });
    });
});
