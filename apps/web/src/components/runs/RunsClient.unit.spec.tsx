import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunLedgerPage, RunLedgerRow, RunWindowStats } from '@ever-works/contracts';
import { RunsClient } from './RunsClient';
import { buildRunsSearch, RUNS_GRANULARITY_STORAGE_KEY } from './runs.shared';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
    useLocale: () => 'en-US',
}));

const replace = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
    useRouter: () => ({ replace }),
    usePathname: () => '/runs',
}));

const getRunsAction = vi.fn();
const getRunStatsAction = vi.fn();
const getRunReceiptAction = vi.fn();
vi.mock('@/app/actions/runs', () => ({
    getRunsAction: (...args: unknown[]) => getRunsAction(...args),
    getRunStatsAction: (...args: unknown[]) => getRunStatsAction(...args),
    getRunReceiptAction: (...args: unknown[]) => getRunReceiptAction(...args),
}));

// The real Select is a headless listbox; a native select keeps these
// assertions about the page's wiring rather than about the widget.
vi.mock('@/components/ui/select', () => ({
    Select: ({
        value,
        onValueChange,
        children,
        'aria-label': ariaLabel,
        'data-testid': testId,
    }: {
        value?: string;
        onValueChange?: (value: string) => void;
        children?: React.ReactNode;
        'aria-label'?: string;
        'data-testid'?: string;
    }) => (
        <select
            value={value}
            aria-label={ariaLabel}
            data-testid={testId}
            onChange={(event) => onValueChange?.(event.target.value)}
        >
            {children}
        </select>
    ),
}));

/**
 * Runs ledger (AW-09) — the page's client shell.
 *
 * Pinned: shortcuts act on the page but never while typing; every view
 * change reaches the URL and refetches the list AND the rail with the same
 * window and filters; the list and the rail fail independently; the three
 * empty answers stay distinct; the rail's error count is a filter shortcut.
 */

const RUN_A = '9f9f9f9f-6f6a-4c55-9a4c-1f2b3c4d5e6f';
const RUN_B = '8e8e8e8e-6f6a-4c55-9a4c-1f2b3c4d5e6f';
const AGENT = '0b7e7c1e-6f6a-4c55-9a4c-1f2b3c4d5e6f';

const WINDOW = {
    granularity: 'day' as const,
    anchorDate: '2026-09-08',
    from: '2026-09-08T00:00:00.000Z',
    to: '2026-09-09T00:00:00.000Z',
    timezone: 'UTC',
    clamped: false,
};

function row(id: string, over: Partial<RunLedgerRow> = {}): RunLedgerRow {
    return {
        id,
        agentId: AGENT,
        agentName: 'Ops',
        agentArchived: false,
        triggerKind: 'heartbeat',
        status: 'completed',
        startedAt: '2026-09-08T09:00:00.000Z',
        createdAt: '2026-09-08T08:59:00.000Z',
        finishedAt: '2026-09-08T09:01:12.000Z',
        durationMs: 72_000,
        costCents: 4,
        totalTokens: 900,
        summary: 'Checked the inbox',
        errorMessage: null,
        currentActivity: null,
        taskId: null,
        taskTitle: null,
        missionId: null,
        missionTitle: null,
        workId: null,
        workName: null,
        scheduleKey: `agent_heartbeat:${AGENT}`,
        awaitingInput: false,
        queuedReason: null,
        attentionReason: null,
        ...over,
    };
}

function page(over: Partial<RunLedgerPage> = {}): RunLedgerPage {
    return {
        window: WINDOW,
        rows: [row(RUN_A), row(RUN_B, { status: 'failed', startedAt: '2026-09-08T08:00:00.000Z' })],
        nextCursor: null,
        total: 2,
        limit: 50,
        everRan: null,
        ...over,
    };
}

function stats(over: Partial<RunWindowStats> = {}): RunWindowStats {
    return {
        window: WINDOW,
        total: 2,
        byStatus: { queued: 0, running: 0, completed: 1, failed: 1, cancelled: 0 },
        byTrigger: { heartbeat: 2 },
        successRate: 50,
        errorCount: 1,
        totalDurationMs: 144_000,
        costCents: 8,
        unsettledRuns: 0,
        tokens: { input: null, output: null, cacheRead: null, cacheWrite: null, total: 1800 },
        repeatFailures: [],
        ...over,
    };
}

