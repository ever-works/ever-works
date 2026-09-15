import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InboxItem, InboxReplyOutcome } from '@/lib/api/inbox.shared';

/**
 * The one reply box behind both Inbox views. What is pinned:
 *
 *   - without `requireReason` it is exactly the Inbox composer it always
 *     was (an approval offers only approve / reject, no free text, and the
 *     reply does not opt into the reason rule);
 *   - with it (My Decisions), rejecting or answering against the
 *     recommendation needs a sentence first — the send button stays
 *     disabled and the field is labelled required — and the reply opts in
 *     so the API enforces the same rule;
 *   - a failed reply reports the error and never reports success.
 */

const actions = vi.hoisted(() => ({ reply: vi.fn() }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));
vi.mock('sonner', () => ({ toast: toasts }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
vi.mock('@/app/actions/dashboard/inbox', () => ({
    replyToInboxItemAction: actions.reply,
}));

import { InboxReplyComposer } from './InboxReplyComposer';

function item(overrides: Partial<InboxItem> = {}): InboxItem {
    return {
        id: 'i1',
        kind: 'approval',
        title: 'Send the customer email?',
        body: 'Send the customer email?',
        options: [
            { id: 'approve', label: 'Approve' },
            { id: 'reject', label: 'Reject' },
        ],
        sourceType: 'proposal',
        agentId: 'agent-1',
        agentRunId: 'run-1',
        taskId: null,
        workId: null,
        escalationId: null,
        proposalId: 'p1',
        status: 'open',
        unread: false,
        answeredAt: null,
        answerText: null,
        answerOptionId: null,
        createdAt: '2026-09-03T10:00:00.000Z',
        updatedAt: '2026-09-03T10:00:00.000Z',
        ...overrides,
    };
}

function outcome(): InboxReplyOutcome {
    return { item: item({ status: 'answered' }), routed: 'rejected', restart: 'none' };
}

function radio(label: string): HTMLInputElement {
    const node = screen.getByText(label).closest('label')?.querySelector('input');
    if (!node) throw new Error(`no radio for ${label}`);
    return node as HTMLInputElement;
}

beforeEach(() => {
    actions.reply.mockReset();
    toasts.success.mockReset();
    toasts.error.mockReset();
});

describe('InboxReplyComposer — the Inbox message view (no reason rule)', () => {
    it('offers an approval only approve / reject, with no free text', () => {
        render(<InboxReplyComposer item={item()} onReplied={vi.fn()} />);
        expect(screen.queryByTestId('inbox-reply-textarea')).toBeNull();
        expect(screen.queryByTestId('inbox-reply-reason-label')).toBeNull();
    });

    it('sends a rejection without a reason and without opting into the rule', async () => {
        actions.reply.mockResolvedValue(outcome());
        const onReplied = vi.fn();
        render(<InboxReplyComposer item={item()} onReplied={onReplied} />);

        fireEvent.click(radio('Reject'));
        const send = screen.getByTestId('inbox-send-reply') as HTMLButtonElement;
        expect(send.disabled).toBe(false);
        fireEvent.click(send);

        await waitFor(() => expect(onReplied).toHaveBeenCalledTimes(1));
        expect(actions.reply).toHaveBeenCalledWith('i1', { optionId: 'reject' });
    });
});

describe('InboxReplyComposer — My Decisions (requireReason)', () => {
    it('requires a reason to reject, then sends it with the rule opted in', async () => {
        actions.reply.mockResolvedValue(outcome());
        const onReplied = vi.fn();
        render(<InboxReplyComposer item={item()} requireReason onReplied={onReplied} />);

        fireEvent.click(radio('Reject'));
        expect(screen.getByTestId('inbox-reply-reason-label').textContent).toBe(
            'dashboard.inbox.reply.reasonRequired',
        );
        const textarea = screen.getByTestId('inbox-reply-textarea');
        expect(textarea.getAttribute('aria-required')).toBe('true');
        expect(textarea.getAttribute('aria-describedby')).toBeTruthy();
        const send = screen.getByTestId('inbox-send-reply') as HTMLButtonElement;
        expect(send.disabled).toBe(true);

        // Whitespace is not a reason.
        fireEvent.change(textarea, { target: { value: '   ' } });
        expect(send.disabled).toBe(true);

        fireEvent.change(textarea, { target: { value: 'Budget is capped this quarter.' } });
        expect(send.disabled).toBe(false);
        fireEvent.click(send);

        await waitFor(() => expect(onReplied).toHaveBeenCalledTimes(1));
        expect(actions.reply).toHaveBeenCalledWith('i1', {
            text: 'Budget is capped this quarter.',
            optionId: 'reject',
            requireReason: true,
        });
    });

    it('keeps the reason optional for an approval', () => {
        render(<InboxReplyComposer item={item()} requireReason onReplied={vi.fn()} />);
        fireEvent.click(radio('Approve'));
        expect(screen.getByTestId('inbox-reply-reason-label').textContent).toBe(
            'dashboard.inbox.reply.reasonOptional',
        );
        expect((screen.getByTestId('inbox-send-reply') as HTMLButtonElement).disabled).toBe(false);
    });

    it('requires a reason only when a question is answered against its recommendation', () => {
        const question = item({
            kind: 'question',
            sourceType: 'agent-run',
            proposalId: null,
            options: [
                { id: 'pro', label: 'Pro', recommended: true },
                { id: 'standard', label: 'Standard' },
            ],
        });
        render(<InboxReplyComposer item={question} requireReason onReplied={vi.fn()} />);
        const send = screen.getByTestId('inbox-send-reply') as HTMLButtonElement;

        fireEvent.click(radio('Standard'));
        expect(send.disabled).toBe(true);
        fireEvent.click(radio('Pro'));
        expect(send.disabled).toBe(false);
    });

    it('reports a failed reply and never calls it answered', async () => {
        actions.reply.mockRejectedValue(new Error('Inbox item i1 is already answered.'));
        const onReplied = vi.fn();
        render(<InboxReplyComposer item={item()} requireReason onReplied={onReplied} />);

        fireEvent.click(radio('Approve'));
        fireEvent.click(screen.getByTestId('inbox-send-reply'));

        await waitFor(() =>
            expect(toasts.error).toHaveBeenCalledWith('Inbox item i1 is already answered.'),
        );
        expect(onReplied).not.toHaveBeenCalled();
    });
});
