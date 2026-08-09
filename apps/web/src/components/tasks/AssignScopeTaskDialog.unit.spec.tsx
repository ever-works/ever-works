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
    listAssignableScopeTasksAction: vi.fn(),
    assignTaskToScopeAction: vi.fn(),
}));

import { AssignScopeTaskDialog } from './AssignScopeTaskDialog';
import { assignTaskToScopeAction, listAssignableScopeTasksAction } from '@/app/actions/tasks';

const CANDIDATES = [
    {
        id: 'task-1',
        slug: 'TSK-1',
        title: 'Ship the pricing page',
        status: 'todo',
        priority: 'p1',
        reassigns: false,
    },
    {
        id: 'task-2',
        slug: 'TSK-2',
        title: 'Audit the docs sidebar',
        status: 'in_progress',
        priority: 'p2',
        reassigns: true,
    },
];

/** The mocked `useTranslations` renders every key as `namespace.key`. */
const T = 'dashboard.tasksPage.scopedSection';

function renderDialog(onOpenChange = vi.fn()) {
    render(
        <AssignScopeTaskDialog
            scopeKey="missionId"
            scopeId="m1"
            open
            onOpenChange={onOpenChange}
        />,
    );
    return onOpenChange;
}

describe('AssignScopeTaskDialog', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(listAssignableScopeTasksAction).mockResolvedValue(CANDIDATES);
        vi.mocked(assignTaskToScopeAction).mockResolvedValue({
            ok: true,
            task: { id: 'task-1' },
        } as never);
    });

    it('suggests the existing Tasks that are not already on the Mission', async () => {
        renderDialog();

        await waitFor(() => expect(screen.getByText('Ship the pricing page')).toBeTruthy());
        expect(screen.getByText('Audit the docs sidebar')).toBeTruthy();
        expect(listAssignableScopeTasksAction).toHaveBeenCalledWith('missionId', 'm1', '');
    });

    it('flags a candidate that is already filed under another Mission', async () => {
        renderDialog();

        await waitFor(() => expect(screen.getByText('Audit the docs sidebar')).toBeTruthy());
        // Only the `reassigns: true` row carries the move hint.
        expect(screen.getAllByText(`${T}.movesLabel`)).toHaveLength(1);
    });

    it('files the picked Task under the scope, then closes and refreshes', async () => {
        const onOpenChange = renderDialog();

        await waitFor(() => expect(screen.getByText('Ship the pricing page')).toBeTruthy());
        fireEvent.click(screen.getByText('Ship the pricing page'));

        await waitFor(() =>
            expect(assignTaskToScopeAction).toHaveBeenCalledWith('task-1', 'missionId', 'm1'),
        );
        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(routerRefreshMock).toHaveBeenCalled();
        expect(toastSuccess).toHaveBeenCalledWith(`${T}.assignedToast`);
    });

    // A RESOLVED failure, not a rejection: the action returns its refusal
    // so the message survives Next's production redaction of thrown
    // Server-Action errors.
    it('surfaces a failed assign without closing the dialog', async () => {
        vi.mocked(assignTaskToScopeAction).mockResolvedValue({
            ok: false,
            message: 'parent scope mismatch',
        });
        const onOpenChange = renderDialog();

        await waitFor(() => expect(screen.getByText('Audit the docs sidebar')).toBeTruthy());
        fireEvent.click(screen.getByText('Audit the docs sidebar'));

        await waitFor(() => expect(toastError).toHaveBeenCalledWith('parent scope mismatch'));
        expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });

    it('empty state distinguishes "nothing left to add" from "no search matches"', async () => {
        vi.mocked(listAssignableScopeTasksAction).mockResolvedValue([]);
        renderDialog();

        await waitFor(() => expect(screen.getByText(`${T}.assignNoneAvailable`)).toBeTruthy());

        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
        await waitFor(() => expect(screen.getByText(`${T}.assignNoMatches`)).toBeTruthy());
        await waitFor(() =>
            expect(listAssignableScopeTasksAction).toHaveBeenLastCalledWith(
                'missionId',
                'm1',
                'zzz',
            ),
        );
    });
});
