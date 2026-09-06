import { config } from '../../config';
import { AgentEscalationService } from '../../agents/agent-escalation.service';
import { AgentApprovalsService } from '../../agent-approvals/agent-approvals.service';
import type { AgentEscalation } from '../../entities/agent-escalation.entity';
import type { AgentActionProposal } from '../../entities/agent-action-proposal.entity';
import type {
    InboxEscalationRaisedInput,
    InboxNoticeInput,
    InboxProposalPendingInput,
    InboxQuestionRaisedInput,
} from '../inbox-producer.port';

/**
 * Producer WIRING — the half that dies silently.
 *
 * `InboxService` can be perfect and the inbox still stay empty if the
 * upstream services never call the port. These specs construct the real
 * `AgentEscalationService` / `AgentApprovalsService` with a fake
 * producer and assert the call actually happens on the real code path,
 * with the real field mapping, and that an absent producer (the token is
 * `@Optional()`) leaves both services byte-for-byte as they were.
 */

function makeInbox() {
    return {
        escalationRaised: jest.fn(async (_input: InboxEscalationRaisedInput) => undefined),
        proposalPending: jest.fn(async (_input: InboxProposalPendingInput) => undefined),
        notice: jest.fn(async (_userId: string, _input: InboxNoticeInput) => undefined),
        questionRaised: jest.fn(async (_input: InboxQuestionRaisedInput) => undefined),
    };
}

describe('AgentEscalationService → inbox', () => {
    const row = {
        id: 'e1',
        userId: 'u1',
        agentId: 'a1',
        runId: 'run-1',
        taskId: 't1',
        workId: 'w1',
        organizationId: 'o1',
        summary: 'Could not reach the repo',
        decisionNeeded: 'Re-auth or skip?',
        reasonCode: 'give_up',
        status: 'open',
    } as unknown as AgentEscalation;

    function makeRepo(recorded: AgentEscalation | null = row) {
        return { record: jest.fn(async () => recorded) };
    }

    beforeEach(() => {
        jest.spyOn(config.agents, 'isEscalationLoggingEnabled').mockReturnValue(true);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('mirrors a recorded escalation with every cross-link mapped', async () => {
        const inbox = makeInbox();
        const svc = new AgentEscalationService(makeRepo() as never, undefined, inbox);

        await svc.record({ userId: 'u1', reasonCode: 'give_up' } as never);

        expect(inbox.escalationRaised).toHaveBeenCalledWith({
            userId: 'u1',
            escalationId: 'e1',
            summary: 'Could not reach the repo',
            decisionNeeded: 'Re-auth or skip?',
            agentId: 'a1',
            runId: 'run-1',
            taskId: 't1',
            workId: 'w1',
            organizationId: 'o1',
        });
    });

    it('does not mirror when nothing was recorded (dedup hit / disabled)', async () => {
        const inbox = makeInbox();
        const svc = new AgentEscalationService(makeRepo(null) as never, undefined, inbox);

        await svc.record({ userId: 'u1', reasonCode: 'give_up' } as never);

        expect(inbox.escalationRaised).not.toHaveBeenCalled();
    });

    it('still returns the escalation when the mirror throws', async () => {
        const inbox = makeInbox();
        inbox.escalationRaised.mockRejectedValue(new Error('inbox down'));
        const svc = new AgentEscalationService(makeRepo() as never, undefined, inbox);

        await expect(svc.record({ userId: 'u1', reasonCode: 'give_up' } as never)).resolves.toBe(
            row,
        );
    });

    it('works unchanged with no producer bound', async () => {
        const repo = makeRepo();
        const svc = new AgentEscalationService(repo as never);

        await expect(svc.record({ userId: 'u1', reasonCode: 'give_up' } as never)).resolves.toBe(
            row,
        );
        expect(repo.record).toHaveBeenCalledTimes(1);
    });
});

describe('AgentApprovalsService → inbox', () => {
    function makeProposalsRepo(status: AgentActionProposal['status'] = 'pending') {
        return {
            create: jest.fn((v: Partial<AgentActionProposal>) => v as AgentActionProposal),
            save: jest.fn(
                async (v: AgentActionProposal) =>
                    ({
                        id: 'p1',
                        riskFlags: [],
                        runId: null,
                        organizationId: null,
                        ...v,
                        status,
                    }) as AgentActionProposal,
            ),
            findOne: jest.fn(),
        };
    }

    const agentsRepo = () => ({
        findOne: jest.fn(async () => ({ id: 'a1', userId: 'u1' })),
    });

    it('mirrors a PENDING proposal', async () => {
        const inbox = makeInbox();
        const svc = new AgentApprovalsService(
            makeProposalsRepo() as never,
            agentsRepo() as never,
            inbox,
        );

        await svc.createProposal('u1', {
            agentId: 'a1',
            actionType: 'send_message',
            title: 'Ping the ops channel',
        } as never);

        expect(inbox.proposalPending).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'u1',
                proposalId: 'p1',
                title: 'Ping the ops channel',
                actionType: 'send_message',
            }),
        );
    });

    it('does NOT mirror a proposal the guardrails already auto-decided', async () => {
        const inbox = makeInbox();
        const svc = new AgentApprovalsService(
            makeProposalsRepo('approved') as never,
            agentsRepo() as never,
            inbox,
        );

        await svc.createProposal('u1', {
            agentId: 'a1',
            actionType: 'send_message',
            title: 'Auto-approved',
        } as never);

        expect(inbox.proposalPending).not.toHaveBeenCalled();
    });

    it('still returns the proposal when the mirror throws', async () => {
        const inbox = makeInbox();
        inbox.proposalPending.mockRejectedValue(new Error('inbox down'));
        const svc = new AgentApprovalsService(
            makeProposalsRepo() as never,
            agentsRepo() as never,
            inbox,
        );

        await expect(
            svc.createProposal('u1', {
                agentId: 'a1',
                actionType: 'send_message',
                title: 'Ping the ops channel',
            } as never),
        ).resolves.toMatchObject({ id: 'p1' });
    });

    it('works unchanged with no producer bound', async () => {
        const proposals = makeProposalsRepo();
        const svc = new AgentApprovalsService(proposals as never, agentsRepo() as never);

        await expect(
            svc.createProposal('u1', {
                agentId: 'a1',
                actionType: 'send_message',
                title: 'Ping the ops channel',
            } as never),
        ).resolves.toMatchObject({ id: 'p1' });
    });
});
