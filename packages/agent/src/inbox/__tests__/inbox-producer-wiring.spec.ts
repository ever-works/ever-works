import { config } from '../../config';
import { AgentEscalationService } from '../../agents/agent-escalation.service';
import { AgentApprovalsService } from '../../agent-approvals/agent-approvals.service';
import type { AgentEscalation } from '../../entities/agent-escalation.entity';
import type { AgentActionProposal } from '../../entities/agent-action-proposal.entity';
import type {
    InboxEscalationRaisedInput,
    InboxEscalationResolvedInput,
    InboxNoticeInput,
    InboxProposalDecidedInput,
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

    it('links the mirror to the Task only for a merge approval, whose payload the platform writes', async () => {
        const inbox = makeInbox();
        const svc = new AgentApprovalsService(
            makeProposalsRepo() as never,
            agentsRepo() as never,
            inbox,
        );

        await svc.createProposal('u1', {
            agentId: 'a1',
            actionType: 'merge_pull_request',
            title: 'Merge PR #42',
            payload: { taskId: 'task-1', prNumber: 42 },
        } as never);
        // Any other action type's payload may be model-authored: never trusted as a link.
        await svc.createProposal('u1', {
            agentId: 'a1',
            actionType: 'send_message',
            title: 'Ping the ops channel',
            payload: { taskId: 'task-2' },
        } as never);

        expect(inbox.proposalPending).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ actionType: 'merge_pull_request', taskId: 'task-1' }),
        );
        expect(inbox.proposalPending).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ actionType: 'send_message', taskId: null }),
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

/**
 * My Decisions — the OTHER doors. A decision taken outside the Inbox
 * reply (the escalation endpoint, the Task page, the chat tool, the Home
 * approvals block, approve-all) must still close its Inbox mirror, or the
 * decision queue shows the owner something they already decided.
 */
