import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Mission } from '@/lib/api/missions';

/**
 * APW-08 T36 (FR-51…FR-53) — the Mission's Output card: the three modes, the Task-output limits
 * shown only when it files Tasks, the bounds the API enforces, and the no-App-Work notice.
 */

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
    toast: {
        success: (...args: unknown[]) => toastSuccess(...args),
        error: (...args: unknown[]) => toastError(...args),
    },
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
        <a href={href}>{children}</a>
    ),
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const updateMissionAction = vi.fn();
vi.mock('@/app/actions/dashboard/missions', () => ({
    updateMissionAction: (...args: unknown[]) => updateMissionAction(...args),
}));

import { MissionOutputCard } from './MissionOutputCard';

function mission(overrides: Partial<Mission> = {}): Mission {
    return {
        id: 'm1',
        title: 'Grow Bookings',
        outputMode: 'ideas',
        taskOutput: { tasksPerTick: 1, openTasksCap: 3 },
        ...overrides,
    } as Mission;
}

beforeEach(() => {
    vi.clearAllMocks();
    updateMissionAction.mockImplementation(async (_id: string, input: Partial<Mission>) =>
        mission({ ...input } as Partial<Mission>),
    );
});

describe('MissionOutputCard (APW-08 T36)', () => {
    it('an ideas Mission shows the three modes and no Task limits', () => {
        render(<MissionOutputCard mission={mission()} hasAppWork onMissionChange={vi.fn()} />);
        expect(screen.getByTestId('mission-output-ideas')).toBeChecked();
        expect(screen.getByTestId('mission-output-tasks')).not.toBeChecked();
        expect(screen.queryByTestId('mission-output-limits')).toBeNull();
    });

    it('choosing Tasks shows the limits; Save sends the mode and the bounded output', async () => {
        const onMissionChange = vi.fn();
        render(
            <MissionOutputCard mission={mission()} hasAppWork onMissionChange={onMissionChange} />,
        );
        fireEvent.click(screen.getByTestId('mission-output-tasks'));
        expect(screen.getByTestId('mission-output-limits')).toBeInTheDocument();
        fireEvent.change(screen.getByTestId('mission-output-per-tick'), { target: { value: '9' } });
        fireEvent.change(screen.getByTestId('mission-output-open-cap'), { target: { value: '0' } });
        fireEvent.click(screen.getByTestId('mission-output-save'));
        await waitFor(() =>
            expect(updateMissionAction).toHaveBeenCalledWith('m1', {
                outputMode: 'tasks',
                taskOutput: { tasksPerTick: 3, openTasksCap: 1 },
            }),
        );
        expect(onMissionChange).toHaveBeenCalledWith(
            expect.objectContaining({ outputMode: 'tasks' }),
        );
        expect(toastSuccess).toHaveBeenCalledWith('saved');
    });

    it('with no App Work attached, says what to attach — before saving, and after the API warns', async () => {
        const { unmount } = render(
            <MissionOutputCard
                mission={mission({ outputMode: 'both' })}
                hasAppWork={false}
                onMissionChange={vi.fn()}
            />,
        );
        expect(screen.getByTestId('mission-output-no-app-work')).toHaveTextContent('noAppWork');
        unmount();

        updateMissionAction.mockResolvedValueOnce(
            mission({ outputMode: 'tasks', warnings: ['noAppWorkRelation'] }),
        );
        render(<MissionOutputCard mission={mission()} hasAppWork onMissionChange={vi.fn()} />);
        fireEvent.click(screen.getByTestId('mission-output-tasks'));
        expect(screen.queryByTestId('mission-output-no-app-work')).toBeNull();
        fireEvent.click(screen.getByTestId('mission-output-save'));
        await waitFor(() =>
            expect(screen.getByTestId('mission-output-no-app-work')).toBeInTheDocument(),
        );
    });

    it('a refused save shows the error and leaves the Mission as it was', async () => {
        updateMissionAction.mockRejectedValueOnce(
            new Error('outputMode must be one of ideas, tasks, both.'),
        );
        const onMissionChange = vi.fn();
        render(
            <MissionOutputCard mission={mission()} hasAppWork onMissionChange={onMissionChange} />,
        );
        fireEvent.click(screen.getByTestId('mission-output-save'));
        await waitFor(() => expect(toastError).toHaveBeenCalled());
        expect(onMissionChange).not.toHaveBeenCalled();
    });
});
