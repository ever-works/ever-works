import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { ForgetAllDialog } from './ForgetAllDialog';

/**
 * Forget all. The gate is exact and unforgiving on purpose — the API applies
 * the same comparison — and the blast radius is on screen before the field.
 */
describe('ForgetAllDialog', () => {
    afterEach(() => cleanup());

    function renderDialog(overrides: Partial<React.ComponentProps<typeof ForgetAllDialog>> = {}) {
        const props = {
            open: true,
            counts: { active: 182, proposed: 12 },
            onCancel: vi.fn(),
            onConfirm: vi.fn().mockResolvedValue(true),
            ...overrides,
        };
        render(<ForgetAllDialog {...props} />);
        return props;
    }

    it('states what is not affected before the confirmation field', () => {
        renderDialog();
        const notAffected = screen.getByTestId('forget-all-not-affected');
        const input = screen.getByTestId('forget-all-confirm-input');
        expect(notAffected).toHaveTextContent('notAffected');
        // DOCUMENT_POSITION_FOLLOWING === 4 — the field comes after the copy.
        expect(notAffected.compareDocumentPosition(input) & 4).toBeTruthy();
    });

    it.each(['', 'forget all', 'FORGET', 'FORGET ALL ', ' FORGET ALL', 'FORGET  ALL'])(
        'keeps the button disabled for %j',
        (typed) => {
            renderDialog();
            fireEvent.change(screen.getByTestId('forget-all-confirm-input'), {
                target: { value: typed },
            });
            expect(screen.getByTestId('forget-all-confirm')).toBeDisabled();
        },
    );

    it('arms only on exactly FORGET ALL, then confirms', async () => {
        const props = renderDialog();
        fireEvent.change(screen.getByTestId('forget-all-confirm-input'), {
            target: { value: 'FORGET ALL' },
        });
        const confirm = screen.getByTestId('forget-all-confirm');
        expect(confirm).not.toBeDisabled();
        fireEvent.click(confirm);
        await waitFor(() => expect(props.onConfirm).toHaveBeenCalledTimes(1));
    });

    it('does not confirm when Enter is pressed before the word is typed', () => {
        const props = renderDialog();
        const input = screen.getByTestId('forget-all-confirm-input');
        fireEvent.change(input, { target: { value: 'FORGET' } });
        fireEvent.submit(input.closest('form')!);
        expect(props.onConfirm).not.toHaveBeenCalled();
    });

    it('shows the failure and stays open when the API refuses', async () => {
        renderDialog({ onConfirm: vi.fn().mockResolvedValue(false) });
        fireEvent.change(screen.getByTestId('forget-all-confirm-input'), {
            target: { value: 'FORGET ALL' },
        });
        fireEvent.click(screen.getByTestId('forget-all-confirm'));
        expect(await screen.findByRole('alert')).toHaveTextContent('failed');
        expect(screen.getByTestId('forget-all-dialog')).toBeInTheDocument();
    });

    it('cancels without confirming', () => {
        const props = renderDialog();
        fireEvent.click(screen.getByTestId('forget-all-cancel'));
        expect(props.onCancel).toHaveBeenCalledTimes(1);
        expect(props.onConfirm).not.toHaveBeenCalled();
    });

    it('Esc cancels and never confirms', async () => {
        const props = renderDialog();
        fireEvent.change(screen.getByTestId('forget-all-confirm-input'), {
            target: { value: 'FORGET ALL' },
        });
        fireEvent.keyDown(screen.getByTestId('forget-all-confirm-input'), {
            key: 'Escape',
            code: 'Escape',
        });
        await waitFor(() => expect(props.onCancel).toHaveBeenCalled());
        expect(props.onConfirm).not.toHaveBeenCalled();
    });

    it('renders nothing while closed', () => {
        renderDialog({ open: false });
        expect(screen.queryByTestId('forget-all-dialog')).toBeNull();
    });
});
