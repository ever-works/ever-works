import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@/lib/api/tasks';

const updateTaskPlanningAction = vi.fn();
vi.mock('@/app/actions/tasks', () => ({
    updateTaskPlanningAction: (...args: unknown[]) => updateTaskPlanningAction(...args),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/i18n/navigation', () => ({
    usePathname: () => '/tasks/t-1',
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
    Link: ({ children }: { children: unknown }) => children,
}));

import { TaskPlanningSection } from './TaskPlanningSection';

/**
 * Review 2026-10-17 U9 (F119): a refused save shows the API's reason. Thrown out of a
 * Server Action, production replaced it with a generic "An error occurred…" text.
 */
describe('TaskPlanningSection', () => {
    it("shows the API's reason when the save is refused", async () => {
        updateTaskPlanningAction.mockResolvedValue({ ok: false, message: 'Task t-1 not found.' });
        render(
            <TaskPlanningSection
                task={{ id: 't-1', dueAt: null, startAt: null, estimateMinutes: null } as Task}
            />,
        );
        fireEvent.change(screen.getByTestId('task-planning-estimate'), { target: { value: '30' } });
        await act(async () => {
            fireEvent.click(screen.getByTestId('task-planning-save'));
        });
        expect(updateTaskPlanningAction).toHaveBeenCalledWith('t-1', { estimateMinutes: 30 });
        expect(screen.getByText('Task t-1 not found.')).toBeTruthy();
    });
});