describe('resolution through other doors → inbox', () => {
    function makeClosingInbox() {
        return {
            ...makeInbox(),
            escalationResolved: jest.fn(async (_input: InboxEscalationResolvedInput) => undefined),
            proposalDecided: jest.fn(async (_input: InboxProposalDecidedInput) => undefined),
        };
    }

    describe('AgentEscalationService.resolve / resolveForTask', () => {
        function makeRepo(resolved: boolean) {
            return {
                resolve: jest.fn(async () => resolved),
                resolveForTask: jest.fn(async () => resolved),
            };
        }

        it('closes the mirror with the note once the escalation is resolved', async () => {
            const inbox = makeClosingInbox();
            const svc = new AgentEscalationService(makeRepo(true) as never, undefined, inbox);

            await expect(svc.resolve('e1', 'u1', 'Re-authed')).resolves.toBe(true);

            expect(inbox.escalationResolved).toHaveBeenCalledWith({
                escalationId: 'e1',
                resolvedByUserId: 'u1',
                note: 'Re-authed',
            });
        });

        it('closes the mirror from the Task-scoped door too', async () => {
            const inbox = makeClosingInbox();
            const svc = new AgentEscalationService(makeRepo(true) as never, undefined, inbox);

            await svc.resolveForTask('e1', 'member-1', 't1', {} as never, null);

            expect(inbox.escalationResolved).toHaveBeenCalledWith({
                escalationId: 'e1',
                resolvedByUserId: 'member-1',
                note: null,
            });
        });

        it('leaves the mirror alone when nothing was resolved (foreign, missing or already closed)', async () => {
            const inbox = makeClosingInbox();
            const svc = new AgentEscalationService(makeRepo(false) as never, undefined, inbox);

            await expect(svc.resolve('e1', 'u1', 'x')).resolves.toBe(false);

            expect(inbox.escalationResolved).not.toHaveBeenCalled();
        });

        it('keeps the escalation resolved when closing the mirror throws', async () => {
            const inbox = makeClosingInbox();
            inbox.escalationResolved.mockRejectedValue(new Error('inbox down'));
            const svc = new AgentEscalationService(makeRepo(true) as never, undefined, inbox);
            jest.spyOn(
                (svc as never as { logger: { warn: () => void } }).logger,
                'warn',
            ).mockImplementation(() => undefined);

            await expect(svc.resolve('e1', 'u1', 'x')).resolves.toBe(true);
        });

        it('works with a producer that predates the close hook', async () => {
            const svc = new AgentEscalationService(makeRepo(true) as never, undefined, makeInbox());

            await expect(svc.resolve('e1', 'u1', 'x')).resolves.toBe(true);
        });
    });

    describe('AgentApprovalsService.decide / approveAll', () => {
        function makeProposalsRepo(rows: AgentActionProposal[]) {
            return {
                save: jest.fn(async (value: AgentActionProposal | AgentActionProposal[]) => value),
                find: jest.fn(async () => rows),
                findOne: jest.fn(async () => rows[0] ?? null),
            };
        }

        const pending = (id: string, actionType = 'send_message') =>
            ({ id, userId: 'u1', status: 'pending', actionType }) as unknown as AgentActionProposal;

        it('closes the mirror with the decision', async () => {
            const inbox = makeClosingInbox();
            const svc = new AgentApprovalsService(
                makeProposalsRepo([pending('p1')]) as never,
                {} as never,
                inbox,
            );

            await svc.decide('u1', 'p1', 'rejected');

            expect(inbox.proposalDecided).toHaveBeenCalledWith({
                proposalId: 'p1',
                decision: 'rejected',
                decidedByUserId: 'u1',
            });
        });

        it('closes one mirror per bulk-approved row, and none for an excluded merge', async () => {
            const inbox = makeClosingInbox();
            const svc = new AgentApprovalsService(
                makeProposalsRepo([
                    pending('p1'),
                    pending('p2'),
                    pending('p3', 'merge_pull_request'),
                ]) as never,
                {} as never,
                inbox,
            );

            await expect(svc.approveAll('u1')).resolves.toEqual({
                approved: 2,
                skipped: 0,
                excluded: 1,
            });

            expect(inbox.proposalDecided.mock.calls.map((call) => call[0])).toEqual([
                { proposalId: 'p1', decision: 'approved', decidedByUserId: 'u1' },
                { proposalId: 'p2', decision: 'approved', decidedByUserId: 'u1' },
            ]);
        });

        it('keeps the decision when closing the mirror throws', async () => {
            const inbox = makeClosingInbox();
            inbox.proposalDecided.mockRejectedValue(new Error('inbox down'));
            const svc = new AgentApprovalsService(
                makeProposalsRepo([pending('p1')]) as never,
                {} as never,
                inbox,
            );
            jest.spyOn(
                (svc as never as { logger: { warn: () => void } }).logger,
                'warn',
            ).mockImplementation(() => undefined);

            await expect(svc.decide('u1', 'p1', 'approved')).resolves.toMatchObject({
                status: 'approved',
            });
        });

        it('passes the Task a merge approval is about to the mirror', async () => {
            const inbox = makeClosingInbox();
            const proposals = {
                create: jest.fn((v: Partial<AgentActionProposal>) => v as AgentActionProposal),
                save: jest.fn(
                    async (v: AgentActionProposal) =>
                        ({ id: 'p9', riskFlags: [], runId: null, ...v }) as AgentActionProposal,
                ),
            };
            const svc = new AgentApprovalsService(
                proposals as never,
                { findOne: jest.fn(async () => ({ id: 'a1', userId: 'u1' })) } as never,
                inbox,
            );

            await svc.createProposal('u1', {
                agentId: 'a1',
                actionType: 'merge_pull_request',
                title: 'Merge #12',
                payload: { taskId: 't-merge', prNumber: 12, headSha: 'abc' },
            } as never);

            expect(inbox.proposalPending).toHaveBeenCalledWith(
                expect.objectContaining({ proposalId: 'p9', taskId: 't-merge' }),
            );
        });
    });
});
