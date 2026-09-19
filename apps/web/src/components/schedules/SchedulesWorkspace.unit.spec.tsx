import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

let searchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
    usePathname: () => '/schedules',
    useRouter: () => ({ replace: vi.fn() }),
    useSearchParams: () => searchParams,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
        <a href={href}>{children}</a>
    ),
}));

vi.mock('@/app/actions/dashboard/schedules', () => ({
    getSchedulePage: vi.fn(),
    getScheduleHealth: vi.fn(),
}));

// The shell is under test, not its children — each renders only what the
// assertions below read. The heading is NOT mocked: it is the shared
// `ActivityViewHeader` every Activity view carries, and the assertion below
// pins that this list still renders its own.
vi.mock('./ScheduleHealthBanner', () => ({ ScheduleHealthBanner: () => null }));
vi.mock('./SchedulesFilters', () => ({ SchedulesFilters: () => null }));
vi.mock('./SchedulesDegradedNotice', () => ({ SchedulesDegradedNotice: () => null }));
vi.mock('./SchedulesEmptyState', () => ({
    SchedulesEmptyState: ({ variant }: { variant: string }) => (
        <div data-testid={`empty-${variant}`} />
    ),
}));
vi.mock('./ScheduleWorkspaceRow', () => ({
    ScheduleWorkspaceRow: ({ schedule }: { schedule: { ownerName: string } }) => (
        <div data-testid="schedule-row">{schedule.ownerName}</div>
    ),
}));

import { SchedulesWorkspace } from './SchedulesWorkspace';
import { getSchedulePage, getScheduleHealth } from '@/app/actions/dashboard/schedules';
import type { ScheduleEntry, SchedulePage } from '@/lib/api/schedules';

type PageResponse = Awaited<ReturnType<typeof getSchedulePage>>;

function row(name: string): ScheduleEntry {
    return {
        id: `inbound_trigger:${name}`,
        sourceType: 'inbound_trigger',
        ownerType: 'trigger',
        ownerId: name,
        ownerName: name,
        ownerLink: '/activity?view=schedules',
        cadenceRaw: null,
        cadenceHuman: 'On event',
        nextRunAt: null,
        lastRunAt: null,
        lastRunStatus: null,
        status: 'active',
        enabled: true,
    };
}

function pageOf(names: string[], nextCursor: string | null = null): SchedulePage {
    return {
        items: names.map(row),
        nextCursor,
        total: names.length,
        unfilteredTotal: names.length,
        countsBySourceType: {
            recurring_task: 0,
            agent_heartbeat: 0,
            work_schedule: 0,
            mission_tick: 0,
            source_validation: 0,
            data_sync: 0,
            inbound_trigger: names.length,
        },
        // The PRE-filter breakdown the source chips are built from: it stays
        // complete while a filter narrows `countsBySourceType`.
        unfilteredCountsBySourceType: {
            recurring_task: 0,
            agent_heartbeat: 0,
            work_schedule: 0,
            mission_tick: 0,
            source_validation: 0,
            data_sync: 0,
            inbound_trigger: names.length,
        },
        countsByStatus: { active: names.length, paused: 0, disabled: 0, error: 0, ended: 0 },
        healthCounts: { ok: names.length, neverRuns: 0 },
        degradedSources: [],
        healthCheckedAt: null,
        generatedAt: new Date().toISOString(),
    };
}

/** Each call to the page action returns a response the test resolves by hand. */
function deferPageCalls() {
    const pending: Array<(response: PageResponse) => void> = [];
    vi.mocked(getSchedulePage).mockImplementation(
        () =>
            new Promise<PageResponse>((resolve) => {
                pending.push(resolve);
            }),
    );
    return pending;
}

const ok = (page: SchedulePage) => ({ ok: true, page }) as PageResponse;

function rowNames(): string[] {
    return screen.queryAllByTestId('schedule-row').map((element) => element.textContent ?? '');
}

