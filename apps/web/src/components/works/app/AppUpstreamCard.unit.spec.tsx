import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { AppUpstreamStateResponse } from '@ever-works/contracts';
import messages from '../../../../messages/en.json';

/**
 * APW-02 T30 — the Upstream card (plan §5.2, `plan.md:629-640`; spec §6.1).
 *
 * Rendered with the REAL English catalogue, so the copy a member reads is what
 * is asserted, and with the two server actions mocked at their module boundary:
 * the card owns the optimistic **Syncing…**, the refusal copy and the poll, and
 * each of those is a case below.
 */

const { syncUpstreamActionMock, retryUpstreamReadinessActionMock } = vi.hoisted(() => ({
    syncUpstreamActionMock: vi.fn(),
    retryUpstreamReadinessActionMock: vi.fn(),
}));

vi.mock('@/app/actions/dashboard/works', () => ({
    syncUpstreamAction: syncUpstreamActionMock,
    retryUpstreamReadinessAction: retryUpstreamReadinessActionMock,
}));

import {
    AppUpstreamCard,
    showUpstreamCardOnOverview,
    UPSTREAM_POLL_INTERVAL_MS,
    UPSTREAM_POLL_MAX,
    upstreamOffersTryAgain,
    upstreamResultLine,
} from './AppUpstreamCard';

function upstreamState(over: Partial<AppUpstreamStateResponse> = {}): AppUpstreamStateResponse {
    return {
        workId: 'w1',
        relation: 'fork',
        dataRepository: {
            owner: 'me',
            repo: 'tasks-app',
            url: 'https://github.com/me/tasks-app',
            defaultBranch: 'main',
            status: 'available',
        },
        upstream: {
            owner: 'acme',
            repo: 'tasks-app',
            url: 'https://github.com/acme/tasks-app',
            defaultBranch: 'main',
            status: 'available',
        },
        readiness: {
            state: 'ready',
            startedAt: '2026-09-16T12:00:00.000Z',
            readyAt: '2026-09-16T12:01:00.000Z',
            manualRetriesLeft: 3,
        },
        divergence: null,
        sync: {
            schedule: '0 6 * * 1',
            running: false,
            manualSyncsLeft: 6,
            rateLimitedPersistent: false,
        },
        actions: { state: 'clean', disabled: [], kept: [] },
        warnings: [],
        ...over,
    };
}

function renderCard(state: AppUpstreamStateResponse, variant: 'tab' | 'overview' = 'tab') {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <AppUpstreamCard workId={state.workId} variant={variant} initialState={state} />
        </NextIntlClientProvider>,
    );
}

