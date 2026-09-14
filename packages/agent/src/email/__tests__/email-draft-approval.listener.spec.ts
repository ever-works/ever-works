import { AgentActionProposalDecidedEvent } from '../../agent-approvals/agent-action-proposal-decided.event';
import { EmailDraftApprovalListener } from '../email-draft-approval.listener';

/**
 * Agent email (AW-05) — a decision in the approvals queue acts on the held
 * draft it mirrors, and only a PERSON's decision can release mail.
 */
function event(
    overrides: Partial<{
        actionType: string;
        status: 'approved' | 'rejected';
        decidedById: string | null;
        decidedVia: 'user' | 'guardrail' | null;
        payload: Record<string, unknown>;
    }> = {},
) {
    return new AgentActionProposalDecidedEvent(
        'prop-1',
        'user-1',
        'agent-1',
        (overrides.actionType ?? 'send_message') as never,
        overrides.status ?? 'approved',
        overrides.decidedById === undefined ? 'user-1' : overrides.decidedById,
        overrides.decidedVia === undefined ? 'user' : overrides.decidedVia,
        (overrides.payload ?? { kind: 'email-draft', emailMessageId: 'm-1' }) as never,
    );
}

describe('EmailDraftApprovalListener', () => {
    let drafts: { approve: jest.Mock; discard: jest.Mock };
    let listener: EmailDraftApprovalListener;

    beforeEach(() => {
        drafts = {
            approve: jest.fn().mockResolvedValue({}),
            discard: jest.fn().mockResolvedValue({}),
        };
        listener = new EmailDraftApprovalListener(drafts as never);
    });

    it('releases the draft when a person approves it in the queue', async () => {
        await listener.handleProposalDecided(event());
        expect(drafts.approve).toHaveBeenCalledWith('user-1', 'm-1', {
            approvedById: 'user-1',
            viaDecision: true,
        });
        expect(drafts.discard).not.toHaveBeenCalled();
    });

    it('discards the draft when a person rejects it in the queue', async () => {
        await listener.handleProposalDecided(event({ status: 'rejected' }));
        expect(drafts.discard).toHaveBeenCalledWith('user-1', 'm-1', { viaDecision: true });
        expect(drafts.approve).not.toHaveBeenCalled();
    });

    it.each([
        ['a guardrail auto-decision', { decidedVia: 'guardrail' as const, decidedById: null }],
        ['a decision with no person', { decidedById: null }],
        ['a different action type', { actionType: 'spawn_agent' }],
        ['a send_message proposal that is not an email draft', { payload: { kind: 'chat' } }],
        ['an email draft payload with no message id', { payload: { kind: 'email-draft' } }],
    ])('ignores %s', async (_label, overrides) => {
        await listener.handleProposalDecided(event(overrides));
        expect(drafts.approve).not.toHaveBeenCalled();
        expect(drafts.discard).not.toHaveBeenCalled();
    });

    it('never throws back into the request that recorded the decision', async () => {
        drafts.approve.mockRejectedValue(new Error('already sent'));
        await expect(listener.handleProposalDecided(event())).resolves.toBeUndefined();
    });
});
