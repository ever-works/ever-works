import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentActionProposal } from '@/lib/api/agent-approvals';

const { approveAllMock, toastSuccess } = vi.hoisted(() => ({
    approveAllMock: vi.fn(),
    toastSuccess: vi.fn(),
}));

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${JSON.stringify(values)}` : key,
}));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: vi.fn() } }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
vi.mock('@/app/actions/dashboard/agent-approvals', () => ({
    approveAllProposalsAction: approveAllMock,
    approveProposalAction: vi.fn(),
    rejectProposalAction: vi.fn(),
}));

import { ApprovalsQueue } from './ApprovalsQueue';

function proposal(overrides: Partial<AgentActionProposal>): AgentActionProposal {
    return {
        id: 'p-1',
        userId: 'user-1',
        agentId: 'agent-1',
        runId: null,
        actionType: 'spawn_agent',
        title: 'Do the thing',
        payload: {},
        riskFlags: [],
        status: 'pending',
        decidedById: null,
        decidedAt: null,
        createdAt: '2026-09-14T00:00:00.000Z',
        updatedAt: '2026-09-14T00:00:00.000Z',
        ...overrides,
    } as AgentActionProposal;
}

describe('ApprovalsQueue — bulk approval never sends a held email (AW-05)', () => {
    beforeEach(() => {
        approveAllMock.mockReset();
        toastSuccess.mockReset();
    });

    it('leaves email drafts out of "approve all" and keeps them in the list', async () => {
        approveAllMock.mockResolvedValue({ approved: 2, skipped: 0, excluded: 0 });
        render(
            <ApprovalsQueue
                initialApprovals={[
                    proposal({ id: 'p-spawn' }),
                    proposal({
                        id: 'p-email',
                        actionType: 'send_message',
                        title: 'Send email to ada@x.com: Hi',
                        payload: { kind: 'email-draft', emailMessageId: 'm-1' },
                    }),
                    proposal({ id: 'p-chat', actionType: 'send_message', payload: {} }),
                ]}
            />,
        );

        fireEvent.click(screen.getByTestId('approval-approve-all'));

        await waitFor(() => expect(approveAllMock).toHaveBeenCalledWith(['p-spawn', 'p-chat']));
        expect(screen.getByTestId('approval-row-p-email')).toBeInTheDocument();
        await waitFor(() =>
            expect(screen.queryByTestId('approval-row-p-spawn')).not.toBeInTheDocument(),
        );
        expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining('"excluded":1'));
    });
});