describe('AppUpstreamCard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.history.replaceState({}, '', '/works/w1');
        syncUpstreamActionMock.mockResolvedValue({ success: true, queued: true, runId: 'run-1' });
        retryUpstreamReadinessActionMock.mockResolvedValue({
            success: true,
            queued: true,
            runId: 'run-2',
        });
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () =>
                    upstreamState({ sync: { ...upstreamState().sync!, running: true } }),
            }),
        );
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('names the relation for a fork and for a private copy', () => {
        renderCard(upstreamState());

        expect(screen.getByTestId('app-upstream-relation')).toHaveTextContent(
            'Fork of acme/tasks-app',
        );

        cleanup();

        renderCard(upstreamState({ relation: 'private-copy' }), 'tab');

        expect(screen.getByTestId('app-upstream-relation')).toHaveTextContent(
            'Private copy of acme/tasks-app',
        );
    });

    it.each<[AppUpstreamStateResponse['readiness']['state'], string]>([
        ['preparing', 'Preparing'],
        ['ready', 'Ready'],
        ['waiting_for_setup_pr', 'Waiting for the setup pull request'],
        ['timed_out', 'Timed out'],
        ['failed', 'Failed'],
    ])('renders the %s readiness in the tab variant', (state, copy) => {
        renderCard(
            upstreamState({
                readiness: { ...upstreamState().readiness, state },
            }),
        );

        expect(screen.getByTestId('app-upstream-readiness')).toHaveTextContent(copy);
    });

    it.each<[AppUpstreamStateResponse['readiness']['state']]>([
        ['preparing'],
        ['ready'],
        ['waiting_for_setup_pr'],
    ])('does not offer Try again while readiness is %s (FR-59)', (state) => {
        renderCard(
            upstreamState({
                readiness: { ...upstreamState().readiness, state },
            }),
        );

        expect(screen.queryByTestId('app-upstream-readiness-retry')).toBeNull();
    });

    it.each<[AppUpstreamStateResponse['readiness']['state']]>([['timed_out'], ['failed']])(
        'offers Try again when readiness is %s, and calls the action once (ACC-02-23)',
        async (state) => {
            renderCard(
                upstreamState({
                    readiness: { ...upstreamState().readiness, state },
                }),
            );

            const button = screen.getByTestId('app-upstream-readiness-retry');
            expect(button).toHaveTextContent('Try again');

            fireEvent.click(button);

            await waitFor(() => expect(retryUpstreamReadinessActionMock).toHaveBeenCalledTimes(1));
            expect(retryUpstreamReadinessActionMock).toHaveBeenCalledWith('w1');
        },
    );

    it('omits the readiness row in the overview variant (plan §5.1)', () => {
        renderCard(upstreamState(), 'overview');

        expect(screen.getByTestId('app-upstream-card')).toBeInTheDocument();
        expect(screen.queryByTestId('app-upstream-readiness')).toBeNull();
    });

    it('renders the divergence badge inside the card', () => {
        renderCard(
            upstreamState({
                divergence: {
                    aheadBy: 0,
                    behindBy: 12,
                    computedAt: new Date().toISOString(),
                    stale: false,
                },
            }),
        );

        expect(screen.getByTestId('app-upstream-badge')).toHaveTextContent(
            '12 commits behind upstream',
        );
    });

    // ACC-02-12 — a worse upstream licence turns a fast-forward into a pull
    // request, and the card has to say why.
    it('renders the license note for a sync held by the license gate', () => {
        renderCard(
            upstreamState({
                sync: {
                    ...upstreamState().sync!,
                    lastResult: 'pull_request_opened',
                    lastReason: 'license_worse',
                    lastCommitCount: 4,
                    lastFinishedAt: '2026-09-17T09:00:00.000Z',
                    pullRequest: { number: 41, url: 'https://github.com/me/tasks-app/pull/41' },
                },
            }),
        );

        const line = screen.getByTestId('app-upstream-result');
        expect(line).toHaveTextContent(
            'Upstream changed its license. Review the pull request before merging.',
        );
        expect(line).not.toHaveTextContent('Opened a pull request to sync');
    });

    it.each<[AppUpstreamStateResponse['sync'], string]>([
        [
            {
                schedule: null,
                running: false,
                manualSyncsLeft: 6,
                rateLimitedPersistent: false,
                lastResult: 'up_to_date',
                lastFinishedAt: '2026-09-17T09:00:00.000Z',
            },
            'Already up to date',
        ],
        [
            {
                schedule: null,
                running: false,
                manualSyncsLeft: 6,
                rateLimitedPersistent: false,
                lastResult: 'fast_forwarded',
                lastCommitCount: 1,
                lastFinishedAt: '2026-09-17T09:00:00.000Z',
            },
            'Synced 1 commit from upstream',
        ],
        [
            {
                schedule: null,
                running: false,
                manualSyncsLeft: 6,
                rateLimitedPersistent: false,
                lastResult: 'fast_forwarded',
                lastCommitCount: 12,
                lastFinishedAt: '2026-09-17T09:00:00.000Z',
            },
            'Synced 12 commits from upstream',
        ],
        [
            {
                schedule: null,
                running: false,
                manualSyncsLeft: 6,
                rateLimitedPersistent: false,
                lastResult: 'pull_request_opened',
                lastCommitCount: 12,
                lastFinishedAt: '2026-09-17T09:00:00.000Z',
            },
            'Opened a pull request to sync 12 commits',
        ],
        [
            {
                schedule: null,
                running: false,
                manualSyncsLeft: 6,
                rateLimitedPersistent: false,
                lastResult: 'pull_request_updated',
                lastCommitCount: 3,
                lastFinishedAt: '2026-09-17T09:00:00.000Z',
            },
            'Updated the sync pull request (3 commits)',
        ],
        [
            {
                schedule: null,
                running: false,
                manualSyncsLeft: 6,
                rateLimitedPersistent: false,
                lastResult: 'failed',
                lastReason: 'provider_unsupported',
                lastFinishedAt: '2026-09-17T09:00:00.000Z',
            },
            'Sync failed: provider_unsupported',
        ],
    ])('renders the %# result line', (sync, copy) => {
        renderCard(upstreamState({ sync }));

        expect(screen.getByTestId('app-upstream-result')).toHaveTextContent(copy);
    });

    it('links the sync pull request and the conflict Task', () => {
        renderCard(
            upstreamState({
                sync: {
                    ...upstreamState().sync!,
                    lastResult: 'pull_request_opened',
                    lastCommitCount: 12,
                    lastFinishedAt: '2026-09-17T09:00:00.000Z',
                    pullRequest: { number: 41, url: 'https://github.com/me/tasks-app/pull/41' },
                },
            }),
        );

        expect(screen.getByRole('link', { name: '#41' })).toHaveAttribute(
            'href',
            'https://github.com/me/tasks-app/pull/41',
        );

        cleanup();

        renderCard(
            upstreamState({
                sync: {
                    ...upstreamState().sync!,
                    lastResult: 'conflict',
                    lastReason: 'conflict',
                    lastFinishedAt: '2026-09-17T09:00:00.000Z',
                    conflictTaskId: '11111111-1111-1111-1111-111111111111',
                },
            }),
        );

        expect(screen.getByTestId('app-upstream-result')).toHaveTextContent(
            'Conflicts need resolving — a Task was created.',
        );
        expect(screen.getByRole('link', { name: 'Open the Task' })).toHaveAttribute(
            'href',
            '/tasks/11111111-1111-1111-1111-111111111111',
        );
    });

    it('toggles the inherited-workflow list', () => {
        renderCard(
            upstreamState({
                actions: {
                    state: 'clean',
                    disabled: [{ path: '.github/workflows/deploy.yml' }],
                    kept: [],
                },
            }),
        );

        expect(screen.getByTestId('app-upstream-card')).toHaveTextContent(
            '1 inherited workflow disabled',
        );
        expect(screen.queryByTestId('app-upstream-workflows-list')).toBeNull();

        fireEvent.click(screen.getByTestId('app-upstream-workflows-toggle'));

        expect(screen.getByTestId('app-upstream-workflows-list')).toHaveTextContent(
            '.github/workflows/deploy.yml',
        );
        expect(screen.getByTestId('app-upstream-workflows-toggle')).toHaveTextContent('Hide');
    });

    it('shows Syncing… optimistically after Sync now, and disables the button', async () => {
        renderCard(upstreamState());

        fireEvent.click(screen.getByTestId('app-upstream-sync-now'));

        await waitFor(() => expect(syncUpstreamActionMock).toHaveBeenCalledWith('w1'));

        const button = await screen.findByTestId('app-upstream-sync-now');
        expect(button).toHaveTextContent('Syncing…');
        expect(button).toBeDisabled();
    });

    it.each<[string, Record<string, unknown>, string]>([
        [
            'sync_in_progress',
            { code: 'sync_in_progress', statusCode: 409 },
            'A sync is already running.',
        ],
        [
            'sync_limit_reached',
            {
                code: 'sync_limit_reached',
                statusCode: 429,
                details: { retryAt: '2026-09-17T12:30:00.000Z' },
            },
            "You've synced 6 times this hour. Try again at Thu 12:30 UTC.",
        ],
        ['not_ready', { code: 'not_ready', statusCode: 409 }, 'Sync failed: not_ready'],
    ])('renders the %s refusal with its own copy', async (code, refusal, copy) => {
        syncUpstreamActionMock.mockResolvedValue({ success: false, ...refusal });
        renderCard(upstreamState());

        fireEvent.click(screen.getByTestId('app-upstream-sync-now'));

        await waitFor(() =>
            expect(screen.getByTestId('app-upstream-failure')).toHaveTextContent(copy),
        );
        expect(screen.getByTestId('app-upstream-sync-now')).toHaveTextContent('Sync now');
    });

    it('does not offer Sync now for a linked App Work, which has no sync at all', () => {
        renderCard(upstreamState({ relation: 'link', upstream: null, sync: null }));

        expect(screen.queryByTestId('app-upstream-sync-now')).toBeNull();
    });

    describe('polling while a sync runs (plan §5.2)', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        it('polls every five seconds and stops at the 360th poll', async () => {
            renderCard(upstreamState({ sync: { ...upstreamState().sync!, running: true } }));

            await act(async () => {
                await vi.advanceTimersByTimeAsync(UPSTREAM_POLL_INTERVAL_MS * UPSTREAM_POLL_MAX);
            });

            expect(UPSTREAM_POLL_INTERVAL_MS).toBe(5_000);
            expect(UPSTREAM_POLL_MAX).toBe(360);
            expect(vi.mocked(fetch)).toHaveBeenCalledTimes(UPSTREAM_POLL_MAX);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(UPSTREAM_POLL_INTERVAL_MS * 5);
            });

            expect(vi.mocked(fetch)).toHaveBeenCalledTimes(UPSTREAM_POLL_MAX);
        });

        it('stops polling on unmount', async () => {
            const { unmount } = renderCard(
                upstreamState({ sync: { ...upstreamState().sync!, running: true } }),
            );

            await act(async () => {
                await vi.advanceTimersByTimeAsync(UPSTREAM_POLL_INTERVAL_MS);
            });

            expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

            unmount();

            await act(async () => {
                await vi.advanceTimersByTimeAsync(UPSTREAM_POLL_INTERVAL_MS * 10);
            });

            expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
        });

        it('stops as soon as the run is over', async () => {
            vi.mocked(fetch).mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => upstreamState(),
            } as unknown as Response);

            renderCard(upstreamState({ sync: { ...upstreamState().sync!, running: true } }));

            await act(async () => {
                await vi.advanceTimersByTimeAsync(UPSTREAM_POLL_INTERVAL_MS * 10);
            });

            expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
        });

        it('does not poll when no sync is running', async () => {
            renderCard(upstreamState());

            await act(async () => {
                await vi.advanceTimersByTimeAsync(UPSTREAM_POLL_INTERVAL_MS * 10);
            });

            expect(vi.mocked(fetch)).not.toHaveBeenCalled();
        });
    });
});

