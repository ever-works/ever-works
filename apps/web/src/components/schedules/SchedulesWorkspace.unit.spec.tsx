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
// assertions below read.
vi.mock('@/components/common/PageHeader', () => ({ PageHeader: () => null }));
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
