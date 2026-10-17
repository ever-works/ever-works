import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { AppBuildStatus, AppBuildSummary } from '@ever-works/contracts';
import messages from '../../../../../messages/en.json';
import {
    APP_BUILDS_POLL_ACTIVE_MS,
    APP_BUILDS_POLL_IDLE_MS,
    normalizeAppBuildsList,
    type AppBuildsList as AppBuildsListData,
    type AppBuildsListState,
} from '@/lib/works/app-builds.shared';

/**
 * APW-05 T26 — the Builds list, rendered with the REAL English catalogue and
 * the server actions mocked at their module boundary.
 */

const { listMock, startMock, cancelMock, getMock, toastMock } = vi.hoisted(() => ({
    listMock: vi.fn(),
    startMock: vi.fn(),
    cancelMock: vi.fn(),
    getMock: vi.fn(),
    toastMock: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/app/actions/dashboard/app-builds', () => ({
    listAppBuildsAction: listMock,
    startAppBuildAction: startMock,
    cancelAppBuildAction: cancelMock,
    getAppBuildAction: getMock,
}));

vi.mock('sonner', () => ({ toast: toastMock }));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: any) => (
        <a href={typeof href === 'string' ? href : ''} {...rest}>
            {children}
        </a>
    ),
}));

import { AppBuildsList } from './AppBuildsList';

let seq = 0;
function build(over: Partial<AppBuildSummary> = {}): AppBuildSummary {
    seq += 1;
    return {
        id: `b${seq}`,
        number: seq,
        status: 'succeeded',
        trigger: 'push',
        branch: 'main',
        commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        pullRequestNumber: null,
        blockedReason: null,
        blockedDetail: null,
        deployable: true,
        notDeployableReason: null,
        imageRepository: 'ghcr.io/acme/app/ever-works-app',
        imageDigest: `sha256:${'4f1c'.padEnd(64, '0')}`,
        imageTags: ['sha-a1b2c3d'],
        failureClass: null,
        queuedAt: null,
        startedAt: null,
        completedAt: null,
        durationSeconds: 250,
        logsUrl: null,
        ...over,
    };
}

function listOf(items: AppBuildSummary[]): AppBuildsListData {
    return normalizeAppBuildsList({
        items,
        total: items.length,
        page: 1,
        pageSize: 20,
        repository: { fullName: 'acme/app', visibility: 'public' },
        imageRepository: 'ghcr.io/acme/app/ever-works-app',
        workflow: { state: 'committed', pullRequestUrl: 'https://github.com/acme/app/pull/3' },
        pullAccess: { visibility: 'public', tokenSet: false, tokenExpiresAt: null },
    });
}

function renderList(initialState: AppBuildsListState, canEdit = true) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <AppBuildsList workId="w1" initialState={initialState} canEdit={canEdit} />
        </NextIntlClientProvider>,
    );
}