/**
 * The overview gate: which states the card is allowed to render on the Work
 * Overview at all (plan §5.1). A state the API can return but the plan does not
 * put on the Overview — a `link`, or a readiness APW-01's card owns — must be
 * refused here.
 */
describe('showUpstreamCardOnOverview', () => {
    it.each(['preparing', 'timed_out', 'failed'] as const)(
        'refuses a fork whose readiness is %s',
        (state) => {
            expect(
                showUpstreamCardOnOverview(
                    upstreamState({ readiness: { ...upstreamState().readiness, state } }),
                ),
            ).toBe(false);
        },
    );

    it('refuses a linked App Work, which has no upstream at all (FR-44)', () => {
        expect(
            showUpstreamCardOnOverview(
                upstreamState({ relation: 'link', upstream: null, sync: null }),
            ),
        ).toBe(false);
    });

    it('refuses a missing state rather than inventing one', () => {
        expect(showUpstreamCardOnOverview(null)).toBe(false);
    });

    it.each<[AppUpstreamStateResponse['relation'], AppUpstreamStateResponse['readiness']['state']]>(
        [
            ['fork', 'ready'],
            ['fork', 'waiting_for_setup_pr'],
            ['private-copy', 'ready'],
            ['private-copy', 'waiting_for_setup_pr'],
        ],
    )('shows a %s with readiness %s', (relation, state) => {
        expect(
            showUpstreamCardOnOverview(
                upstreamState({
                    relation,
                    readiness: { ...upstreamState().readiness, state },
                }),
            ),
        ).toBe(true);
    });
});

