import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
        if (!vars) return key;
        return `${key} ${Object.values(vars).join(' ')}`;
    },
}));

vi.mock('next/navigation', () => ({
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

// `Button` pulls in the locale-aware Link, which resolves
// `next/navigation` through next-intl — unavailable under jsdom.
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const scheduleTaskAction = vi.fn();
const unscheduleTaskAction = vi.fn();
const setTaskRecurringAction = vi.fn();
const clearTaskRecurringAction = vi.fn();

vi.mock('@/app/actions/tasks', () => ({
    scheduleTaskAction: (...args: unknown[]) => scheduleTaskAction(...args),
    unscheduleTaskAction: (...args: unknown[]) => unscheduleTaskAction(...args),
    setTaskRecurringAction: (...args: unknown[]) => setTaskRecurringAction(...args),
    clearTaskRecurringAction: (...args: unknown[]) => clearTaskRecurringAction(...args),
}));

import { TaskScheduleSection } from './TaskScheduleSection';
import type { Task } from '@/lib/api/tasks';

/**
 * Tasks upgrades — the three-mode Schedule section.
 *
 * What must hold: the mode the Task is ALREADY in is the one that opens,
 * a one-shot only posts a FUTURE instant (the server rejects the past,
 * and the UI must not make the user discover that via a 400), and a
 * recurring template never offers a conflicting one-shot form.
 */
function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        slug: 'T-1',
        title: 'Ship it',
        status: 'todo',
        priority: 'p3',
        isRecurring: false,
        recurrenceRule: null,
        recurrenceCron: null,
        recurrenceTimezone: 'UTC',
        nextOccurrenceAt: null,
        recurrenceEndsAt: null,
        recurrenceMaxOccurrences: null,
        recurrenceOccurredCount: 0,
        parentRecurringTaskId: null,
        scheduledAt: null,
        scheduleClaimedAt: null,
        ...overrides,
    } as Task;
}

/** `datetime-local` wants local wall-clock, which is what the input emits. */
function localInputValue(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
        date.getHours(),
    )}:${pad(date.getMinutes())}`;
}

describe('TaskScheduleSection', () => {
    beforeEach(() => {
        scheduleTaskAction.mockReset();
        unscheduleTaskAction.mockReset();
        scheduleTaskAction.mockResolvedValue(makeTask());
        unscheduleTaskAction.mockResolvedValue(makeTask());
    });

    it('opens on "Run once" for a Task with no schedule', () => {
        render(<TaskScheduleSection task={makeTask()} />);
        expect(screen.getByTestId('task-schedule-mode-once').getAttribute('aria-checked')).toBe(
            'true',
        );
        expect(screen.queryByTestId('task-schedule-run-at')).toBeNull();
    });

    it('opens on "Scheduled" for a Task that already carries a one-shot slot', () => {
        const at = new Date(Date.now() + 86_400_000);
        render(<TaskScheduleSection task={makeTask({ scheduledAt: at.toISOString() })} />);
        expect(
            screen.getByTestId('task-schedule-mode-scheduled').getAttribute('aria-checked'),
        ).toBe('true');
        expect((screen.getByTestId('task-schedule-run-at') as HTMLInputElement).value).toBe(
            localInputValue(at),
        );
    });

    it('opens on "Recurring" for a recurring template', () => {
        render(
            <TaskScheduleSection
                task={makeTask({ isRecurring: true, recurrenceRule: 'FREQ=DAILY' })}
            />,
        );
        expect(
            screen.getByTestId('task-schedule-mode-recurring').getAttribute('aria-checked'),
        ).toBe('true');
    });

    it('posts the picked instant as an ISO string', async () => {
        const at = new Date(Date.now() + 3 * 86_400_000);
        render(<TaskScheduleSection task={makeTask()} />);
        fireEvent.click(screen.getByTestId('task-schedule-mode-scheduled'));
        fireEvent.change(screen.getByTestId('task-schedule-run-at'), {
            target: { value: localInputValue(at) },
        });
        fireEvent.click(screen.getByTestId('task-schedule-save'));

        await waitFor(() => expect(scheduleTaskAction).toHaveBeenCalledTimes(1));
        const [taskId, iso] = scheduleTaskAction.mock.calls[0];
        expect(taskId).toBe('task-1');
        // Minute precision: the input drops seconds.
        expect(new Date(iso as string).getTime()).toBe(new Date(localInputValue(at)).getTime());
    });

    it('refuses a past instant client-side — never round-trips a guaranteed 400', async () => {
        render(<TaskScheduleSection task={makeTask()} />);
        fireEvent.click(screen.getByTestId('task-schedule-mode-scheduled'));
        fireEvent.change(screen.getByTestId('task-schedule-run-at'), {
            target: { value: localInputValue(new Date(Date.now() - 86_400_000)) },
        });
        fireEvent.click(screen.getByTestId('task-schedule-save'));

        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(scheduleTaskAction).not.toHaveBeenCalled();
    });

    it('offers removal (not a second schedule form) for a recurring template', () => {
        render(
            <TaskScheduleSection
                task={makeTask({ isRecurring: true, recurrenceRule: 'FREQ=DAILY' })}
            />,
        );
        fireEvent.click(screen.getByTestId('task-schedule-mode-scheduled'));
        expect(screen.getByTestId('task-schedule-recurring-conflict')).toBeTruthy();
        expect(screen.queryByTestId('task-schedule-run-at')).toBeNull();
    });

    it('clears an armed one-shot from the Run-once mode', async () => {
        render(
            <TaskScheduleSection
                task={makeTask({ scheduledAt: new Date(Date.now() + 86_400_000).toISOString() })}
            />,
        );
        fireEvent.click(screen.getByTestId('task-schedule-mode-once'));
        fireEvent.click(screen.getByTestId('task-schedule-clear'));

        await waitFor(() => expect(unscheduleTaskAction).toHaveBeenCalledWith('task-1'));
    });
});
