import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

vi.mock('next/navigation', () => ({
    useRouter: () => ({ refresh: vi.fn() }),
}));

// `Button` pulls in the locale-aware Link, which would otherwise drag
// next-intl's navigation module (and the real next/navigation) in.
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
    Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
        <a href={href}>{children}</a>
    ),
}));

vi.mock('@/app/actions/tasks', () => ({
    clearTaskRecurringAction: vi.fn(),
    setTaskRecurringAction: vi.fn(),
}));

import { TaskRecurringSection } from './TaskRecurringSection';
import type { Task } from '@/lib/api/tasks';

function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: 't-1',
        title: 'Ship it',
        status: 'todo',
        priority: 'medium',
        isRecurring: false,
        ...overrides,
    } as unknown as Task;
}

/**
 * The recurring panel lives in the Task detail rail, so it has to read as
 * one of the rail's cards — same neutral shell, same shared `Select` /
 * `Input` controls, no hardcoded English. These specs pin the parts a
 * restyle can silently break: the section handle, the shared pickers,
 * and the fact that every label comes from the i18n namespace.
 */
describe('TaskRecurringSection', () => {
    it('offers the promote CTA when the Task does not repeat', () => {
        render(<TaskRecurringSection task={makeTask()} />);

        expect(screen.getByTestId('task-recurring-section')).toBeTruthy();
        expect(screen.getByText('dashboard.tasksPage.recurring.inactiveHint')).toBeTruthy();
        expect(screen.getByTestId('task-recurring-promote')).toBeTruthy();
    });

    it('opens the picker on the shared Select, not a bare <select>', async () => {
        const user = userEvent.setup();
        render(<TaskRecurringSection task={makeTask()} />);

        await user.click(screen.getByTestId('task-recurring-promote'));

        const frequency = screen.getByTestId('task-recurring-frequency');
        // The rail's Select renders a listbox trigger button; a native
        // <select> would not carry these.
        expect(frequency.tagName).toBe('BUTTON');
        expect(frequency.getAttribute('aria-haspopup')).toBe('listbox');
        expect(screen.getByTestId('task-recurring-save')).toBeTruthy();
    });

    it('lists the live schedule and the demote action when the Task repeats', () => {
        render(
            <TaskRecurringSection
                task={makeTask({
                    isRecurring: true,
                    recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO',
                    recurrenceTimezone: 'Europe/Berlin',
                })}
            />,
        );

        expect(screen.getByText('FREQ=WEEKLY;BYDAY=MO')).toBeTruthy();
        expect(screen.getByText('Europe/Berlin')).toBeTruthy();
        expect(screen.getByTestId('task-recurring-demote')).toBeTruthy();
    });
});
