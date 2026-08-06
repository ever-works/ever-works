import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeleteAgentDialog } from './DeleteAgentDialog';

const deleteAgentHardAction = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values?.name ? `${key}:${String(values.name)}` : key,
}));
// `Button` pulls in the locale-aware Link, which resolves
// `next/navigation` through next-intl — unavailable under jsdom.
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
    toast: {
        success: (...args: unknown[]) => toastSuccess(...args),
        error: (...args: unknown[]) => toastError(...args),
    },
}));
vi.mock('@/app/actions/agents', () => ({
    deleteAgentHardAction: (...args: unknown[]) => deleteAgentHardAction(...args),
}));

const AGENT = { id: 'a1', name: 'CEO' };

describe('DeleteAgentDialog', () => {
    beforeEach(() => {
        deleteAgentHardAction.mockReset().mockResolvedValue({ deleted: true });
        toastSuccess.mockReset();
        toastError.mockReset();
    });

    it('hard-deletes the agent and reports back on confirm', async () => {
        const onOpenChange = vi.fn();
        const onDeleted = vi.fn();
        render(
            <DeleteAgentDialog
                agent={AGENT}
                open
                onOpenChange={onOpenChange}
                onDeleted={onDeleted}
            />,
        );

        await userEvent.click(screen.getByTestId('confirm-delete-agent'));

        await waitFor(() => expect(deleteAgentHardAction).toHaveBeenCalledWith('a1'));
        expect(toastSuccess).toHaveBeenCalledWith('success:CEO');
        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(onDeleted).toHaveBeenCalled();
    });

    it('keeps the dialog open and surfaces the error when the delete fails', async () => {
        deleteAgentHardAction.mockRejectedValue(new Error('nope'));
        const onOpenChange = vi.fn();
        const onDeleted = vi.fn();
        render(
            <DeleteAgentDialog
                agent={AGENT}
                open
                onOpenChange={onOpenChange}
                onDeleted={onDeleted}
            />,
        );

        await userEvent.click(screen.getByTestId('confirm-delete-agent'));

        await waitFor(() => expect(toastError).toHaveBeenCalledWith('nope'));
        expect(onDeleted).not.toHaveBeenCalled();
        expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });

    it('does not call the API when cancelled', async () => {
        const onOpenChange = vi.fn();
        render(<DeleteAgentDialog agent={AGENT} open onOpenChange={onOpenChange} />);

        await userEvent.click(screen.getByText('cancel'));

        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(deleteAgentHardAction).not.toHaveBeenCalled();
    });
});
