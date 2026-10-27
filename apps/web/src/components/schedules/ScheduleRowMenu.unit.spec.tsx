import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
        values ? `${ns}.${key}(${JSON.stringify(values)})` : `${ns}.${key}`,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
    toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}));

vi.mock('@/app/actions/dashboard/schedules', () => ({
    runScheduleNow: vi.fn(),
    pauseSchedule: vi.fn(),
    resumeSchedule: vi.fn(),
}));

import { ScheduleRowMenu, ownerEntryKey } from './ScheduleRowMenu';
import { pauseSchedule, resumeSchedule, runScheduleNow } from '@/app/actions/dashboard/schedules';
import type { ScheduleControls, ScheduleEntry } from '@/lib/api/schedules';

const T = 'dashboard.schedules';

function schedule(
    over: Partial<ScheduleEntry> = {},
    controls?: Partial<ScheduleControls>,
): ScheduleEntry {
    return {
        id: 'data_sync:work-1',
        sourceType: 'data_sync',
        ownerType: 'work',
        ownerId: 'work-1',
        ownerName: 'Docs data sync',
        ownerLink: '/works/work-1',
        cadenceRaw: '30m',
        cadenceHuman: 'Every 30 minutes',
        nextRunAt: null,
        lastRunAt: null,
        lastRunStatus: null,
        status: 'active',
        enabled: true,
        controls: {
            runNow: false,
            pause: false,
            resume: false,
            edit: true,
            duplicate: false,
            reassign: false,
            pauseNeedsAcknowledgement: false,
            disabledReasons: {
                runNow: 'managedOnWork',
                pause: 'managedOnWork',
                resume: 'managedOnWork',
                duplicate: 'noAuthoredForm',
                reassign: 'noAuthoredForm',
            },
            ...controls,
        },
        ...over,
    };
}

async function openMenu(name: string) {
    fireEvent.click(
        screen.getByRole('button', { name: `${T}.actions.menuLabel({"name":"${name}"})` }),
    );
    await waitFor(() => expect(screen.getByTestId('schedule-control-runNow')).toBeTruthy());
}

