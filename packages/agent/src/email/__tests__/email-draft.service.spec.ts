import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
    EmailDraftService,
    EMAIL_DRAFT_PROPOSAL_KIND,
    type SubmitAgentEmailInput,
} from '../email-draft.service';
import { EmailSendCapExceededException } from '../email-send-cap-exceeded.exception';

/**
 * Agent email (AW-05) — the approve-before-send loop.
 *
 * The message row is simulated in memory with a real compare-and-set on
 * `status`, so the race tests exercise the same "0 rows moved" branch a
 * database would produce, not a hand-stubbed return value.
 */
type Row = Record<string, any>;

function makeHarness(mode: 'draft-review' | 'auto-send' = 'draft-review') {
    const rows = new Map<string, Row>();
    let seq = 0;
    const messages = {
        save: jest.fn(async (entry: Row) => {
            const row = { id: `m-${++seq}`, ...entry };
            rows.set(row.id, row);
            return row;
        }),
        findByIdAndUserId: jest.fn(async (id: string, userId: string) => {
            const row = rows.get(id);
            return row && row.userId === userId ? { ...row } : null;
        }),
        transitionStatus: jest.fn(
            async (id: string, from: string[], to: string, patch: Row = {}) => {
                const row = rows.get(id);
                if (!row || !from.includes(row.status)) return 0;
                Object.assign(row, patch, { status: to });
                return 1;
            },
        ),
    };
    const facade = {
        send: jest.fn(async (_input: Row, options: Row) => {
            if (options.draftMessageId) {
                await messages.transitionStatus(options.draftMessageId, ['sending'], 'sent', {
                    sentAt: new Date(),
                });
            }
            return {
                provider: 'postmark',
                providerMessageId: 'pm-1',
                accepted: ['ada@example.com'],
                rejected: [],
            };
        }),
    };
    const policy = { resolvePolicy: jest.fn().mockResolvedValue({ mode }) };
    const approvals = {
        createProposal: jest.fn().mockResolvedValue({ id: 'prop-1', status: 'pending' }),
        decide: jest.fn().mockResolvedValue({ id: 'prop-1', status: 'approved' }),
        getOne: jest.fn().mockResolvedValue({ id: 'prop-1', status: 'approved' }),
    };
    const service = new EmailDraftService(
        messages as never,
        facade as never,
        policy as never,
        approvals as never,
    );
    return { service, rows, messages, facade, policy, approvals };
}

const INPUT: SubmitAgentEmailInput = {
    userId: 'user-1',
    agentId: 'agent-1',
    emailAddressId: 'addr-1',
    pluginId: 'postmark',
    from: 'nova@agents.example.com',
    to: ['ada@example.com'],
    cc: ['grace@example.com'],
    subject: 'Quarterly numbers',
    bodyText: 'Attached.',
    messageRef: 'compose-agent-1-1',
    runId: 'run-7',
};

