import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Goal } from '@/lib/api/goals';

/**
 * APW-08 T33 (FR-45, S10) — the Goal page's Work section: the Work as a link, the change
 * control, locked while the loop runs (the API's `409 loopRunning`), and "No Work" clearing it
 * to `null`.
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

const refresh = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), refresh }),
    Link: ({
        children,
        href,
        ...rest
    }: { children?: React.ReactNode; href?: string } & Record<string, unknown>) => (
        <a href={href} data-testid={rest['data-testid'] as string | undefined}>
            {children}
        </a>
    ),
}));

const updateGoalAction = vi.fn();
vi.mock('./actions', () => ({
    updateGoalAction: (...args: unknown[]) => updateGoalAction(...args),
}));

vi.mock('@/components/tasks/WorkSelect', () => ({
    WorkSelect: ({
        value,
        onValueChange,
        disabled,
        noneLabel,
        testId,
        id,
    }: {
        value: string;
        onValueChange: (v: string) => void;
        disabled?: boolean;
        noneLabel: string;
        testId?: string;
        id?: string;
    }) => (
        <select
            data-testid={testId}
            id={id}
            value={value}
            disabled={disabled}
            onChange={(e) => onValueChange(e.currentTarget.value)}
        >
            <option value="">{noneLabel}</option>
            <option value="w-bookings">Bookings</option>
            <option value="w-shop">Shop</option>
        </select>
    ),
}));

import { GoalWorkSection } from './GoalWorkSection';

function goal(overrides: Partial<Goal> = {}): Goal {
    return {
        id: 'g1',
        title: 'Customer self-service',
        loopStatus: 'paused',
        workId: 'w-bookings',
        workName: 'Bookings',
        ...overrides,
    } as Goal;
}

beforeEach(() => {
    vi.clearAllMocks();
    updateGoalAction.mockImplementation(async (_id: string, input: { workId: string | null }) =>
        goal({ workId: input.workId, workName: undefined }),
    );
});

describe('GoalWorkSection (APW-08 T33)', () => {
    it('links the Work by name; a Goal with no Work says so', () => {
        const { unmount } = render(<GoalWorkSection goal={goal()} onGoalChange={vi.fn()} />);
        const chip = screen.getByTestId('goal-work-chip');
        expect(chip).toHaveTextContent('Bookings');
        expect(chip).toHaveAttribute('href', '/works/w-bookings');
        unmount();

        render(
            <GoalWorkSection
                goal={goal({ workId: null, workName: null })}
                onGoalChange={vi.fn()}
            />,
        );
        expect(screen.queryByTestId('goal-work-chip')).toBeNull();
        expect(screen.getAllByText('work.none').length).toBeGreaterThan(0);
    });

    it('changes the Work while the loop is not running, and "No Work" clears it to null', async () => {
        const onGoalChange = vi.fn();
        render(<GoalWorkSection goal={goal()} onGoalChange={onGoalChange} />);
        const select = screen.getByTestId('goal-detail-work-select');
        expect(select).not.toBeDisabled();

        fireEvent.change(select, { target: { value: 'w-shop' } });
        await waitFor(() =>
            expect(updateGoalAction).toHaveBeenCalledWith('g1', { workId: 'w-shop' }),
        );
        fireEvent.change(select, { target: { value: '' } });
        await waitFor(() => expect(updateGoalAction).toHaveBeenCalledWith('g1', { workId: null }));
        expect(onGoalChange).toHaveBeenLastCalledWith(
            expect.objectContaining({ workId: null, workName: null }),
        );
        expect(toastSuccess).toHaveBeenCalledWith('work.saved');
    });

    it('is locked while the loop runs, and says to pause it', () => {
        render(<GoalWorkSection goal={goal({ loopStatus: 'running' })} onGoalChange={vi.fn()} />);
        expect(screen.getByTestId('goal-detail-work-select')).toBeDisabled();
        expect(screen.getByTestId('goal-work-hint')).toHaveTextContent('work.lockedWhileRunning');
    });

    it('a refused change shows the error and leaves the Goal as it was', async () => {
        updateGoalAction.mockRejectedValueOnce(new Error('loopRunning'));
        const onGoalChange = vi.fn();
        render(<GoalWorkSection goal={goal()} onGoalChange={onGoalChange} />);
        fireEvent.change(screen.getByTestId('goal-detail-work-select'), {
            target: { value: 'w-shop' },
        });
        await waitFor(() => expect(toastError).toHaveBeenCalledWith('loopRunning'));
        expect(onGoalChange).not.toHaveBeenCalled();
    });
});