describe('ScheduleRowMenu', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('lists all six controls in order; disabled ones keep their place and show their reason', async () => {
        render(<ScheduleRowMenu schedule={schedule()} />);
        await openMenu('Docs data sync');

        const order = ['runNow', 'pause', 'resume', 'edit', 'duplicate', 'reassign'].map(
            (control) => screen.getByTestId(`schedule-control-${control}`),
        );
        for (let index = 1; index < order.length; index += 1) {
            // Each control is rendered after the previous one.
            expect(
                order[index - 1].compareDocumentPosition(order[index]) &
                    Node.DOCUMENT_POSITION_FOLLOWING,
            ).toBeTruthy();
        }

        const runNowButton = screen.getByTestId('schedule-control-runNow').closest('button');
        expect(runNowButton?.hasAttribute('disabled')).toBe(true);
        expect(screen.getByTestId('schedule-control-runNow-reason').textContent).toBe(
            `${T}.controlReasons.managedOnWork`,
        );
        expect(screen.getByTestId('schedule-control-duplicate-reason').textContent).toBe(
            `${T}.controlReasons.noAuthoredForm`,
        );
        // Edit applies, so it is a link to the owning editor with no reason.
        expect(screen.getByTestId('schedule-control-edit').getAttribute('href')).toBe(
            '/works/work-1',
        );
        expect(screen.queryByTestId('schedule-control-edit-reason')).toBeNull();
        // The owner entry names what it opens.
        expect(screen.getByTestId('schedule-owner-entry').textContent).toContain(
            `${T}.actions.openWork`,
        );
    });

    it('runs a schedule now and says the next fire is unchanged', async () => {
        vi.mocked(runScheduleNow).mockResolvedValue({
            ok: true,
            result: {
                kind: 'run',
                scheduleId: 'recurring_task:t-1',
                runIds: ['run-1'],
                parked: false,
                queuedReason: null,
                taskId: 'i-1',
                nextRunAt: '2026-09-15T07:00:00.000Z',
            },
        });
        const onChanged = vi.fn();
        render(
            <ScheduleRowMenu
                onChanged={onChanged}
                schedule={schedule(
                    {
                        id: 'recurring_task:t-1',
                        sourceType: 'recurring_task',
                        ownerName: 'Morning scan',
                    },
                    { runNow: true, pause: true, disabledReasons: { resume: 'notPaused' } },
                )}
            />,
        );
        await openMenu('Morning scan');
        fireEvent.click(screen.getByTestId('schedule-control-runNow'));
        await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(`${T}.runNow.queuedToast`));
        // FL-13 (12bf1cc10): run-now now says whether the member confirmed a run on a computer.
        expect(runScheduleNow).toHaveBeenCalledWith('recurring_task:t-1', { confirm: false });
        expect(onChanged).toHaveBeenCalled();
    });

    /** FL-13 (12bf1cc10, FR-25) — a Command schedule on a computer, which runs on a real machine. */
    function nodeSchedule(): ScheduleEntry {
        return schedule(
            {
                id: 'node_schedule:ns-1',
                sourceType: 'node_schedule',
                ownerType: 'node',
                ownerId: 'n-1',
                ownerName: 'Nightly backup',
                ownerLink: '/fleet/computers/n-1/schedules',
            },
            { runNow: true, disabledReasons: {} },
        );
    }

    it('asks before running a schedule on a computer, and sends the confirmation with the run', async () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        vi.mocked(runScheduleNow).mockResolvedValue({
            ok: true,
            result: {
                kind: 'run',
                scheduleId: 'node_schedule:ns-1',
                runIds: ['run-2'],
                parked: false,
                queuedReason: null,
                taskId: null,
                nextRunAt: null,
            },
        });
        render(<ScheduleRowMenu schedule={nodeSchedule()} />);
        await openMenu('Nightly backup');
        expect(screen.getByTestId('schedule-owner-entry').textContent).toContain(
            `${T}.actions.openComputer`,
        );
        fireEvent.click(screen.getByTestId('schedule-control-runNow'));

        await waitFor(() =>
            expect(runScheduleNow).toHaveBeenCalledWith('node_schedule:ns-1', { confirm: true }),
        );
        expect(confirm).toHaveBeenCalledWith(`${T}.runNow.confirmOnComputer({"name":"Nightly backup"})`);
        confirm.mockRestore();
    });

    it('runs nothing on the computer when the member cancels the confirmation', async () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
        render(<ScheduleRowMenu schedule={nodeSchedule()} />);
        await openMenu('Nightly backup');
        fireEvent.click(screen.getByTestId('schedule-control-runNow'));

        await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
        expect(runScheduleNow).not.toHaveBeenCalled();
        expect(toastSuccess).not.toHaveBeenCalled();
        confirm.mockRestore();
    });

    it('explains a refused run-now instead of failing silently', async () => {
        vi.mocked(runScheduleNow).mockResolvedValue({
            ok: false,
            code: 'SCHEDULE_ALREADY_RUNNING',
            reasonKey: null,
            status: 409,
            runId: 'run-0',
        });
        render(
            <ScheduleRowMenu
                schedule={schedule(
                    {
                        id: 'recurring_task:t-1',
                        sourceType: 'recurring_task',
                        ownerName: 'Morning scan',
                    },
                    { runNow: true, pause: true, disabledReasons: {} },
                )}
            />,
        );
        await openMenu('Morning scan');
        fireEvent.click(screen.getByTestId('schedule-control-runNow'));
        await waitFor(() =>
            expect(toastError).toHaveBeenCalledWith(`${T}.runNow.refused.alreadyRunning`),
        );
    });

    it('a Mission tick run-now points at the Mission, not a run', async () => {
        vi.mocked(runScheduleNow).mockResolvedValue({
            ok: true,
            result: {
                kind: 'mission-tick',
                scheduleId: 'mission_tick:m-1',
                missionId: 'm-1',
                ownerLink: '/missions/m-1',
                outcome: 'spawned',
                ideasCreated: 2,
                ideasQueued: null,
            },
        });
        render(
            <ScheduleRowMenu
                schedule={schedule(
                    {
                        id: 'mission_tick:m-1',
                        sourceType: 'mission_tick',
                        ownerType: 'mission',
                        ownerId: 'm-1',
                        ownerName: 'Idea scan',
                        ownerLink: '/missions/m-1',
                    },
                    {
                        runNow: true,
                        pause: true,
                        pauseNeedsAcknowledgement: true,
                        disabledReasons: {},
                    },
                )}
            />,
        );
        await openMenu('Idea scan');
        expect(screen.getByTestId('schedule-history-entry').textContent).toContain(
            `${T}.actions.seeIdeasRaised`,
        );
        fireEvent.click(screen.getByTestId('schedule-control-runNow'));
        await waitFor(() =>
            expect(toastSuccess).toHaveBeenCalledWith(`${T}.runNow.missionTickToast`),
        );
    });

    it('asks before pausing a Mission tick, and only pauses with the acknowledgement', async () => {
        vi.mocked(pauseSchedule).mockResolvedValue({ ok: true, schedule: schedule() });
        render(
            <ScheduleRowMenu
                schedule={schedule(
                    {
                        id: 'mission_tick:m-1',
                        sourceType: 'mission_tick',
                        ownerType: 'mission',
                        ownerName: 'Idea scan',
                        ownerLink: '/missions/m-1',
                    },
                    {
                        runNow: true,
                        pause: true,
                        pauseNeedsAcknowledgement: true,
                        disabledReasons: {},
                    },
                )}
            />,
        );
        await openMenu('Idea scan');
        fireEvent.click(screen.getByTestId('schedule-control-pause'));
        await waitFor(() =>
            expect(screen.getByTestId('schedule-mission-pause-confirm')).toBeTruthy(),
        );
        expect(pauseSchedule).not.toHaveBeenCalled();

        fireEvent.click(screen.getByTestId('schedule-mission-pause-confirm-button'));
        await waitFor(() =>
            expect(pauseSchedule).toHaveBeenCalledWith('mission_tick:m-1', {
                acknowledgeMissionPause: true,
            }),
        );
        await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(`${T}.pauseToast`));
    });

    it('pauses and resumes a recurring Task directly', async () => {
        vi.mocked(pauseSchedule).mockResolvedValue({ ok: true, schedule: schedule() });
        vi.mocked(resumeSchedule).mockResolvedValue({ ok: true, schedule: schedule() });
        const { unmount } = render(
            <ScheduleRowMenu
                schedule={schedule(
                    {
                        id: 'recurring_task:t-1',
                        sourceType: 'recurring_task',
                        ownerName: 'Morning scan',
                    },
                    { runNow: true, pause: true, disabledReasons: { resume: 'notPaused' } },
                )}
            />,
        );
        await openMenu('Morning scan');
        fireEvent.click(screen.getByTestId('schedule-control-pause'));
        await waitFor(() =>
            expect(pauseSchedule).toHaveBeenCalledWith('recurring_task:t-1', {
                acknowledgeMissionPause: false,
            }),
        );
        unmount();

        render(
            <ScheduleRowMenu
                schedule={schedule(
                    {
                        id: 'recurring_task:t-1',
                        sourceType: 'recurring_task',
                        ownerName: 'Morning scan',
                        status: 'paused',
                    },
                    { runNow: true, resume: true, disabledReasons: { pause: 'alreadyPaused' } },
                )}
            />,
        );
        await openMenu('Morning scan');
        expect(screen.getByTestId('schedule-control-pause-reason').textContent).toBe(
            `${T}.controlReasons.alreadyPaused`,
        );
        fireEvent.click(screen.getByTestId('schedule-control-resume'));
        await waitFor(() => expect(resumeSchedule).toHaveBeenCalledWith('recurring_task:t-1'));
    });

    it('names the owner entry per source', () => {
        expect(ownerEntryKey({ sourceType: 'recurring_task' })).toBe('openTask');
        expect(ownerEntryKey({ sourceType: 'agent_heartbeat' })).toBe('openAgent');
        expect(ownerEntryKey({ sourceType: 'mission_tick' })).toBe('openMission');
        expect(ownerEntryKey({ sourceType: 'inbound_trigger' })).toBe('openTriggers');
        expect(ownerEntryKey({ sourceType: 'work_schedule' })).toBe('openWork');
        // FL-13 (12bf1cc10): a Command schedule opens its computer.
        expect(ownerEntryKey({ sourceType: 'node_schedule' })).toBe('openComputer');
    });
});