/** What the viewer's address bar shows (path + query). */
function addressBar(): string {
    return `${window.location.pathname}${window.location.search}`;
}

let replaceState: MockInstance<History['replaceState']>;

/**
 * Mount the client as the server would have rendered it: by default the
 * address bar is the URL `initialView` was parsed from. `url` overrides it,
 * for a mount where the two differ (Back/Forward replaying a cached render).
 */
function renderClient(over: Partial<React.ComponentProps<typeof RunsClient>> = {}, url?: string) {
    const initialView = over.initialView ?? {
        granularity: 'day' as const,
        date: '2026-09-08',
        filters: {},
        runId: null,
    };
    window.history.replaceState(null, '', url ?? `/runs?${buildRunsSearch(initialView)}`);
    replaceState.mockClear();
    return render(
        <RunsClient
            granularityFromUrl
            timeZone="UTC"
            initialPage={page()}
            initialStats={stats()}
            agents={[{ id: AGENT, name: 'Ops', archived: false }]}
            {...over}
            initialView={initialView}
        />,
    );
}

describe('RunsClient', () => {
    beforeEach(() => {
        replace.mockReset();
        replaceState = vi.spyOn(window.history, 'replaceState');
        getRunsAction.mockReset().mockResolvedValue(page());
        getRunStatsAction.mockReset().mockResolvedValue(stats());
        getRunReceiptAction.mockReset().mockResolvedValue(null);
    });

    afterEach(() => {
        vi.useRealTimers();
        replaceState.mockRestore();
        try {
            localStorage.clear();
        } catch {
            // jsdom always has storage; nothing to reset otherwise.
        }
    });

    it('renders the window as a captioned table with outcome icons and text', () => {
        renderClient();

        const table = screen.getByTestId('runs-table');
        expect(table.querySelector('caption')?.textContent).toContain('table.caption');
        const outcomes = within(table).getAllByTestId('run-outcome');
        expect(outcomes.map((badge) => badge.textContent)).toEqual(['completed', 'failed']);
        expect(outcomes[0].querySelector('svg')).not.toBeNull();
    });

    it('switches to Week with `w`, mirrors it into the URL and refetches list and rail', async () => {
        renderClient();

        fireEvent.keyDown(document.body, { key: 'w' });

        await waitFor(() => expect(getRunsAction).toHaveBeenCalled());
        expect(getRunsAction.mock.calls[0][0]).toMatchObject({
            granularity: 'week',
            timezone: 'UTC',
        });
        expect(getRunStatsAction.mock.calls[0][0]).toMatchObject({ granularity: 'week' });
        expect(addressBar()).toBe('/runs?g=week&d=2026-09-08');
    });

    // The e2e "keyboard shortcuts move the window and the URL follows" failed
    // with Week selected and the URL still on `g=day` for 5 s: `router.replace`
    // only commits the URL when its RSC transition commits. The address bar
    // must already show the view when the keystroke's render has committed —
    // no awaiting here — and the page must not ask the router for a server
    // render it never uses (the actions above refetch the window).
    it('writes the view into the address bar in the same commit, without a router navigation', () => {
        renderClient();

        fireEvent.keyDown(document.body, { key: 'w' });

        expect(addressBar()).toBe('/runs?g=week&d=2026-09-08');
        expect(replaceState).toHaveBeenCalledTimes(1);
        expect(replace).not.toHaveBeenCalled();
    });

    it("keeps the address bar's own path, workspace prefix included", () => {
        renderClient({}, '/org/acme/runs?g=day&d=2026-09-08');

        fireEvent.keyDown(document.body, { key: 'm' });

        expect(addressBar()).toBe('/org/acme/runs?g=month&d=2026-09-08');
    });

    // Back/Forward onto a history entry the mirror rewrote replays the server
    // render the page was LOADED with (the router's back/forward cache ignores
    // stale time), so `initialView` can be older than the address bar.
    it('adopts the view the address bar names when it differs from the server render', async () => {
        renderClient({}, '/runs?g=week&d=2026-09-01&status=failed');

        await waitFor(() => expect(getRunsAction).toHaveBeenCalled());
        expect(getRunsAction.mock.calls[0][0]).toMatchObject({
            granularity: 'week',
            date: '2026-09-01',
            filters: { statuses: ['failed'] },
        });
        expect(getRunStatsAction.mock.calls[0][0]).toMatchObject({
            granularity: 'week',
            date: '2026-09-01',
            filters: { statuses: ['failed'] },
        });
        expect(addressBar()).toBe('/runs?g=week&d=2026-09-01&status=failed');
    });

    it('trusts the server render when the address bar matches it', async () => {
        renderClient();

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(getRunsAction).not.toHaveBeenCalled();
        expect(getRunStatsAction).not.toHaveBeenCalled();
        expect(replaceState).not.toHaveBeenCalled();
    });

    // `next dev` renders under StrictMode, which re-runs the effects of a
    // client-rendered tree once, tearing parents down first and setting
    // children up first. The App Router patches `history.replaceState` in an
    // effect and puts the browser's back in its cleanup, so a mount-time write
    // on that re-run reaches the unpatched function and wipes the router's
    // `__NA` history state — and the router ignores Back onto an entry without
    // it. Nothing has changed at mount, so nothing may be written.
    it('writes nothing at mount, even when StrictMode re-runs effects under the router', () => {
        function RouterPatchingHistory({ children }: { children: React.ReactNode }) {
            React.useEffect(() => {
                const browserReplaceState = window.history.replaceState;
                window.history.replaceState = function patched(data, unused, url) {
                    const kept = { ...(data ?? {}), __NA: true };
                    return browserReplaceState.call(window.history, kept, unused, url);
                };
                return () => {
                    window.history.replaceState = browserReplaceState;
                };
            }, []);
            return <>{children}</>;
        }
        const initialView = {
            granularity: 'day' as const,
            date: '2026-09-08',
            filters: {},
            runId: null,
        };
        window.history.replaceState({ __NA: true }, '', `/runs?${buildRunsSearch(initialView)}`);
        replaceState.mockClear();

        const { unmount } = render(
            <React.StrictMode>
                <RouterPatchingHistory>
                    <RunsClient
                        granularityFromUrl
                        timeZone="UTC"
                        initialPage={page()}
                        initialStats={stats()}
                        agents={[{ id: AGENT, name: 'Ops', archived: false }]}
                        initialView={initialView}
                    />
                </RouterPatchingHistory>
            </React.StrictMode>,
        );
        try {
            expect(window.history.state).toMatchObject({ __NA: true });
            expect(replaceState).not.toHaveBeenCalled();
            expect(addressBar()).toBe('/runs?g=day&d=2026-09-08');
        } finally {
            // Unpatch while this test's spy is still the "browser" function.
            unmount();
        }
    });

    it('never lets the remembered granularity override one the address bar names', async () => {
        localStorage.setItem(RUNS_GRANULARITY_STORAGE_KEY, 'month');
        // Replayed render of a visit that named no granularity; the entry was
        // since rewritten to name one.
        renderClient({ granularityFromUrl: false }, '/runs?g=day&d=2026-09-07');

        await waitFor(() => expect(getRunsAction).toHaveBeenCalled());
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(getRunsAction.mock.lastCall?.[0]).toMatchObject({
            granularity: 'day',
            date: '2026-09-07',
        });
        expect(addressBar()).toBe('/runs?g=day&d=2026-09-07');
    });

    it('still applies the remembered granularity when the address bar names none', async () => {
        localStorage.setItem(RUNS_GRANULARITY_STORAGE_KEY, 'month');
        renderClient(
            {
                granularityFromUrl: false,
                initialView: { granularity: 'day', date: null, filters: {}, runId: null },
            },
            '/runs',
        );

        await waitFor(() => expect(getRunsAction).toHaveBeenCalled());
        expect(getRunsAction.mock.lastCall?.[0]).toMatchObject({ granularity: 'month' });
        expect(addressBar()).toBe('/runs?g=month');
    });

    it('does not treat typing in the search box as shortcuts', async () => {
        renderClient();
        const search = screen.getByTestId('runs-search');
        search.focus();

        fireEvent.keyDown(search, { key: 'd' });
        fireEvent.keyDown(search, { key: 'w' });
        fireEvent.keyDown(search, { key: 'ArrowLeft' });

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(getRunsAction).not.toHaveBeenCalled();
        expect(replaceState).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();
        expect(addressBar()).toBe('/runs?g=day&d=2026-09-08');
    });

    it('steps back a day with the left arrow', async () => {
        renderClient();

        fireEvent.keyDown(document.body, { key: 'ArrowLeft' });

        await waitFor(() => expect(getRunsAction).toHaveBeenCalled());
        expect(getRunsAction.mock.calls[0][0]).toMatchObject({ date: '2026-09-07' });
    });

    it('moves row focus with j/k and opens the focused receipt with Enter', async () => {
        renderClient();

        fireEvent.keyDown(document.body, { key: 'j' });
        fireEvent.keyDown(document.body, { key: 'j' });
        fireEvent.keyDown(document.body, { key: 'k' });
        expect(document.activeElement?.getAttribute('data-run-id')).toBe(RUN_A);

        fireEvent.keyDown(document.body, { key: 'Enter' });

        await waitFor(() => expect(getRunReceiptAction).toHaveBeenCalledWith(RUN_A));
        expect(addressBar()).toBe(`/runs?g=day&d=2026-09-08&run=${RUN_A}`);
    });

    it('applies outcome = failed from the rail error count without navigating away', async () => {
        renderClient();

        await userEvent
            .setup()
            .click(within(screen.getByTestId('runs-rail-errors')).getByRole('button'));

        await waitFor(() => expect(getRunsAction).toHaveBeenCalled());
        expect(getRunsAction.mock.calls[0][0].filters).toEqual({ statuses: ['failed'] });
        expect(getRunStatsAction.mock.calls[0][0].filters).toEqual({ statuses: ['failed'] });
        expect(addressBar()).toBe('/runs?g=day&d=2026-09-08&status=failed');
    });

    it('keeps the rail when the list fails, and offers a retry', () => {
        renderClient({ initialPage: null });

        expect(screen.getByTestId('runs-list-error').textContent).toContain('errors.loadWindow');
        expect(screen.getByTestId('runs-rail-errors').textContent).toContain('1');
        // The calendar still works so the viewer can step away.
        expect(screen.getByTestId('runs-previous-window')).toBeDefined();
    });

    it('keeps the list when the rail fails', () => {
        renderClient({ initialStats: null });

        expect(screen.getByTestId('runs-rail-error')).toBeDefined();
        expect(screen.getAllByTestId('runs-row')).toHaveLength(2);
    });

    it('tells "no runs yet" apart from "nothing ran in this window" and "no filter matches"', () => {
        const { unmount } = renderClient({
            initialPage: page({ rows: [], total: 0, everRan: false }),
        });
        expect(screen.getByTestId('runs-empty').getAttribute('data-variant')).toBe('never');
        unmount();

        const second = renderClient({ initialPage: page({ rows: [], total: 0, everRan: true }) });
        expect(screen.getByTestId('runs-empty').getAttribute('data-variant')).toBe('window');
        second.unmount();

        renderClient({
            initialView: {
                granularity: 'day',
                date: '2026-09-08',
                filters: { statuses: ['failed'] },
                runId: null,
            },
            initialPage: page({ rows: [], total: 0, everRan: null }),
        });
        expect(screen.getByTestId('runs-empty').getAttribute('data-variant')).toBe('filters');
    });

    it('loads the next page with the cursor and appends it', async () => {
        getRunsAction.mockResolvedValue(
            page({
                rows: [row('7d7d7d7d-6f6a-4c55-9a4c-1f2b3c4d5e6f')],
                nextCursor: null,
                total: 3,
            }),
        );
        renderClient({ initialPage: page({ nextCursor: '1789290000000_x', total: 3 }) });

        await userEvent.setup().click(screen.getByTestId('runs-load-more'));

        await waitFor(() => expect(screen.getAllByTestId('runs-row')).toHaveLength(3));
        expect(getRunsAction.mock.calls[0][0]).toMatchObject({ cursor: '1789290000000_x' });
    });

    it('refreshes every 5 seconds only while the window includes now and a run is open', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date('2026-09-08T12:00:00.000Z'));
        const running = page({
            rows: [row(RUN_A, { status: 'running', durationMs: null, finishedAt: null })],
        });
        getRunsAction.mockResolvedValue(running);
        renderClient({ initialPage: running });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(5_100);
        });
        expect(getRunsAction).toHaveBeenCalledTimes(1);
        expect(getRunStatsAction).toHaveBeenCalledTimes(1);
    });

    it('does not poll when every listed run is finished', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date('2026-09-08T12:00:00.000Z'));
        renderClient();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(11_000);
        });
        expect(getRunsAction).not.toHaveBeenCalled();
    });
});
