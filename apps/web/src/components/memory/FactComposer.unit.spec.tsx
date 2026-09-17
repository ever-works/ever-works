import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${JSON.stringify(values)}` : key,
}));

import { FactComposer } from './FactComposer';

/**
 * The add / edit form. What it must guarantee: the counter agrees with the
 * API about what 500 means (trimmed length), an over-long body cannot be
 * submitted, a failed save keeps the text and says why, and Esc restores.
 */
describe('FactComposer', () => {
    afterEach(() => cleanup());

    it('counts trimmed characters against the 500 limit', () => {
        render(<FactComposer onSubmit={vi.fn()} initialBody="  hello  " />);
        expect(screen.getByTestId('fact-composer-counter').textContent).toBe(
            'bodyCounter:{"count":5,"max":500}',
        );
    });

    it('refuses to submit an empty body', () => {
        const onSubmit = vi.fn();
        render(<FactComposer onSubmit={onSubmit} />);
        expect(screen.getByTestId('fact-composer-save')).toBeDisabled();
    });

    it('disables save and names the count at 501 characters', () => {
        const onSubmit = vi.fn();
        render(<FactComposer onSubmit={onSubmit} initialBody={'x'.repeat(501)} />);
        expect(screen.getByTestId('fact-composer-save')).toBeDisabled();
        expect(screen.getByTestId('fact-composer-counter').textContent).toBe(
            'bodyTooLong:{"count":501,"max":500}',
        );
        expect(screen.getByTestId('fact-composer-input')).toHaveAttribute('aria-invalid', 'true');
    });

    it('submits the trimmed body', async () => {
        const onSubmit = vi.fn().mockResolvedValue({ ok: true });
        render(<FactComposer onSubmit={onSubmit} initialBody="" />);
        fireEvent.change(screen.getByTestId('fact-composer-input'), {
            target: { value: '  Invoices go out on the 1st.  ' },
        });
        fireEvent.click(screen.getByTestId('fact-composer-save'));
        await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Invoices go out on the 1st.'));
    });

    it('keeps the text and shows the refusal when the save fails — never looks saved', async () => {
        const onSubmit = vi.fn().mockResolvedValue({
            ok: false,
            message: 'Memory is full — 2,000 facts is the limit.',
        });
        render(<FactComposer onSubmit={onSubmit} initialBody="one more fact" />);
        fireEvent.click(screen.getByTestId('fact-composer-save'));

        expect(await screen.findByTestId('fact-composer-error')).toHaveTextContent(
            'Memory is full',
        );
        expect(screen.getByTestId('fact-composer-input')).toHaveValue('one more fact');
        expect(screen.getByTestId('fact-composer-save')).not.toBeDisabled();
    });

    it('falls back to its own copy when the refusal has no message', async () => {
        const onSubmit = vi.fn().mockRejectedValue(new Error('network'));
        render(<FactComposer onSubmit={onSubmit} initialBody="x" />);
        fireEvent.click(screen.getByTestId('fact-composer-save'));
        expect(await screen.findByTestId('fact-composer-error')).toHaveTextContent('saveFailed');
    });

    it('saves on Ctrl+Enter', async () => {
        const onSubmit = vi.fn().mockResolvedValue({ ok: true });
        render(<FactComposer onSubmit={onSubmit} initialBody="keyboard fact" />);
        fireEvent.keyDown(screen.getByTestId('fact-composer-input'), {
            key: 'Enter',
            ctrlKey: true,
        });
        await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('keyboard fact'));
    });

    it('restores the previous text and cancels on Esc', () => {
        const onCancel = vi.fn();
        render(<FactComposer onSubmit={vi.fn()} onCancel={onCancel} initialBody="original" />);
        const input = screen.getByTestId('fact-composer-input');
        fireEvent.change(input, { target: { value: 'changed my mind' } });
        fireEvent.keyDown(input, { key: 'Escape' });
        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(input).toHaveValue('original');
    });
});