describe('upstreamOffersTryAgain', () => {
    it('is true for exactly the two states FR-59 names', () => {
        expect(
            upstreamOffersTryAgain(
                upstreamState({ readiness: { ...upstreamState().readiness, state: 'timed_out' } }),
            ),
        ).toBe(true);
        expect(
            upstreamOffersTryAgain(
                upstreamState({ readiness: { ...upstreamState().readiness, state: 'failed' } }),
            ),
        ).toBe(true);
        expect(
            upstreamOffersTryAgain(
                upstreamState({
                    readiness: { ...upstreamState().readiness, state: 'waiting_for_setup_pr' },
                }),
            ),
        ).toBe(false);
        expect(
            upstreamOffersTryAgain(
                upstreamState({ readiness: { ...upstreamState().readiness, state: 'preparing' } }),
            ),
        ).toBe(false);
        expect(
            upstreamOffersTryAgain(
                upstreamState({ readiness: { ...upstreamState().readiness, state: 'ready' } }),
            ),
        ).toBe(false);
    });
});

describe('upstreamResultLine', () => {
    it('renders no line for a run that was skipped or paused, and none without a result', () => {
        expect(upstreamResultLine(null)).toBeNull();
        expect(upstreamResultLine(upstreamState().sync)).toBeNull();
        expect(
            upstreamResultLine({
                ...upstreamState().sync!,
                lastResult: 'paused',
                lastReason: 'paused',
            }),
        ).toBeNull();
        expect(
            upstreamResultLine({
                ...upstreamState().sync!,
                lastResult: 'skipped',
                lastReason: 'skipped_rate_limited',
            }),
        ).toBeNull();
    });

    it('prefers the license note over the pull-request line it came with', () => {
        expect(
            upstreamResultLine({
                ...upstreamState().sync!,
                lastResult: 'pull_request_opened',
                lastReason: 'license_worse',
                lastCommitCount: 4,
            }),
        ).toEqual({ key: 'resultLicenseChangedNoSpdx', pullRequestUrl: undefined });
    });
});
