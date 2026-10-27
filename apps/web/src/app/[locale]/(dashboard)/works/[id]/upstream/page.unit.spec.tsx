import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { AppUpstreamStateResponse } from '@ever-works/contracts';

/**
 * APW-02 T30 — the Upstream tab page (`plan.md:614-622`; FR-59, ACC-02-21).
 *
 * The two cases that matter are the two 404s: a read the API refused (another
 * account's Work, a non-`app` Work, a genuinely missing one) and a `link`
 * relation, which has no upstream at all. Neither may render the card — an empty
 * card would turn "you may not see this" into "this App Work has no upstream",
 * which is the substitution ACC-02-21 exists to catch.
 */

const { getUpstreamMock, notFoundMock, listUpstreamPrsMock } = vi.hoisted(() => ({
    getUpstreamMock: vi.fn(),
    listUpstreamPrsMock: vi.fn(),
    notFoundMock: vi.fn(() => {
        throw new Error('NEXT_NOT_FOUND');
    }),
}));

vi.mock('@/lib/api', () => ({
    workAPI: { getUpstream: getUpstreamMock },
}));

vi.mock('next/navigation', () => ({ notFound: notFoundMock }));

// APW-09 — the section's list read and the section itself (lane aw-upstream-prs).
vi.mock('@/lib/api/upstream-pull-requests', () => ({
    upstreamPullRequestsAPI: { list: listUpstreamPrsMock },
}));

vi.mock('@/components/works/detail/upstream/UpstreamPullRequestsSection', () => ({
    UpstreamPullRequestsSection: ({
        rows,
        relation,
        upstream,
    }: {
        rows: unknown[] | null;
        relation: string;
        upstream: string | null;
    }) => (
        <div
            data-testid="upstream-pull-requests-section-stub"
            data-rows={rows === null ? 'null' : String(rows.length)}
            data-relation={relation}
            data-upstream={upstream ?? ''}
        />
    ),
}));

vi.mock('next-intl/server', () => ({
    getTranslations: async () => (key: string) => key,
}));

vi.mock('@/components/works/app/AppUpstreamCard', () => ({
    AppUpstreamCard: ({
        workId,
        variant,
        initialState,
    }: {
        workId: string;
        variant: string;
        initialState: AppUpstreamStateResponse;
    }) => (
        <div
            data-testid="app-upstream-card-stub"
            data-work-id={workId}
            data-variant={variant}
            data-relation={initialState.relation}
        />
    ),
}));

import WorkUpstreamPage from './page';

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

function renderPage() {
    return WorkUpstreamPage({ params: Promise.resolve({ id: 'w1' }) });
}

describe('WorkUpstreamPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        listUpstreamPrsMock.mockResolvedValue({ data: [], meta: { total: 0 } });
    });

    afterEach(() => {
        cleanup();
    });

    it('renders the tab card for a fork, with the APW-09 slot below it', async () => {
        getUpstreamMock.mockResolvedValue(upstreamState());

        render(await renderPage());

        expect(screen.getByTestId('app-upstream-card-stub')).toHaveAttribute('data-variant', 'tab');
        expect(screen.getByTestId('app-upstream-card-stub')).toHaveAttribute('data-work-id', 'w1');
        expect(screen.getByTestId('app-upstream-pull-requests-slot')).toBeInTheDocument();
        expect(notFoundMock).not.toHaveBeenCalled();
    });

    it('mounts the APW-09 section in the slot with the Work’s list', async () => {
        getUpstreamMock.mockResolvedValue(upstreamState());
        listUpstreamPrsMock.mockResolvedValue({
            data: [{ id: 'r1' }, { id: 'r2' }],
            meta: { total: 2 },
        });

        render(await renderPage());

        expect(listUpstreamPrsMock).toHaveBeenCalledWith('w1', { limit: 20 });
        const section = screen.getByTestId('upstream-pull-requests-section-stub');
        expect(section).toHaveAttribute('data-rows', '2');
        expect(section).toHaveAttribute('data-relation', 'fork');
        expect(section).toHaveAttribute('data-upstream', 'acme/tasks-app');
    });

    it('keeps the tab when the list read fails, and says so in the section (rows: null)', async () => {
        getUpstreamMock.mockResolvedValue(upstreamState());
        listUpstreamPrsMock.mockRejectedValue(new Error('500'));

        render(await renderPage());

        expect(screen.getByTestId('app-upstream-card-stub')).toBeInTheDocument();
        expect(screen.getByTestId('upstream-pull-requests-section-stub')).toHaveAttribute(
            'data-rows',
            'null',
        );
        expect(notFoundMock).not.toHaveBeenCalled();
    });

    it('answers not found when the API refuses the read (ACC-02-21)', async () => {
        getUpstreamMock.mockRejectedValue(new Error('404 not_found'));

        await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');

        expect(notFoundMock).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('app-upstream-card-stub')).toBeNull();
    });

    it('answers not found for a linked App Work, which has no upstream (FR-44)', async () => {
        getUpstreamMock.mockResolvedValue(
            upstreamState({ relation: 'link', upstream: null, sync: null }),
        );

        await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');

        expect(notFoundMock).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('app-upstream-card-stub')).toBeNull();
    });

    it('answers not found for a private copy whose read failed, never an empty card', async () => {
        getUpstreamMock.mockRejectedValue(new Error('500'));

        await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');

        expect(screen.queryByTestId('app-upstream-pull-requests-slot')).toBeNull();
    });

    it('hands the API answer to the card unchanged (no re-derivation on this page)', async () => {
        const state = upstreamState({
            readiness: {
                state: 'timed_out',
                startedAt: '2026-09-16T12:00:00.000Z',
                manualRetriesLeft: 2,
            },
        });
        getUpstreamMock.mockResolvedValue(state);

        render(await renderPage());

        expect(screen.getByTestId('app-upstream-card-stub')).toHaveAttribute(
            'data-relation',
            'fork',
        );
    });
});
