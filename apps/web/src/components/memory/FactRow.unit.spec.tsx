import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { FactRow } from './FactRow';
import type { MemoryFactDto } from '@/lib/api/memory-facts-types';

function fact(overrides: Partial<MemoryFactDto> = {}): MemoryFactDto {
    return {
        id: 'f-1',
        body: 'We never quote a delivery date shorter than ten working days.',
        status: 'active',
        origin: 'user',
        scope: 'workspace',
        agentId: null,
        pinned: false,
        sourceRunId: null,
        sourceConversationId: null,
        sourceAgentId: null,
        recallCount: 0,
        lastRecalledAt: null,
        forgottenAt: null,
        restorableUntil: null,
        embedded: false,
        score: null,
        literalMatch: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...overrides,
    };
}

function actions() {
    return {
        onEdit: vi.fn().mockResolvedValue({ ok: true }),
        onTogglePin: vi.fn(),
        onForget: vi.fn(),
        onRestore: vi.fn(),
        onAccept: vi.fn(),
        onDiscard: vi.fn(),
    };
}

describe('FactRow', () => {
    afterEach(() => cleanup());

    it('offers edit / pin / forget on a live fact and nothing for other statuses', () => {
        render(<FactRow fact={fact()} {...actions()} />);
        expect(screen.getByTestId('fact-edit-button-f-1')).toBeInTheDocument();
        expect(screen.getByTestId('fact-pin-button-f-1')).toHaveAttribute('aria-pressed', 'false');
        expect(screen.getByTestId('fact-forget-button-f-1')).toBeInTheDocument();
        expect(screen.queryByTestId('fact-restore-button-f-1')).toBeNull();
        expect(screen.queryByTestId('fact-accept-button-f-1')).toBeNull();
    });

    it('offers accept / discard on a proposal, labelled as proposed', () => {
        const handlers = actions();
        render(<FactRow fact={fact({ status: 'proposed', origin: 'agent' })} {...handlers} />);
        expect(screen.getByText('proposedBadge')).toBeInTheDocument();
        expect(screen.getByText('originAgent')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('fact-accept-button-f-1'));
        fireEvent.click(screen.getByTestId('fact-discard-button-f-1'));
        expect(handlers.onAccept).toHaveBeenCalledTimes(1);
        expect(handlers.onDiscard).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('fact-edit-button-f-1')).toBeNull();
    });

    it('offers only restore on a forgotten fact and shows the restore deadline', () => {
        const handlers = actions();
        render(
            <FactRow
                fact={fact({
                    status: 'forgotten',
                    forgottenAt: new Date().toISOString(),
                    restorableUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
                })}
                {...handlers}
            />,
        );
        fireEvent.click(screen.getByTestId('fact-restore-button-f-1'));
        expect(handlers.onRestore).toHaveBeenCalledTimes(1);
        expect(screen.getByText('restorableUntil')).toBeInTheDocument();
        expect(screen.queryByTestId('fact-forget-button-f-1')).toBeNull();
    });

    it('renders the relevance bar with a number, not colour alone, in search mode', () => {
        render(<FactRow fact={fact({ score: 0.81 })} {...actions()} />);
        expect(screen.getByTestId('fact-relevance-f-1')).toHaveTextContent('relevance');
    });

    it('labels a literal-only search hit', () => {
        render(<FactRow fact={fact({ literalMatch: true, score: null })} {...actions()} />);
        expect(screen.getByText('literalMatch')).toBeInTheDocument();
        expect(screen.queryByTestId('fact-relevance-f-1')).toBeNull();
    });

    it('edits in place and closes the editor only after the save succeeds', async () => {
        const handlers = actions();
        render(<FactRow fact={fact()} {...handlers} />);
        fireEvent.click(screen.getByTestId('fact-edit-button-f-1'));
        const input = screen.getByTestId('fact-edit-f-1-input');
        fireEvent.change(input, { target: { value: 'Escalate anything over 2,000 to a human.' } });
        fireEvent.click(screen.getByTestId('fact-edit-f-1-save'));

        await waitFor(() =>
            expect(handlers.onEdit).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'f-1' }),
                'Escalate anything over 2,000 to a human.',
            ),
        );
        await waitFor(() => expect(screen.queryByTestId('fact-edit-f-1-input')).toBeNull());
    });

    it('keeps the editor open when the save is refused', async () => {
        const handlers = actions();
        handlers.onEdit.mockResolvedValue({
            ok: false,
            message: 'This fact is already remembered.',
        });
        render(<FactRow fact={fact()} {...handlers} />);
        fireEvent.click(screen.getByTestId('fact-edit-button-f-1'));
        fireEvent.change(screen.getByTestId('fact-edit-f-1-input'), { target: { value: 'dup' } });
        fireEvent.click(screen.getByTestId('fact-edit-f-1-save'));

        expect(await screen.findByTestId('fact-edit-f-1-error')).toHaveTextContent(
            'already remembered',
        );
        expect(screen.getByTestId('fact-edit-f-1-input')).toHaveValue('dup');
    });

    it('responds to E / F / P and the arrow keys while focused', () => {
        const handlers = actions();
        const onMoveFocus = vi.fn();
        render(<FactRow fact={fact()} {...handlers} onMoveFocus={onMoveFocus} />);
        const row = screen.getByTestId('fact-row-f-1');

        fireEvent.keyDown(row, { key: 'p' });
        expect(handlers.onTogglePin).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(row, { key: 'f' });
        expect(handlers.onForget).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(row, { key: 'ArrowDown' });
        expect(onMoveFocus).toHaveBeenCalledWith(1);
        fireEvent.keyDown(row, { key: 'e' });
        expect(screen.getByTestId('fact-edit-f-1-input')).toBeInTheDocument();
    });

    it('ignores row shortcuts while busy', () => {
        const handlers = actions();
        render(<FactRow fact={fact()} {...handlers} busy />);
        fireEvent.keyDown(screen.getByTestId('fact-row-f-1'), { key: 'f' });
        expect(handlers.onForget).not.toHaveBeenCalled();
        expect(screen.getByTestId('fact-forget-button-f-1')).toBeDisabled();
    });
});
