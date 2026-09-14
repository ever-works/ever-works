import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { EmailMessageListItem } from '@/lib/api/email-addresses';

const { inboxState, streamMock, approveMock, discardMock } = vi.hoisted(() => ({
    inboxState: {
        messages: [] as unknown[],
        isLoading: true,
        error: null as Error | null,
        mutate: vi.fn(async () => undefined),
    },
    streamMock: vi.fn(),
    approveMock: vi.fn(),
    discardMock: vi.fn(),
}));

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${JSON.stringify(values)}` : key,
}));
vi.mock('@/lib/hooks/use-agent-inbox', () => ({ useAgentInbox: () => inboxState }));
vi.mock('@/lib/hooks/use-inbox-stream', () => ({ useInboxStream: streamMock }));
vi.mock('@/app/[locale]/(dashboard)/agents/[id]/inbox/actions', () => ({
    approveDraftAction: approveMock,
    discardDraftAction: discardMock,
}));

import { AgentInboxPanel } from './AgentInboxPanel';

function message(overrides: Partial<EmailMessageListItem>): EmailMessageListItem {
    return {
        id: 'm-1',
        direction: 'outbound',
        from: 'nova@x.com',
        toAddresses: ['ada@x.com'],
        subject: 'Quarterly numbers',
        pluginId: 'postmark',
        sentAt: null,
        receivedAt: null,
        deliveryStatus: null,
        createdAt: '2026-09-14T10:00:00.000Z',
        status: 'sent',
        ...overrides,
    };
}

describe('AgentInboxPanel (AW-05)', () => {
    beforeEach(() => {
        inboxState.messages = [];
        inboxState.isLoading = true;
        inboxState.error = null;
        inboxState.mutate.mockClear();
        streamMock.mockClear();
        approveMock.mockReset();
        discardMock.mockReset();
    });

    it('subscribes to the live stream with the inbox store refresh', () => {
        render(<AgentInboxPanel agentId="agent-1" initialMessages={[]} />);
        expect(streamMock).toHaveBeenCalledWith('agent-1', inboxState.mutate);
    });

    it('shows the server-rendered list until the live list arrives, then the live one', () => {
        const { rerender } = render(
            <AgentInboxPanel
                agentId="agent-1"
                initialMessages={[message({ id: 'ssr', subject: 'From the server' })]}
            />,
        );
        expect(screen.getByText('From the server')).toBeInTheDocument();

        inboxState.isLoading = false;
        inboxState.messages = [message({ id: 'live', subject: 'Arrived live' })];
        rerender(
            <AgentInboxPanel
                agentId="agent-1"
                initialMessages={[message({ id: 'ssr', subject: 'From the server' })]}
            />,
        );
        expect(screen.getByText('Arrived live')).toBeInTheDocument();
        expect(screen.queryByText('From the server')).not.toBeInTheDocument();
    });

    it('keeps the server-rendered list when the live fetch fails', () => {
        inboxState.isLoading = false;
        inboxState.error = new Error('offline');
        render(
            <AgentInboxPanel
                agentId="agent-1"
                initialMessages={[message({ subject: 'Still here' })]}
            />,
        );
        expect(screen.getByText('Still here')).toBeInTheDocument();
    });

    it('counts drafts waiting for approval and offers the decision only on a draft', () => {
        render(
            <AgentInboxPanel
                agentId="agent-1"
                initialMessages={[
                    message({ id: 'd-1', status: 'draft' }),
                    message({ id: 'd-2', status: 'draft' }),
                    message({ id: 's-1', status: 'sent' }),
                ]}
            />,
        );
        expect(screen.getByTestId('agent-inbox-waiting-drafts')).toHaveTextContent(
            'drafts.waiting:{"count":2}',
        );
        expect(screen.getByTestId('email-draft-actions-d-1')).toBeInTheDocument();
        expect(screen.queryByTestId('email-draft-actions-s-1')).not.toBeInTheDocument();
        expect(screen.getByTestId('agent-inbox-status-s-1')).toHaveTextContent(
            'drafts.status.sent',
        );
    });

    it('approves a draft and refreshes the list', async () => {
        approveMock.mockResolvedValue({ ok: true });
        render(
            <AgentInboxPanel
                agentId="agent-1"
                initialMessages={[message({ id: 'd-1', status: 'draft' })]}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'drafts.approve' }));

        await waitFor(() => expect(approveMock).toHaveBeenCalledWith('agent-1', 'd-1'));
        expect(await screen.findByText('drafts.approved')).toBeInTheDocument();
        expect(inboxState.mutate).toHaveBeenCalled();
    });

    it('explains a send-limit refusal and that the draft is kept', async () => {
        approveMock.mockResolvedValue({
            ok: false,
            error: 'refused',
            refusal: {
                kind: 'sendLimit',
                limitKind: 'inboxDaily',
                used: 100,
                cap: 100,
                retryAfterSeconds: 600,
            },
        });
        render(
            <AgentInboxPanel
                agentId="agent-1"
                initialMessages={[message({ id: 'd-1', status: 'draft' })]}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'drafts.approve' }));

        const status = await screen.findByRole('status');
        expect(status.textContent).toContain('drafts.sendLimit:');
        expect(status.textContent).toContain('"minutes":10');
        expect(status.textContent).toContain('drafts.kept');
    });

    it('discards a draft', async () => {
        discardMock.mockResolvedValue({ ok: true });
        render(
            <AgentInboxPanel
                agentId="agent-1"
                initialMessages={[message({ id: 'd-1', status: 'draft' })]}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'drafts.discard' }));
        expect(await screen.findByText('drafts.discarded')).toBeInTheDocument();
        expect(discardMock).toHaveBeenCalledWith('agent-1', 'd-1');
    });
});
