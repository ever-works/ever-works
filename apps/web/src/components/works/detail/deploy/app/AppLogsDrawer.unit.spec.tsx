import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '../../../../../../messages/en.json';

/**
 * Lane aw-ops (APW-06 T39, FR-48) — the logs drawer: one fetch is POST app-logs → poll the
 * read-back until ready; the tail renders with the hidden names; a failure renders its own
 * sentence; and nothing is ever written to the browser's storage (T39's pinned rule).
 */

const { client } = vi.hoisted(() => ({
    client: {
        getStatus: vi.fn(),
        refreshStatus: vi.fn(),
        requestLogs: vi.fn(),
        readLogs: vi.fn(),
        runJob: vi.fn(),
        runSmoke: vi.fn(),
        listDeployments: vi.fn(),
    },
}));

vi.mock('@/lib/api/app-runtime-ops.client', () => ({ appRuntimeOpsClient: client }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { AppLogsDrawer } from './AppLogsDrawer';

const WORK_ID = '6f1c1b6e-2f7a-4c55-9a0e-2a1d4c8b9e10';
const REQUEST_ID = 'b5e1c7a0-3333-4c4d-9e5f-607182930415';

function renderDrawer(initial: { kind: 'component' | 'job'; name: string } = { kind: 'component', name: 'web' }) {
    render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <AppLogsDrawer
                workId={WORK_ID}
                open
                onOpenChange={() => undefined}
                components={['web', 'worker']}
                jobs={['migrate']}
                initialTarget={initial}
            />
        </NextIntlClientProvider>,
    );
}

describe('AppLogsDrawer', () => {
    let setItem: ReturnType<typeof vi.spyOn>;
    let sessionSetItem: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        Object.values(client).forEach((fn) => fn.mockReset());
        setItem = vi.spyOn(window.localStorage.__proto__, 'setItem');
        sessionSetItem = vi.spyOn(window.sessionStorage.__proto__, 'setItem');
    });
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('fetches the opened target, polls until ready, and shows the redacted tail', async () => {
        client.requestLogs.mockResolvedValue({
            ok: true,
            status: 202,
            data: { status: 'accepted', op: 'logs', requestId: REQUEST_ID, dispatched: true },
        });
        client.readLogs
            .mockResolvedValueOnce({ ok: true, status: 200, data: { requestId: REQUEST_ID, status: 'pending' } })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                data: {
                    requestId: REQUEST_ID,
                    status: 'ready',
                    tail: {
                        containers: [
                            { pod: 'web-1', container: 'web', lines: ['listening with DATABASE_PASSWORD'], truncated: false },
                        ],
                        redactedNames: ['DATABASE_PASSWORD'],
                        fetchedAt: '2026-10-27T00:00:00.000Z',
                    },
                },
            });

        renderDrawer({ kind: 'job', name: 'migrate' });
        await waitFor(() => expect(client.requestLogs).toHaveBeenCalledWith(WORK_ID, { job: 'migrate', lines: 200 }));
        await vi.advanceTimersByTimeAsync(3_200);
        expect(await screen.findByTestId('app-logs-tail')).toHaveTextContent('listening with DATABASE_PASSWORD');
        expect(screen.getByTestId('app-logs-redacted')).toHaveTextContent('Hidden: DATABASE_PASSWORD');
        expect(client.readLogs).toHaveBeenCalledTimes(2);
        expect(setItem).not.toHaveBeenCalled();
        expect(sessionSetItem).not.toHaveBeenCalled();
    });

    it('asks for the previous container of a component when ticked', async () => {
        client.requestLogs.mockResolvedValue({ ok: false, status: 503, code: 'logs_cache_unavailable' });
        renderDrawer();
        await waitFor(() => expect(client.requestLogs).toHaveBeenCalledTimes(1));
        fireEvent.click(screen.getByTestId('app-logs-previous'));
        await waitFor(() =>
            expect(client.requestLogs).toHaveBeenLastCalledWith(WORK_ID, { component: 'web', lines: 200, previous: true }),
        );
        expect(await screen.findByTestId('app-logs-error')).toHaveTextContent("Logs can't be fetched on this instance.");
    });

    it('explains a withheld tail and an expired request in their own words', async () => {
        client.requestLogs.mockResolvedValue({
            ok: true,
            status: 202,
            data: { status: 'accepted', op: 'logs', requestId: REQUEST_ID, dispatched: true },
        });
        client.readLogs.mockResolvedValueOnce({
            ok: true,
            status: 200,
            data: { requestId: REQUEST_ID, status: 'failed', code: 'redaction_unavailable' },
        });
        renderDrawer();
        await vi.advanceTimersByTimeAsync(1_600);
        expect(await screen.findByTestId('app-logs-error')).toHaveTextContent(/secret values couldn't be read/);

        client.readLogs.mockResolvedValueOnce({ ok: false, status: 404, code: 'logs_request_not_found' });
        fireEvent.click(screen.getByTestId('app-logs-refresh'));
        await vi.advanceTimersByTimeAsync(1_600);
        await waitFor(() => expect(screen.getByTestId('app-logs-error')).toHaveTextContent(/expired/));
    });
});
