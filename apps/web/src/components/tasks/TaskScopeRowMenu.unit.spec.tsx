import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

const routerRefreshMock = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ refresh: routerRefreshMock }),
    // The shared Button primitive reads `Link` at module scope.
    Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
        <a href={href}>{children}</a>
    ),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
    toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}));

vi.mock('@/app/actions/tasks', () => ({
    unassignTaskFromScopeAction: vi.fn(),
}));

import { TaskScopeRowMenu } from './TaskScopeRowMenu';
import { unassignTaskFromScopeAction } from '@/app/actions/tasks';

/** The mocked `useTranslations` renders every key as `namespace.key`. */
const T = 'dashboard.tasksPage.scopedSection';

function renderMenu() {
    render(
        <TaskScopeRowMenu
            taskId="task-1"
            taskTitle="Ship the pricing page"
            scopeKey="missionId"
            scopeId="m1"
        />,
    );
}

/** Open the kebab, then pick its only item. */
async function openConfirm() {
    fireEvent.click(screen.getByRole('button', { name: `${T}.rowMenuLabel` }));
    await waitFor(() => expect(screen.getByText(`${T}.removeMenuItem`)).toBeTruthy());
    fireEvent.click(screen.getByText(`${T}.removeMenuItem`));
    await waitFor(() => expect(screen.getByText(`${T}.confirmTitle`)).toBeTruthy());
}

describe('TaskScopeRowMenu', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(unassignTaskFromScopeAction).mockResolvedValue({
            ok: true,
            task: { id: 'task-1' } as never,
        });
    });

    it('asks in a dialog before detaching, never on the menu click alone', async () => {
        renderMenu();
        await openConfirm();

        // The menu item only opens the question — nothing has been sent.
        expect(unassignTaskFromScopeAction).not.toHaveBeenCalled();
        expect(screen.getByTestId('task-remove-confirm-task-1')).toBeTruthy();
    });

    it('detaches the Task from this scope once confirmed, then refreshes', async () => {
        renderMenu();
        await openConfirm();
        fireEvent.click(screen.getByTestId('task-remove-confirm-task-1'));

        await waitFor(() =>
            expect(unassignTaskFromScopeAction).toHaveBeenCalledWith('task-1', 'missionId', 'm1'),
        );
        expect(toastSuccess).toHaveBeenCalledWith(`${T}.removedToast`);
        expect(routerRefreshMock).toHaveBeenCalled();
    });

    it('cancelling leaves the Task where it is', async () => {
        renderMenu();
        await openConfirm();
        fireEvent.click(screen.getByTestId('task-remove-cancel-task-1'));

        expect(unassignTaskFromScopeAction).not.toHaveBeenCalled();
        await waitFor(() => expect(screen.queryByText(`${T}.confirmTitle`)).toBeNull());
    });

    it("keeps the dialog open and shows the API's sub-task refusal verbatim", async () => {
        // The message IS the instruction here, so it must not be swallowed
        // into generic copy nor thrown into a toast that slides away.
        const refusal =
            'Task task-1 has 2 sub-task(s); re-file or detach them before changing its owners so parent and child scopes cannot diverge.';
        vi.mocked(unassignTaskFromScopeAction).mockResolvedValue({ ok: false, message: refusal });

        renderMenu();
        await openConfirm();
        fireEvent.click(screen.getByTestId('task-remove-confirm-task-1'));

        await waitFor(() =>
            expect(screen.getByTestId('task-remove-error-task-1').textContent).toBe(refusal),
        );
        expect(screen.getByText(`${T}.confirmTitle`)).toBeTruthy();
        expect(routerRefreshMock).not.toHaveBeenCalled();
        expect(toastSuccess).not.toHaveBeenCalled();
    });

    it('falls back to translated copy when the failure carries no message', async () => {
        vi.mocked(unassignTaskFromScopeAction).mockResolvedValue({ ok: false, message: '' });

        renderMenu();
        await openConfirm();
        fireEvent.click(screen.getByTestId('task-remove-confirm-task-1'));

        await waitFor(() =>
            expect(screen.getByTestId('task-remove-error-task-1').textContent).toBe(
                `${T}.removeFailed`,
            ),
        );
    });
});
