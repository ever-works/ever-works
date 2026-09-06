import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

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
 *
 * Two distinct faults are pinned below. The scope one (EW-786): these
 * settings are per-Organization, and the BFF route can only derive the
 * Organization from the `x-ever-workspace` selector `browserApiFetch`
 * stamps — a plain `fetch()` read the personal defaults and wrote
 * nothing. And the reporting one: the panel already rolled a failed
 * write back, but said nothing, so the toggle simply flicked back.
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

function selectorsFrom(fetchMock: { mock: { calls: unknown[][] } }): (string | null)[] {
    return fetchMock.mock.calls.map((call) =>
        new Headers((call[1] as RequestInit | undefined)?.headers).get(
            BROWSER_WORKSPACE_SCOPE_HEADER,
        ),
    );
}

describe('MemoryConsolidationSettings', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        window.history.replaceState({}, '', '/');
    });

    beforeEach(() => {
        vi.stubGlobal(
            'fetch',
            mockFetch(() => ({ ok: true, json: () => SETTINGS })),
        );
    });

    it('renders nothing until the current settings are known', () => {
        // Showing controls before the state is read would display defaults
        // as if they were the stored configuration.
        vi.stubGlobal(
            'fetch',
            vi.fn(() => new Promise(() => {})),
        );
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

    it('stamps the visible tab Organization on the read and the write alike', async () => {
        // The settings row is keyed by Organization on the platform side.
        // A read without the selector answers with the personal-scope
        // defaults, which would render as "off, weekly, dry-run" over the
        // top of a schedule that is actually running.
        const fetchMock = mockFetch((url, init) =>
            init?.method === 'PUT'
                ? { ok: true, json: () => ({ ...SETTINGS, enabled: true }) }
                : { ok: true, json: () => SETTINGS },
        );
        vi.stubGlobal('fetch', fetchMock);
        window.history.replaceState({}, '', '/org/ever/memory');

        render(<MemoryConsolidationSettings />);
        fireEvent.click(await screen.findByTestId('memory-schedule-enabled'));

        await waitFor(() => {
            expect(fetchMock.mock.calls.length).toBe(2);
        });
        expect(selectorsFrom(fetchMock)).toEqual(['org:ever', 'org:ever']);
    });

    it('sends the explicit personal selector from an unprefixed route', async () => {
        // Not the same as sending nothing: the route fails closed on an
        // absent selector, so "personal" has to be said out loud.
        const fetchMock = mockFetch(() => ({ ok: true, json: () => SETTINGS }));
        vi.stubGlobal('fetch', fetchMock);
        window.history.replaceState({}, '', '/memory');

        render(<MemoryConsolidationSettings />);
        await screen.findByTestId('memory-schedule-enabled');

        expect(selectorsFrom(fetchMock)).toEqual(['personal']);
    });

    it('says the save failed rather than only reverting the control', async () => {
        // A rollback on its own is indistinguishable from a mis-click, so
        // the user retries the same failing write. This is the shape the
        // scope bug wore in production: every PUT came back 422 and the
        // toggle just refused to stay on, with nothing on screen.
        const fetchMock = mockFetch((url, init) =>
            init?.method === 'PUT'
                ? { ok: false, json: () => ({}) }
                : { ok: true, json: () => SETTINGS },
        );
        vi.stubGlobal('fetch', fetchMock);

        render(<MemoryConsolidationSettings />);
        const toggle = (await screen.findByTestId('memory-schedule-enabled')) as HTMLInputElement;
        expect(screen.queryByTestId('memory-schedule-error')).toBeNull();

        fireEvent.click(toggle);

        const alert = await screen.findByTestId('memory-schedule-error');
        expect(alert).toHaveAttribute('role', 'alert');
        expect((screen.getByTestId('memory-schedule-enabled') as HTMLInputElement).checked).toBe(
            false,
        );
    });

    it('reports a thrown save the same way, and clears the notice on the next attempt', async () => {
        let failNext = true;
        const fetchMock = vi.fn((url: string, init?: RequestInit) => {
            if (init?.method !== 'PUT') {
                return Promise.resolve({ ok: true, json: () => Promise.resolve(SETTINGS) });
            }
            if (failNext) return Promise.reject(new Error('offline'));
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ ...SETTINGS, enabled: true }),
            });
        });
        vi.stubGlobal('fetch', fetchMock);

        render(<MemoryConsolidationSettings />);
        const toggle = (await screen.findByTestId('memory-schedule-enabled')) as HTMLInputElement;

        fireEvent.click(toggle);
        await screen.findByTestId('memory-schedule-error');

        failNext = false;
        fireEvent.click(screen.getByTestId('memory-schedule-enabled'));

        // A stale error banner over a control that now saved fine is the
        // mirror image of the original defect.
        await waitFor(() => {
            expect(screen.queryByTestId('memory-schedule-error')).toBeNull();
        });
        expect((screen.getByTestId('memory-schedule-enabled') as HTMLInputElement).checked).toBe(
            true,
        );
    });
});
