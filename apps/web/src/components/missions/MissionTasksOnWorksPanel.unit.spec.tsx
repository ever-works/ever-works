import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * APW-08 T36 (FR-55) — "Tasks on attached Works": the Mission-filed Tasks, 20 per page, linked,
 * with an empty state and a failure state.
 */

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
        <a href={href}>{children}</a>
    ),
}));

const listMissionTasksOnWorksAction = vi.fn();
vi.mock('@/app/actions/dashboard/missions', () => ({
    listMissionTasksOnWorksAction: (...args: unknown[]) => listMissionTasksOnWorksAction(...args),
}));

import { MISSION_TASKS_PAGE_SIZE, MissionTasksOnWorksPanel } from './MissionTasksOnWorksPanel';

const rows = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({
        id: `t-${from + i}`,
        title: `Mission Task ${from + i}`,
        status: 'todo',
    }));

beforeEach(() => vi.clearAllMocks());

describe('MissionTasksOnWorksPanel (APW-08 T36)', () => {
    it('lists the first page, each Task linked, with the total', async () => {
        listMissionTasksOnWorksAction.mockResolvedValue({ rows: rows(1, 3), total: 3 });
        render(<MissionTasksOnWorksPanel missionId="m1" />);
        await waitFor(() => expect(screen.getAllByTestId('mission-task-row')).toHaveLength(3));
        expect(listMissionTasksOnWorksAction).toHaveBeenCalledWith('m1', 0);
        expect(screen.getByText('Mission Task 1').closest('a')).toHaveAttribute(
            'href',
            '/tasks/t-1',
        );
        expect(screen.queryByTestId('mission-tasks-next')).toBeNull();
    });

    it('pages 20 at a time', async () => {
        listMissionTasksOnWorksAction
            .mockResolvedValueOnce({ rows: rows(1, MISSION_TASKS_PAGE_SIZE), total: 25 })
            .mockResolvedValueOnce({ rows: rows(21, 5), total: 25 });
        render(<MissionTasksOnWorksPanel missionId="m1" />);
        await waitFor(() => expect(screen.getAllByTestId('mission-task-row')).toHaveLength(20));
        expect(screen.getByTestId('mission-tasks-previous')).toBeDisabled();
        fireEvent.click(screen.getByTestId('mission-tasks-next'));
        await waitFor(() => expect(screen.getAllByTestId('mission-task-row')).toHaveLength(5));
        expect(listMissionTasksOnWorksAction).toHaveBeenLastCalledWith('m1', 20);
        expect(screen.getByTestId('mission-tasks-next')).toBeDisabled();
    });

    it('says so when nothing is filed yet, and when the read fails', async () => {
        listMissionTasksOnWorksAction.mockResolvedValueOnce({ rows: [], total: 0 });
        const { unmount } = render(<MissionTasksOnWorksPanel missionId="m1" />);
        await waitFor(() => expect(screen.getByTestId('mission-tasks-empty')).toBeInTheDocument());
        unmount();
        listMissionTasksOnWorksAction.mockRejectedValueOnce(new Error('down'));
        render(<MissionTasksOnWorksPanel missionId="m1" />);
        await waitFor(() => expect(screen.getByText('unavailable')).toBeInTheDocument());
    });
});