beforeEach(() => {
    seq = 0;
    listMock.mockReset();
    startMock.mockReset();
    cancelMock.mockReset();
    getMock.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('AppBuildsList', () => {
    it('renders every status as icon + text', () => {
        const statuses: AppBuildStatus[] = [
            'queued',
            'running',
            'succeeded',
            'failed',
            'cancelled',
            'blocked',
        ];
        renderList({ kind: 'ok', list: listOf(statuses.map((status) => build({ status }))) });

        const copy = messages.dashboard.workDetail.builds.status;
        for (const status of statuses) {
            expect(screen.getByTestId(`app-build-status-${status}`)).toHaveTextContent(
                copy[status],
            );
        }
        // The subtitle names the repository and the image.
        expect(
            screen.getByText(
                'Built on GitHub-hosted runners in acme/app · image ghcr.io/acme/app/ever-works-app',
            ),
        ).toBeInTheDocument();
    });

    it('renders a blocked row with its reason and action', () => {
        renderList({
            kind: 'ok',
            list: listOf([
                build({
                    status: 'blocked',
                    deployable: false,
                    blockedReason: 'missingBuildValues',
                    blockedDetail: { names: ['LICENSE_KEY'] },
                }),
            ]),
        });

        expect(screen.getByText('Waiting for 1 build value: LICENSE_KEY')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Set it' })).toHaveAttribute(
            'href',
            '/works/w1/settings',
        );
    });

    it('shows the not-deployable reason under a succeeded pull-request build', () => {
        renderList({
            kind: 'ok',
            list: listOf([
                build({
                    trigger: 'pull_request',
                    pullRequestNumber: 12,
                    deployable: false,
                    notDeployableReason: 'pullRequest',
                }),
            ]),
        });
        expect(screen.getByText('PR #12')).toBeInTheDocument();
        expect(screen.getByText('Not deployable — Built from a pull request')).toBeInTheDocument();
    });

    it('polls every 5 s while a build runs, then every 30 s, and stops on unmount', async () => {
        vi.useFakeTimers();
        const running = build({ status: 'running', deployable: false });
        listMock.mockResolvedValue({
            success: true,
            data: listOf([{ ...running, status: 'succeeded', deployable: true }]),
        });

        const view = renderList({ kind: 'ok', list: listOf([running]) });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(APP_BUILDS_POLL_ACTIVE_MS - 1);
        });
        expect(listMock).not.toHaveBeenCalled();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
        });
        expect(listMock).toHaveBeenCalledTimes(1);

        // Nothing is active any more: the next read waits the idle interval.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(APP_BUILDS_POLL_ACTIVE_MS);
        });
        expect(listMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(APP_BUILDS_POLL_IDLE_MS - APP_BUILDS_POLL_ACTIVE_MS);
        });
        expect(listMock).toHaveBeenCalledTimes(2);

        view.unmount();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(APP_BUILDS_POLL_IDLE_MS * 3);
        });
        expect(listMock).toHaveBeenCalledTimes(2);
    });

    it('starts a build once, even on a double click', async () => {
        let resolve: (value: unknown) => void = () => undefined;
        startMock.mockReturnValue(
            new Promise((r) => {
                resolve = r;
            }),
        );
        const queued = build({ status: 'queued', deployable: false });
        // The refresh after the start is the source of truth for the rows.
        listMock.mockResolvedValue({ success: true, data: listOf([queued]) });

        renderList({ kind: 'ok', list: listOf([]) });
        const button = screen.getByTestId('app-build-start');
        fireEvent.click(button);
        fireEvent.click(button);
        expect(startMock).toHaveBeenCalledTimes(1);
        expect(startMock).toHaveBeenCalledWith('w1', {});

        await act(async () => {
            resolve({ success: true, data: { build: queued, buildId: queued.id, deduped: false } });
        });
        expect(toastMock.success).toHaveBeenCalledWith('Build queued.');
        expect(screen.getByTestId('app-build-status-queued')).toBeInTheDocument();
    });

    it('maps a refusal code to its copy', async () => {
        startMock.mockResolvedValue({
            success: false,
            code: 'rebuildRateLimited',
            statusCode: 429,
            details: { retryAfterMinutes: 12 },
        });
        renderList({ kind: 'ok', list: listOf([]) });
        await act(async () => {
            fireEvent.click(screen.getByTestId('app-build-start'));
        });
        expect(toastMock.error).toHaveBeenCalledWith(
            "You've started too many builds this hour. Try again in 12 minutes.",
        );
    });

    it('renders a calm empty state when the Builds route is not deployed (404)', () => {
        renderList({ kind: 'unavailable' });
        expect(screen.getByTestId('app-builds-unavailable')).toHaveTextContent(
            "Builds aren't available on this instance yet.",
        );
        expect(screen.queryByTestId('app-build-start')).not.toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('turns into the calm empty state when a poll answers 404', async () => {
        vi.useFakeTimers();
        listMock.mockResolvedValue({ success: false, statusCode: 404 });
        renderList({ kind: 'ok', list: listOf([build({ status: 'running' })]) });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(APP_BUILDS_POLL_ACTIVE_MS);
        });
        expect(screen.getByTestId('app-builds-unavailable')).toBeInTheDocument();
    });

    it('shows the no-builds and load-error states', () => {
        const first = renderList({ kind: 'ok', list: listOf([]) });
        expect(screen.getByTestId('app-builds-empty')).toHaveTextContent(
            'No builds yet. The first build starts when the build workflow is in the repository.',
        );
        first.unmount();

        renderList({ kind: 'error' });
        expect(screen.getByRole('alert')).toHaveTextContent(
            'Builds could not be loaded. Try refreshing the page.',
        );
    });

    it('disables Start build for a viewer', () => {
        renderList({ kind: 'ok', list: listOf([]) }, false);
        const button = screen.getByTestId('app-build-start');
        expect(button).toBeDisabled();
        fireEvent.click(button);
        expect(startMock).not.toHaveBeenCalled();
    });
});