describe('SchedulesWorkspace — a superseded read never replaces a newer one', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        searchParams = new URLSearchParams();
        vi.mocked(getScheduleHealth).mockResolvedValue({ ok: false } as never);
    });

    it('heads the list with the shared view header, not a second page title', () => {
        // The page's own `h1` is "Activity". This heading is a SECTION heading
        // at the Live Feed's weight — a second big title for a view the reader
        // has already chosen is noise, not orientation.
        render(<SchedulesWorkspace initialPage={pageOf(['A ROW'])} initialHealth={null} />);

        const heading = screen.getByRole('heading', {
            level: 2,
            name: 'dashboard.schedules.title',
        });
        expect(heading.className).toContain('text-base');
        expect(screen.getByText('dashboard.schedules.pageSubtitle')).toBeTruthy();
        // Nothing here renders an h1 of its own.
        expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    });

    function mount(initial: SchedulePage) {
        return render(<SchedulesWorkspace initialPage={initial} initialHealth={null} />);
    }

    /** Change the URL filters the way `router.replace` would, and re-render. */
    function applyFilter(view: ReturnType<typeof mount>, initial: SchedulePage, query: string) {
        searchParams = new URLSearchParams(query);
        view.rerender(<SchedulesWorkspace initialPage={initial} initialHealth={null} />);
    }

    it('an older background refresh that lands after a newer filtered read is dropped', async () => {
        const pending = deferPageCalls();
        const initial = pageOf(['INITIAL ROW']);
        const view = mount(initial);

        // A background refresh starts for the unfiltered query…
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await waitFor(() => expect(pending).toHaveLength(1));

        // …then the owner picks a filter, which starts a newer read.
        applyFilter(view, initial, 'status=paused');
        await waitFor(() => expect(pending).toHaveLength(2));
        expect(vi.mocked(getSchedulePage).mock.calls[1][0]).toMatchObject({ status: 'paused' });

        await act(async () => {
            pending[1](ok(pageOf(['NEW FILTERED ROW'])));
        });
        await waitFor(() => expect(rowNames()).toEqual(['NEW FILTERED ROW']));

        await act(async () => {
            pending[0](ok(pageOf(['OLD UNFILTERED ROW'])));
        });
        expect(rowNames()).toEqual(['NEW FILTERED ROW']);
    });

    it('a superseded read that failed neither shows the failure nor leaves the spinner up', async () => {
        const pending = deferPageCalls();
        const initial = pageOf(['INITIAL ROW']);
        const view = mount(initial);

        applyFilter(view, initial, 'status=paused');
        await waitFor(() => expect(pending).toHaveLength(1));
        applyFilter(view, initial, 'status=active');
        await waitFor(() => expect(pending).toHaveLength(2));

        await act(async () => {
            pending[0]({ ok: false } as PageResponse);
        });
        expect(screen.queryByTestId('schedules-workspace-failed')).toBeNull();
        expect(screen.getByText('dashboard.schedules.loading')).toBeTruthy();

        await act(async () => {
            pending[1](ok(pageOf(['ACTIVE ROW'])));
        });
        await waitFor(() => expect(rowNames()).toEqual(['ACTIVE ROW']));
        expect(screen.queryByText('dashboard.schedules.loading')).toBeNull();
    });

    it('a load-more page for the previous filters is not appended to the new results', async () => {
        const pending = deferPageCalls();
        const initial = pageOf(['PAGE ONE ROW'], 'cursor-2');
        const view = mount(initial);

        fireEvent.click(screen.getByTestId('schedules-load-more'));
        await waitFor(() => expect(pending).toHaveLength(1));

        applyFilter(view, initial, 'status=paused');
        await waitFor(() => expect(pending).toHaveLength(2));

        await act(async () => {
            pending[1](ok(pageOf(['NEW FILTERED ROW'])));
        });
        await waitFor(() => expect(rowNames()).toEqual(['NEW FILTERED ROW']));

        await act(async () => {
            pending[0](ok(pageOf(['STALE PAGE TWO ROW'])));
        });
        expect(rowNames()).toEqual(['NEW FILTERED ROW']);
    });
});

/**
 * The mount that owes a read.
 *
 * This list is two things: the page it used to be (always server-rendered with
 * its first page) and the Activity page's Schedules VIEW, which is reached by
 * clicking a tab — at which point the page on screen was rendered for a
 * different view and carries no schedules payload at all. Skipping the first
 * load unconditionally, as the page always could, left the embedded mount
 * showing its "no match" empty state over a list it had never fetched.
 */
describe('SchedulesWorkspace — first load', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        searchParams = new URLSearchParams();
    });

    it('fetches the page AND the health summary when the host had no payload', async () => {
        vi.mocked(getSchedulePage).mockResolvedValue(ok(pageOf(['FETCHED ROW'])));
        vi.mocked(getScheduleHealth).mockResolvedValue({
            ok: true,
            summary: {
                checkedAt: '',
                counts: { ok: 0, neverRuns: 0 },
                flagged: [],
                degradedSources: [],
            },
        } as never);

        render(<SchedulesWorkspace initialPage={null} initialHealth={null} />);

        await waitFor(() => expect(rowNames()).toEqual(['FETCHED ROW']));
        expect(getSchedulePage).toHaveBeenCalledTimes(1);
        expect(getScheduleHealth).toHaveBeenCalledTimes(1);
        // The empty state must not have been what the reader saw.
        expect(screen.queryByTestId('schedules-empty-filtered')).toBeNull();
    });

    it('never re-fetches a page the server already delivered', async () => {
        vi.mocked(getSchedulePage).mockResolvedValue(ok(pageOf(['SHOULD NOT APPEAR'])));
        vi.mocked(getScheduleHealth).mockResolvedValue({ ok: false } as never);

        render(<SchedulesWorkspace initialPage={pageOf(['SERVER ROW'])} initialHealth={null} />);

        await waitFor(() => expect(rowNames()).toEqual(['SERVER ROW']));
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(getSchedulePage).not.toHaveBeenCalled();
        expect(getScheduleHealth).not.toHaveBeenCalled();
    });

    it('leaves the server’s failure screen alone instead of retrying behind it', async () => {
        vi.mocked(getSchedulePage).mockResolvedValue(ok(pageOf(['SHOULD NOT APPEAR'])));
        vi.mocked(getScheduleHealth).mockResolvedValue({ ok: false } as never);

        render(<SchedulesWorkspace initialPage={null} initialFailed initialHealth={null} />);

        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(getSchedulePage).not.toHaveBeenCalled();
        expect(screen.getByTestId('schedules-workspace-failed')).toBeTruthy();
    });
});