describe('EmailDraftService', () => {
    describe('submit', () => {
        it('sends straight through, as an Agent, when the inbox sends on its own', async () => {
            const { service, facade, messages, approvals } = makeHarness('auto-send');

            const outcome = await service.submit(INPUT);

            expect(outcome).toMatchObject({ held: false, result: { providerMessageId: 'pm-1' } });
            expect(facade.send).toHaveBeenCalledWith(
                expect.objectContaining({ to: ['ada@example.com'], subject: 'Quarterly numbers' }),
                expect.objectContaining({
                    userId: 'user-1',
                    agentId: 'agent-1',
                    origin: 'agent',
                    addressId: 'addr-1',
                }),
            );
            expect(messages.save).not.toHaveBeenCalled();
            expect(approvals.createProposal).not.toHaveBeenCalled();
        });

        it('holds the message as a draft, sends nothing, and puts it in the approvals queue', async () => {
            const { service, facade, rows, approvals } = makeHarness();

            const outcome = await service.submit(INPUT);

            expect(outcome).toEqual({
                held: true,
                reason: 'awaiting-approval',
                messageId: 'm-1',
                approvalId: 'prop-1',
            });
            // THE point of the gate: zero provider calls.
            expect(facade.send).not.toHaveBeenCalled();
            expect(rows.get('m-1')).toMatchObject({
                status: 'draft',
                direction: 'outbound',
                sentAt: null,
                approvalId: 'prop-1',
                toAddresses: ['ada@example.com'],
                ccAddresses: ['grace@example.com'],
            });
            expect(approvals.createProposal).toHaveBeenCalledWith('user-1', {
                agentId: 'agent-1',
                actionType: 'send_message',
                title: 'Send email to ada@example.com: Quarterly numbers',
                runId: 'run-7',
                payload: {
                    kind: EMAIL_DRAFT_PROPOSAL_KIND,
                    emailMessageId: 'm-1',
                    recipientCount: 2,
                },
            });
        });

        it("keeps the record but sends nothing when the Agent's guardrails forbid email", async () => {
            const { service, rows, approvals, facade } = makeHarness();
            approvals.createProposal.mockResolvedValue({ id: 'prop-1', status: 'rejected' });

            await expect(service.submit(INPUT)).rejects.toBeInstanceOf(ForbiddenException);

            expect(rows.get('m-1')).toMatchObject({ status: 'discarded' });
            expect(facade.send).not.toHaveBeenCalled();
        });

        it('still holds the draft when the approvals queue cannot be reached', async () => {
            const { service, rows, approvals, facade } = makeHarness();
            approvals.createProposal.mockRejectedValue(new Error('queue down'));

            const outcome = await service.submit(INPUT);

            expect(outcome).toMatchObject({ held: true, messageId: 'm-1', approvalId: null });
            expect(rows.get('m-1')?.status).toBe('draft');
            expect(facade.send).not.toHaveBeenCalled();
        });
    });

    describe('approve', () => {
        async function heldDraft(harness = makeHarness()) {
            await harness.service.submit(INPUT);
            return harness;
        }

        it('releases the draft through the send path as that exact message, and records the decision', async () => {
            const harness = await heldDraft();
            const { service, facade, rows, approvals } = harness;

            const { message, result } = await service.approve('user-1', 'm-1');

            expect(result?.providerMessageId).toBe('pm-1');
            expect(facade.send).toHaveBeenCalledTimes(1);
            expect(facade.send).toHaveBeenCalledWith(
                expect.objectContaining({
                    to: ['ada@example.com'],
                    cc: ['grace@example.com'],
                    subject: 'Quarterly numbers',
                }),
                expect.objectContaining({
                    origin: 'agent',
                    draftMessageId: 'm-1',
                    addressId: 'addr-1',
                    agentId: 'agent-1',
                }),
            );
            expect(message.status).toBe('sent');
            expect(rows.get('m-1')).toMatchObject({ approvedById: 'user-1' });
            expect(approvals.decide).toHaveBeenCalledWith('user-1', 'prop-1', 'approved');
        });

        it('sends exactly once when two approvals race, and tells the loser who won', async () => {
            const harness = await heldDraft();
            const { service, facade } = harness;

            const [first, second] = await Promise.allSettled([
                service.approve('user-1', 'm-1'),
                service.approve('user-1', 'm-1'),
            ]);

            const outcomes = [first.status, second.status].sort();
            expect(outcomes).toEqual(['fulfilled', 'rejected']);
            expect(facade.send).toHaveBeenCalledTimes(1);
            const loser = (first.status === 'rejected' ? first : second) as PromiseRejectedResult;
            expect(loser.reason).toBeInstanceOf(ConflictException);
            expect(loser.reason.getResponse()).toMatchObject({
                error: 'EmailDraftAlreadyDecided',
                details: { approvedById: 'user-1' },
            });
        });

        it('does not decide the queue twice when the decision came from the queue', async () => {
            const harness = await heldDraft();
            await harness.service.approve('user-1', 'm-1', {
                approvedById: 'user-1',
                viaDecision: true,
            });
            expect(harness.approvals.decide).not.toHaveBeenCalled();
            expect(harness.facade.send).toHaveBeenCalledTimes(1);
        });

        it('refuses to send a draft someone already rejected in the approvals queue', async () => {
            const harness = await heldDraft();
            harness.approvals.decide.mockRejectedValue(new ConflictException('already rejected'));
            harness.approvals.getOne.mockResolvedValue({ id: 'prop-1', status: 'rejected' });

            await expect(harness.service.approve('user-1', 'm-1')).rejects.toBeInstanceOf(
                ConflictException,
            );

            expect(harness.facade.send).not.toHaveBeenCalled();
            expect(harness.rows.get('m-1')?.status).toBe('discarded');
        });

        it('returns a capped draft to draft with the reason — nothing is lost', async () => {
            const harness = await heldDraft();
            harness.facade.send.mockRejectedValue(
                new EmailSendCapExceededException({
                    scope: 'inbox',
                    limitKind: 'inboxDaily',
                    used: 100,
                    cap: 100,
                    windowSeconds: 86_400,
                    retryAfterSeconds: 600,
                }),
            );

            await expect(harness.service.approve('user-1', 'm-1')).rejects.toBeInstanceOf(
                EmailSendCapExceededException,
            );

            expect(harness.rows.get('m-1')).toMatchObject({
                status: 'draft',
                approvedById: null,
                failureReason: expect.stringMatching(/Send limit reached: 100 of 100/),
            });
            // …and it can be approved again once capacity returns.
            harness.facade.send.mockResolvedValue({
                provider: 'postmark',
                providerMessageId: 'pm-2',
                accepted: [],
                rejected: [],
            });
            await expect(harness.service.approve('user-1', 'm-1')).resolves.toBeDefined();
        });

        it('marks a provider failure as failed, with the provider reason', async () => {
            const harness = await heldDraft();
            harness.facade.send.mockRejectedValue(new Error('provider 503'));
            await expect(harness.service.approve('user-1', 'm-1')).rejects.toThrow('provider 503');
            expect(harness.rows.get('m-1')).toMatchObject({
                status: 'failed',
                failureReason: 'provider 503',
            });
        });

        it("treats another account's message exactly like a missing one", async () => {
            const harness = await heldDraft();
            await expect(harness.service.approve('user-2', 'm-1')).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(harness.facade.send).not.toHaveBeenCalled();
        });

        it('refuses to approve an inbound message', async () => {
            const { service, rows } = makeHarness();
            rows.set('in-1', {
                id: 'in-1',
                userId: 'user-1',
                direction: 'inbound',
                status: 'received',
            });
            await expect(service.approve('user-1', 'in-1')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });
    });

    describe('discard', () => {
        it('discards a draft, mirrors the rejection, and cannot then be approved', async () => {
            const harness = makeHarness();
            await harness.service.submit(INPUT);

            const { message } = await harness.service.discard('user-1', 'm-1');

            expect(message.status).toBe('discarded');
            expect(harness.approvals.decide).toHaveBeenCalledWith('user-1', 'prop-1', 'rejected');
            await expect(harness.service.approve('user-1', 'm-1')).rejects.toBeInstanceOf(
                ConflictException,
            );
            expect(harness.facade.send).not.toHaveBeenCalled();
        });

        it('refuses to discard a message that already went out', async () => {
            const harness = makeHarness();
            await harness.service.submit(INPUT);
            await harness.service.approve('user-1', 'm-1');
            await expect(harness.service.discard('user-1', 'm-1')).rejects.toBeInstanceOf(
                ConflictException,
            );
        });
    });
});
