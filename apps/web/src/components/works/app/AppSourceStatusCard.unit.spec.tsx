import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import type { AppUpstreamStateResponse } from '@ever-works/contracts';
import messages from '../../../../messages/en.json';

/** APW-01 T24 — the App source status card (spec §6.4). */

const { fetchMock, retryMock, refreshMock } = vi.hoisted(() => ({
    fetchMock: vi.fn(),
    retryMock: vi.fn(),
    refreshMock: vi.fn(),
}));

vi.mock('@/lib/api/browser-api', () => ({ browserApiFetch: fetchMock }));
vi.mock('@/app/actions/dashboard/works', () => ({ retryUpstreamReadinessAction: retryMock }));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: refreshMock }),
    Link: ({ children, href }: { children: ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

import {
    APP_SOURCE_PREPARING_POLL_MAX,
    APP_SOURCE_PREPARING_POLL_MS,
    APP_SOURCE_WAITING_POLL_MS,
    AppSourceStatusCard,
    appSourceFailureCopy,
} from './AppSourceStatusCard';

function state(
    readiness: Partial<AppUpstreamStateResponse['readiness']>,
    relation: AppUpstreamStateResponse['relation'] = 'fork',
): AppUpstreamStateResponse {
    return {
        workId: 'w1',
        relation,
        dataRepository: {
            owner: 'me',
            repo: 'tasks-app',
            url: 'https://github.com/me/tasks-app',
            defaultBranch: 'main',
            status: 'available',
        },
        upstream:
            relation === 'link'
                ? null
                : {
                      owner: 'acme',
                      repo: 'tasks-app',
                      url: 'https://github.com/acme/tasks-app',
                      defaultBranch: 'main',
                      status: 'available',
                  },
        readiness: {
            state: 'preparing',
            startedAt: '2026-10-17T10:00:00.000Z',
            manualRetriesLeft: 3,
            ...readiness,
        },
        divergence: null,
        sync: null,
        actions: null,
        warnings: [],
    } as AppUpstreamStateResponse;
}

function renderCard(initial: AppUpstreamStateResponse) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages}>
            <AppSourceStatusCard workId="w1" initialState={initial} />
        </NextIntlClientProvider>,
    );
}

beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    retryMock.mockReset();
    refreshMock.mockReset();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('appSourceFailureCopy', () => {
    it('never shows a raw code', () => {
        expect(
            appSourceFailureCopy({ state: 'failed', reason: 'access_revoked' } as never),
        ).toEqual({ kind: 'access' });
        expect(
            appSourceFailureCopy({ state: 'failed', reason: 'setup_pull_request_closed' } as never),
        ).toEqual({
            kind: 'setupPrClosed',
        });
        expect(appSourceFailureCopy({ state: 'failed', reason: 'too_large' } as never)).toEqual({
            kind: 'other',
            leaf: 'too_large_for_private_copy',
        });
        expect(
            appSourceFailureCopy({
                state: 'failed',
                reason: 'handler_failed',
                handlerReason: { code: 'handler_failed:works_yml_unparseable' },
            } as never),
        ).toEqual({ kind: 'other', leaf: 'works_yml_unparseable' });
        expect(
            appSourceFailureCopy({ state: 'failed', reason: 'dispatch_unavailable' } as never),
        ).toEqual({
            kind: 'other',
            leaf: 'other',
        });
    });
});

describe('AppSourceStatusCard', () => {
    it('renders nothing once the App Work is ready', () => {
        const { container } = renderCard(state({ state: 'ready' }));
        expect(container.querySelector('[data-testid="app-source-status"]')).toBeNull();
    });

    it('shows the per-relation preparing copy', () => {
        renderCard(state({ state: 'preparing' }, 'fork'));
        expect(screen.getByText('Preparing your fork')).toBeTruthy();
        cleanup();
        renderCard(state({ state: 'preparing' }, 'link'));
        expect(screen.getByText('Finishing setup')).toBeTruthy();
        expect(
            screen.getByText('Opening a pull request that adds .works/works.yml to me/tasks-app.'),
        ).toBeTruthy();
    });

    it('polls every 5 s while preparing, stops at the cap, and refreshes on ready', async () => {
        fetchMock.mockResolvedValue({ ok: true, json: async () => state({ state: 'preparing' }) });
        renderCard(state({ state: 'preparing' }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(APP_SOURCE_PREPARING_POLL_MS * 3);
        });
        expect(fetchMock).toHaveBeenCalledTimes(3);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(
                APP_SOURCE_PREPARING_POLL_MS * (APP_SOURCE_PREPARING_POLL_MAX + 10),
            );
        });
        expect(fetchMock).toHaveBeenCalledTimes(APP_SOURCE_PREPARING_POLL_MAX);
    });

    it('stops polling and refreshes the page when the state turns ready', async () => {
        fetchMock.mockResolvedValue({ ok: true, json: async () => state({ state: 'ready' }) });
        renderCard(state({ state: 'preparing' }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(APP_SOURCE_PREPARING_POLL_MS * 4);
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(refreshMock).toHaveBeenCalledTimes(1);
    });

    it('polls every 30 s while waiting for the setup PR and offers Open pull request', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () =>
                state({
                    state: 'waiting_for_setup_pr',
                    setupPullRequestUrl: 'https://github.com/x/pull/1',
                }),
        });
        renderCard(
            state({
                state: 'waiting_for_setup_pr',
                setupPullRequestUrl: 'https://github.com/x/pull/1',
            }),
        );
        expect(screen.getByText('Merge the setup pull request to finish.')).toBeTruthy();
        expect(screen.getByTestId('app-source-open-pr').getAttribute('href')).toBe(
            'https://github.com/x/pull/1',
        );
        await act(async () => {
            await vi.advanceTimersByTimeAsync(APP_SOURCE_WAITING_POLL_MS * 2);
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('tears the poll down on unmount', async () => {
        fetchMock.mockResolvedValue({ ok: true, json: async () => state({ state: 'preparing' }) });
        const { unmount } = renderCard(state({ state: 'preparing' }));
        unmount();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(APP_SOURCE_PREPARING_POLL_MS * 5);
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('closed setup PR offers Try again; no retries left disables it with the limit copy', () => {
        renderCard(
            state({ state: 'failed', reason: 'setup_pull_request_closed', manualRetriesLeft: 0 }),
        );
        expect(screen.getByText('The setup pull request was closed without merging.')).toBeTruthy();
        expect((screen.getByTestId('app-source-retry') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('app-source-retry-limit').textContent).toBe(
            "You've used all 3 retries for this hour. Try again later.",
        );
    });
});
