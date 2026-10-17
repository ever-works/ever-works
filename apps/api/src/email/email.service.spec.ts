// Stub the agent subpaths so their transitive `@ever-works/agent/database` →
// `database.config.ts` (api-only `@src/config`) is never pulled into this spec.
jest.mock('@ever-works/agent/database', () => ({
    TenantEmailAddressRepository: class TenantEmailAddressRepository {},
    AgentEmailAssignmentRepository: class AgentEmailAssignmentRepository {},
    EmailMessageRepository: class EmailMessageRepository {},
    AgentRepository: class AgentRepository {},
    AgentInboxRepository: class AgentInboxRepository {},
}));
jest.mock('@ever-works/agent/facades', () => ({
    EmailFacadeService: class EmailFacadeService {},
    // EW-P4-3 — the verified-sender rule (same semantics as the real ones).
    emailSenderVerificationRequired: () =>
        process.env.EMAIL_SENDER_VERIFICATION_REQUIRED !== 'false',
    EmailSenderNotVerifiedException: class EmailSenderNotVerifiedException extends Error {
        readonly status = 403;
        constructor(address: string) {
            super(`The sending address ${address} is not verified.`);
        }
    },
    // EW-P4-3 — the REAL threading helpers, from their leaf module.
    ...jest.requireActual<Record<string, unknown>>(
        '../../../../packages/agent/src/facades/email-threading',
    ),
}));
jest.mock('@ever-works/agent/email', () => ({
    EmailDraftService: class EmailDraftService {},
}));
jest.mock('../mail/mail.service', () => ({ MailService: class MailService {} }));
jest.mock('./templates/render', () => ({
    renderTemplate: jest.fn(),
    listTemplates: jest.fn(() => []),
}));

import { NotFoundException } from '@nestjs/common';
import { EmailService } from './email.service';

/**
 * EmailService — security-scoped behaviour around `sendMessage`.
 *
 * Covers the Codex P1 finding on PR #1085: when `fromAddressId` is omitted,
 * the resolved primary-outbound address MUST belong to the calling user.
 * Otherwise an authenticated caller who knows another user's `agentId` could
 * send mail from that user's outbound address.
 *
 * EW-711 #16 (IDOR): `sendMessage` additionally verifies the caller OWNS the
 * agent named by `input.agentId` before any address resolution — the agentId
 * is persisted on the email_messages audit row and recorded against usage.
 */
describe('EmailService.sendMessage authorization', () => {
    let addresses: {
        findByIdForUser: jest.Mock;
        findById: jest.Mock;
    };
    let assignments: { findPrimaryOutboundForAgent: jest.Mock };
    let messages: Record<string, jest.Mock>;
    let emailFacade: { send: jest.Mock };
    let agents: { findByIdAndUser: jest.Mock };
    let service: EmailService;

    beforeEach(() => {
        addresses = {
            findByIdForUser: jest.fn(),
            findById: jest.fn(),
        };
        assignments = { findPrimaryOutboundForAgent: jest.fn() };
        messages = {};
        emailFacade = { send: jest.fn().mockResolvedValue({ providerMessageId: 'pm-1' }) };
        // EW-711 #16: passing cases run as the agent's owner — the ownership
        // probe resolves a stub agent; the IDOR test below overrides to null.
        agents = {
            findByIdAndUser: jest.fn().mockResolvedValue({ id: 'agent-1', userId: 'user-1' }),
        };
        service = new EmailService(
            addresses as never,
            assignments as never,
            messages as never,
            emailFacade as never,
            agents as never,
        );
    });

    it('default path: scopes the resolved address to the caller (findByIdForUser)', async () => {
        assignments.findPrimaryOutboundForAgent.mockResolvedValue({
            emailAddressId: 'addr-foreign',
        });
        addresses.findByIdForUser.mockResolvedValue({
            id: 'addr-foreign',
            address: 'me@x.com',
            userId: 'user-1',
            verified: true,
        });

        await service.sendMessage('user-1', {
            agentId: 'agent-1',
            to: ['to@x.com'],
            subject: 's',
            bodyText: 'b',
        });

        expect(addresses.findByIdForUser).toHaveBeenCalledWith('addr-foreign', 'user-1');
        expect(addresses.findById).not.toHaveBeenCalled();
    });

    it('default path: throws NotFound when the resolved address belongs to a different user', async () => {
        assignments.findPrimaryOutboundForAgent.mockResolvedValue({
            emailAddressId: 'addr-foreign',
        });
        // findByIdForUser returns null when (id, userId) does not match — i.e. the
        // address belongs to another user. We must not fall through to findById.
        addresses.findByIdForUser.mockResolvedValue(null);

        await expect(
            service.sendMessage('user-1', {
                agentId: 'agent-1',
                to: ['to@x.com'],
                subject: 's',
                bodyText: 'b',
            }),
        ).rejects.toBeInstanceOf(NotFoundException);

        expect(emailFacade.send).not.toHaveBeenCalled();
    });

    it('explicit fromAddressId path remains user-scoped (no regression)', async () => {
        addresses.findByIdForUser.mockResolvedValue({
            id: 'addr-1',
            address: 'me@x.com',
            userId: 'user-1',
            verified: true,
        });

        await service.sendMessage('user-1', {
            agentId: 'agent-1',
            to: ['to@x.com'],
            subject: 's',
            bodyText: 'b',
            fromAddressId: 'addr-1',
        });

        expect(addresses.findByIdForUser).toHaveBeenCalledWith('addr-1', 'user-1');
        expect(assignments.findPrimaryOutboundForAgent).not.toHaveBeenCalled();
    });

    it('EW-711 #16: a foreign agentId throws NotFound before any address resolution or send', async () => {
        // findByIdAndUser returns null when (agentId, userId) does not match —
        // i.e. the agent belongs to another user (or does not exist).
        agents.findByIdAndUser.mockResolvedValue(null);

        await expect(
            service.sendMessage('user-1', {
                agentId: 'agent-foreign',
                to: ['to@x.com'],
                subject: 's',
                bodyText: 'b',
                fromAddressId: 'addr-1',
            }),
        ).rejects.toBeInstanceOf(NotFoundException);

        expect(agents.findByIdAndUser).toHaveBeenCalledWith('agent-foreign', 'user-1');
        // The guard fires FIRST — nothing downstream may run for a foreign agent.
        expect(addresses.findByIdForUser).not.toHaveBeenCalled();
        expect(assignments.findPrimaryOutboundForAgent).not.toHaveBeenCalled();
        expect(emailFacade.send).not.toHaveBeenCalled();
    });
});

/**
 * EW-711 #44 — address-verification tokens are time-boxed (24h TTL).
 *
 * `createAddress` stamps `verificationTokenExpiresAt` alongside the token;
 * `confirmVerification` rejects expired tokens and clears both fields on
 * success. Legacy rows (NULL expiry, issued before the column existed) stay
 * confirmable.
 */
describe('EmailService verification-token expiry', () => {
    let addresses: {
        save: jest.Mock;
        findByVerificationToken: jest.Mock;
        update: jest.Mock;
    };
    let service: EmailService;

    beforeEach(() => {
        addresses = {
            save: jest.fn().mockImplementation(async (row) => row),
            findByVerificationToken: jest.fn(),
            update: jest.fn().mockResolvedValue(undefined),
        };
        service = new EmailService(
            addresses as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
        );
    });

    it('createAddress stamps a ~24h verificationTokenExpiresAt alongside the token', async () => {
        const before = Date.now();
        const row = await service.createAddress('user-1', {
            address: 'me@x.com',
            direction: 'outbound',
            pluginId: 'postmark',
            providerSettings: {},
        });
        const after = Date.now();

        expect(row.verificationToken).toBeTruthy();
        expect(row.verificationTokenExpiresAt).toBeInstanceOf(Date);
        const expiry = (row.verificationTokenExpiresAt as Date).getTime();
        const dayMs = 24 * 60 * 60 * 1000;
        expect(expiry).toBeGreaterThanOrEqual(before + dayMs);
        expect(expiry).toBeLessThanOrEqual(after + dayMs);
    });

    it('confirmVerification rejects an expired token without mutating the row', async () => {
        addresses.findByVerificationToken.mockResolvedValue({
            id: 'addr-1',
            verificationToken: 'tok-1',
            verificationTokenExpiresAt: new Date(Date.now() - 1000),
        });

        await expect(service.confirmVerification('tok-1')).resolves.toEqual({ verified: false });
        expect(addresses.update).not.toHaveBeenCalled();
    });

    it('confirmVerification accepts an unexpired token and clears token + expiry', async () => {
        addresses.findByVerificationToken.mockResolvedValue({
            id: 'addr-1',
            verificationToken: 'tok-1',
            verificationTokenExpiresAt: new Date(Date.now() + 60_000),
        });

        await expect(service.confirmVerification('tok-1')).resolves.toEqual({ verified: true });
        expect(addresses.update).toHaveBeenCalledWith('addr-1', {
            verified: true,
            verificationToken: null,
            verificationTokenExpiresAt: null,
        });
    });

    it('confirmVerification keeps legacy rows (NULL expiry) confirmable', async () => {
        addresses.findByVerificationToken.mockResolvedValue({
            id: 'addr-legacy',
            verificationToken: 'tok-legacy',
            verificationTokenExpiresAt: null,
        });

        await expect(service.confirmVerification('tok-legacy')).resolves.toEqual({
            verified: true,
        });
        expect(addresses.update).toHaveBeenCalled();
    });

    it('confirmVerification still rejects an unknown token', async () => {
        addresses.findByVerificationToken.mockResolvedValue(null);

        await expect(service.confirmVerification('nope')).resolves.toEqual({ verified: false });
        expect(addresses.update).not.toHaveBeenCalled();
    });
});

/**
 * AW-05 — who asked for a send decides which path it takes. A person
 * composing goes straight to the facade (every ceiling applies there); an
 * Agent's message goes through the draft loop, which may hold it for a
 * person. The origin is a server-side argument, never a body field.
 */
describe('EmailService.sendMessage origin (AW-05)', () => {
    const address = {
        id: 'addr-1',
        address: 'nova@x.com',
        userId: 'user-1',
        pluginId: 'postmark',
        verified: true,
    };
    let emailFacade: { send: jest.Mock };
    let drafts: { submit: jest.Mock };
    let service: EmailService;

    function build(withDrafts: boolean) {
        return new EmailService(
            { findByIdForUser: jest.fn().mockResolvedValue(address) } as never,
            {
                findPrimaryOutboundForAgent: jest
                    .fn()
                    .mockResolvedValue({ emailAddressId: 'addr-1' }),
            } as never,
            {} as never,
            emailFacade as never,
            { findByIdAndUser: jest.fn().mockResolvedValue({ id: 'agent-1' }) } as never,
            (withDrafts ? drafts : undefined) as never,
        );
    }

    const input = { agentId: 'agent-1', to: ['ada@x.com'], subject: 'Hi', bodyText: 'Hello' };

    beforeEach(() => {
        emailFacade = {
            send: jest.fn().mockResolvedValue({
                provider: 'postmark',
                providerMessageId: 'pm-1',
                accepted: ['ada@x.com'],
                rejected: [],
            }),
        };
        drafts = {
            submit: jest.fn().mockResolvedValue({
                held: true,
                reason: 'awaiting-approval',
                messageId: 'm-1',
                approvalId: 'prop-1',
            }),
        };
        service = build(true);
    });

    it('treats a call with no origin as a person composing (the pre-existing behaviour)', async () => {
        await service.sendMessage('user-1', input);
        expect(drafts.submit).not.toHaveBeenCalled();
        expect(emailFacade.send).toHaveBeenCalledWith(
            expect.objectContaining({ from: 'nova@x.com', to: ['ada@x.com'] }),
            { userId: 'user-1', agentId: 'agent-1', addressId: 'addr-1', origin: 'human' },
        );
    });

    it("routes an Agent's message through the draft loop and reports a hold without a provider call", async () => {
        const result = await service.sendMessage('user-1', input, {
            origin: 'agent',
            runId: 'run-1',
        });

        expect(emailFacade.send).not.toHaveBeenCalled();
        expect(drafts.submit).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'user-1',
                agentId: 'agent-1',
                emailAddressId: 'addr-1',
                pluginId: 'postmark',
                from: 'nova@x.com',
                to: ['ada@x.com'],
                runId: 'run-1',
            }),
        );
        expect(result).toMatchObject({
            held: true,
            messageId: 'm-1',
            approvalId: 'prop-1',
            providerMessageId: '',
            accepted: [],
        });
    });

    it("returns the provider result when the Agent's inbox sends on its own", async () => {
        drafts.submit.mockResolvedValue({
            held: false,
            result: {
                provider: 'postmark',
                providerMessageId: 'pm-9',
                accepted: ['ada@x.com'],
                rejected: [],
            },
        });
        const result = await service.sendMessage('user-1', input, { origin: 'agent' });
        expect(result).toMatchObject({ providerMessageId: 'pm-9', accepted: ['ada@x.com'] });
        expect(result.held).toBeUndefined();
    });

    it('still marks the send as an Agent send when the draft loop is not wired, so the gate can refuse it', async () => {
        service = build(false);
        await service.sendMessage('user-1', input, { origin: 'agent' });
        expect(emailFacade.send).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ origin: 'agent' }),
        );
    });
});

/**
 * AW-05 — the sending address pinned on an Agent's inbox settings is the one
 * a person chose, so it wins over the primary assignment; an explicit
 * `fromAddressId` still wins over both, and a pin that no longer resolves to
 * a usable address behaves like no pin.
 */
describe('EmailService.sendMessage pinned sending address (AW-05)', () => {
    const PRIMARY = {
        id: 'addr-primary',
        address: 'primary@x.com',
        userId: 'user-1',
        pluginId: 'postmark',
        direction: 'outbound',
        disabledAt: null,
        verified: true,
    };
    const PINNED = { ...PRIMARY, id: 'addr-pinned', address: 'pinned@x.com', pluginId: 'resend' };
    const EXPLICIT = { ...PRIMARY, id: 'addr-explicit', address: 'explicit@x.com' };
    let owned: Record<string, Record<string, unknown>>;
    let inboxes: { findByAgentForUser: jest.Mock };
    let emailFacade: { send: jest.Mock };
    let drafts: { submit: jest.Mock };

    function build(withInboxes = true) {
        return new EmailService(
            {
                findByIdForUser: jest.fn(async (id: string, userId: string) =>
                    userId === 'user-1' ? (owned[id] ?? null) : null,
                ),
            } as never,
            {
                findPrimaryOutboundForAgent: jest
                    .fn()
                    .mockResolvedValue({ emailAddressId: 'addr-primary' }),
            } as never,
            {} as never,
            emailFacade as never,
            { findByIdAndUser: jest.fn().mockResolvedValue({ id: 'agent-1' }) } as never,
            drafts as never,
            (withInboxes ? inboxes : undefined) as never,
        );
    }

    const input = { agentId: 'agent-1', to: ['ada@x.com'], subject: 'Hi', bodyText: 'Hello' };

    beforeEach(() => {
        owned = { 'addr-primary': PRIMARY, 'addr-pinned': PINNED, 'addr-explicit': EXPLICIT };
        inboxes = {
            findByAgentForUser: jest.fn().mockResolvedValue({
                id: 'inbox-1',
                agentId: 'agent-1',
                userId: 'user-1',
                emailAddressId: 'addr-pinned',
            }),
        };
        emailFacade = {
            send: jest.fn().mockResolvedValue({
                provider: 'resend',
                providerMessageId: 'pm-1',
                accepted: ['ada@x.com'],
                rejected: [],
            }),
        };
        drafts = {
            submit: jest.fn().mockResolvedValue({
                held: true,
                reason: 'awaiting-approval',
                messageId: 'm-1',
                approvalId: null,
            }),
        };
    });

    it("sends an Agent's message from the pinned address, not the primary assignment", async () => {
        await build().sendMessage('user-1', input, { origin: 'agent' });

        expect(inboxes.findByAgentForUser).toHaveBeenCalledWith('agent-1', 'user-1');
        expect(drafts.submit).toHaveBeenCalledWith(
            expect.objectContaining({
                emailAddressId: 'addr-pinned',
                pluginId: 'resend',
                from: 'pinned@x.com',
            }),
        );
    });

    it('uses the pin for a person composing on the Agent too', async () => {
        await build().sendMessage('user-1', input);
        expect(emailFacade.send).toHaveBeenCalledWith(
            expect.objectContaining({ from: 'pinned@x.com' }),
            expect.objectContaining({ addressId: 'addr-pinned' }),
        );
    });

    it('lets an explicit fromAddressId win over the pin', async () => {
        await build().sendMessage('user-1', { ...input, fromAddressId: 'addr-explicit' });
        expect(inboxes.findByAgentForUser).not.toHaveBeenCalled();
        expect(emailFacade.send).toHaveBeenCalledWith(
            expect.objectContaining({ from: 'explicit@x.com' }),
            expect.objectContaining({ addressId: 'addr-explicit' }),
        );
    });

    it.each([
        [
            'has no pin',
            () => inboxes.findByAgentForUser.mockResolvedValue({ emailAddressId: null }),
        ],
        ['has no settings row', () => inboxes.findByAgentForUser.mockResolvedValue(null)],
        ['pins an address that is gone', () => delete owned['addr-pinned']],
        [
            'pins an address that was disabled',
            () => (owned['addr-pinned'] = { ...PINNED, disabledAt: new Date() }),
        ],
        [
            'pins an address that only receives',
            () => (owned['addr-pinned'] = { ...PINNED, direction: 'inbound' }),
        ],
    ])('falls back to the primary assignment when the Agent %s', async (_label, arrange) => {
        arrange();
        await build().sendMessage('user-1', input);
        expect(emailFacade.send).toHaveBeenCalledWith(
            expect.objectContaining({ from: 'primary@x.com' }),
            expect.objectContaining({ addressId: 'addr-primary' }),
        );
    });

    it('resolves exactly as before when the inbox settings are not wired', async () => {
        await build(false).sendMessage('user-1', input);
        expect(emailFacade.send).toHaveBeenCalledWith(
            expect.objectContaining({ from: 'primary@x.com' }),
            expect.anything(),
        );
    });
});

/**
 * EW-P4-3 — reply in thread. `inReplyToMessageId` names one of the caller's
 * own messages; the send then carries its `In-Reply-To` / `References` and
 * belongs to the same Task. Another account's message answers 404.
 */
describe('EmailService.sendMessage inReplyToMessageId (EW-P4-3)', () => {
    const address = {
        id: 'addr-1',
        address: 'nova@x.com',
        userId: 'user-1',
        pluginId: 'postmark',
        verified: true,
    };
    const parent = {
        id: '6f1c2e8a-5d0b-4b7e-9a51-3c8f2d9e1a01',
        userId: 'user-1',
        taskId: 'task-7',
        messageIdHeader: 'in-2@client.test',
        inReplyTo: 'out-1@nova.x.com',
        references: ['root@client.test', 'out-1@nova.x.com'],
    };
    let emailFacade: { send: jest.Mock };
    let drafts: { submit: jest.Mock };
    let messages: { findByIdAndUserId: jest.Mock };

    function build(withDrafts = false) {
        return new EmailService(
            { findByIdForUser: jest.fn().mockResolvedValue(address) } as never,
            {
                findPrimaryOutboundForAgent: jest
                    .fn()
                    .mockResolvedValue({ emailAddressId: 'addr-1' }),
            } as never,
            messages as never,
            emailFacade as never,
            { findByIdAndUser: jest.fn().mockResolvedValue({ id: 'agent-1' }) } as never,
            (withDrafts ? drafts : undefined) as never,
        );
    }

    const input = {
        agentId: 'agent-1',
        to: ['ada@client.test'],
        subject: 'Re: Hi',
        bodyText: 'Answer',
        inReplyToMessageId: parent.id,
    };

    beforeEach(() => {
        emailFacade = {
            send: jest.fn().mockResolvedValue({
                provider: 'postmark',
                providerMessageId: 'pm-1',
                accepted: ['ada@client.test'],
                rejected: [],
            }),
        };
        drafts = {
            submit: jest.fn().mockResolvedValue({
                held: true,
                reason: 'awaiting-approval',
                messageId: 'm-1',
                approvalId: null,
            }),
        };
        messages = {
            findByIdAndUserId: jest.fn(async (id: string, userId: string) =>
                id === parent.id && userId === parent.userId ? parent : null,
            ),
        };
    });

    it('threads the reply and keeps it on the same Task', async () => {
        await build().sendMessage('user-1', input);
        expect(messages.findByIdAndUserId).toHaveBeenCalledWith(parent.id, 'user-1');
        expect(emailFacade.send).toHaveBeenCalledWith(
            expect.objectContaining({
                headers: {
                    'In-Reply-To': '<in-2@client.test>',
                    References: '<root@client.test> <out-1@nova.x.com> <in-2@client.test>',
                },
            }),
            expect.objectContaining({ taskId: 'task-7', addressId: 'addr-1' }),
        );
    });

    it("hands the thread to the draft loop for an Agent's message", async () => {
        await build(true).sendMessage('user-1', input, { origin: 'agent' });
        expect(drafts.submit).toHaveBeenCalledWith(
            expect.objectContaining({
                taskId: 'task-7',
                headers: expect.objectContaining({ 'In-Reply-To': '<in-2@client.test>' }),
            }),
        );
    });

    // Review (Greptile, #2607): a reply in a conversation stays in it, so the
    // recipient's next reply threads back into the same conversation.
    it("keeps a reply in the parent's conversation", async () => {
        messages.findByIdAndUserId.mockResolvedValue({
            ...parent,
            taskId: null,
            conversationId: 'conv-3',
        });
        await build().sendMessage('user-1', input);
        expect(emailFacade.send).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ conversationId: 'conv-3', taskId: undefined }),
        );
        await build(true).sendMessage('user-1', input, { origin: 'agent' });
        expect(drafts.submit).toHaveBeenCalledWith(
            expect.objectContaining({ conversationId: 'conv-3', taskId: undefined }),
        );
    });

    it("answers 404 for another account's message and sends nothing", async () => {
        await expect(build().sendMessage('user-2', input)).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(emailFacade.send).not.toHaveBeenCalled();
    });

    it('sends without threading headers when the parent has no Message-ID on record', async () => {
        messages.findByIdAndUserId.mockResolvedValue({ ...parent, messageIdHeader: null });
        await build().sendMessage('user-1', input);
        expect(emailFacade.send.mock.calls[0][0].headers).toBeUndefined();
    });

    it('sends exactly as before without inReplyToMessageId', async () => {
        const { inReplyToMessageId: _omit, ...plain } = input;
        await build().sendMessage('user-1', plain);
        expect(messages.findByIdAndUserId).not.toHaveBeenCalled();
        expect(emailFacade.send.mock.calls[0][0].headers).toBeUndefined();
        expect(emailFacade.send.mock.calls[0][1].taskId).toBeUndefined();
    });
});

/**
 * EW-P4-3 — address verification is real: a confirmation email with a fresh
 * one-time link is sent, and nothing can be sent FROM an unverified address.
 */
describe('EmailService verification (EW-P4-3)', () => {
    const row = {
        id: 'addr-1',
        userId: 'user-1',
        address: 'nova@x.com',
        pluginId: 'postmark',
        verified: false,
        disabledAt: null,
        verificationTokenExpiresAt: null as Date | null,
    };
    let addresses: {
        findByIdForUser: jest.Mock;
        update: jest.Mock;
        claimVerificationSend: jest.Mock;
    };
    let mail: { sendNotificationEmail: jest.Mock; canDeliver: jest.Mock };
    let facade: { verifyAddress: jest.Mock; send: jest.Mock };

    function build(withMail = true) {
        return new EmailService(
            addresses as never,
            {
                findPrimaryOutboundForAgent: jest
                    .fn()
                    .mockResolvedValue({ emailAddressId: 'addr-1' }),
            } as never,
            {} as never,
            facade as never,
            { findByIdAndUser: jest.fn().mockResolvedValue({ id: 'agent-1' }) } as never,
            undefined,
            undefined,
            (withMail ? mail : undefined) as never,
        );
    }

    beforeEach(() => {
        addresses = {
            findByIdForUser: jest.fn().mockResolvedValue({ ...row }),
            update: jest.fn().mockResolvedValue(undefined),
            claimVerificationSend: jest.fn().mockResolvedValue(true),
        };
        mail = {
            sendNotificationEmail: jest.fn().mockResolvedValue(true),
            canDeliver: jest.fn().mockReturnValue(true),
        };
        facade = {
            verifyAddress: jest.fn().mockRejectedValue(new Error('No email-outbound provider')),
            send: jest
                .fn()
                .mockResolvedValue({ providerMessageId: 'pm-1', accepted: [], rejected: [] }),
        };
        delete process.env.EMAIL_SENDER_VERIFICATION_REQUIRED;
    });

    afterEach(() => {
        delete process.env.EMAIL_SENDER_VERIFICATION_REQUIRED;
    });

    it('mails a fresh one-time link to the address and stores its token', async () => {
        const before = Date.now();
        const result = await build().triggerVerification('user-1', 'addr-1');

        expect(result).toMatchObject({ sent: true });
        const [id, patch] = addresses.update.mock.calls[0];
        expect(id).toBe('addr-1');
        expect(patch.verificationToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
        expect(patch.verificationTokenExpiresAt.getTime()).toBeGreaterThanOrEqual(
            before + 24 * 60 * 60 * 1000,
        );
        const [to, , context] = mail.sendNotificationEmail.mock.calls[0];
        expect(to).toBe('nova@x.com');
        expect(context.actionUrl).toBe(`/email-address/verify/${patch.verificationToken}`);
        expect(context.settingsPath).toBe('/settings/integrations/emails');
    });

    it('a failing provider-side verifyAddress does not stop the confirmation email', async () => {
        await expect(build().triggerVerification('user-1', 'addr-1')).resolves.toMatchObject({
            sent: true,
        });
        expect(facade.verifyAddress).toHaveBeenCalled();
    });

    it('sends nothing for an address that is already verified', async () => {
        addresses.findByIdForUser.mockResolvedValue({ ...row, verified: true });
        await expect(build().triggerVerification('user-1', 'addr-1')).resolves.toMatchObject({
            sent: false,
            alreadyVerified: true,
        });
        expect(mail.sendNotificationEmail).not.toHaveBeenCalled();
    });

    it('refuses a resend within the cooldown (429) and a disabled address (400)', async () => {
        // The compare-and-set on verificationSentAt lost: a link went out < 60 s ago.
        addresses.claimVerificationSend.mockResolvedValue(false);
        await expect(build().triggerVerification('user-1', 'addr-1')).rejects.toMatchObject({
            status: 429,
        });
        addresses.findByIdForUser.mockResolvedValue({ ...row, disabledAt: new Date() });
        await expect(build().triggerVerification('user-1', 'addr-1')).rejects.toMatchObject({
            status: 400,
        });
        expect(mail.sendNotificationEmail).not.toHaveBeenCalled();
    });

    it('claims the send with a compare-and-set over the last minute (one email for concurrent clicks)', async () => {
        const before = Date.now();
        await build().triggerVerification('user-1', 'addr-1');
        const [id, notBefore, sentAt] = addresses.claimVerificationSend.mock.calls[0];
        expect(id).toBe('addr-1');
        expect(sentAt.getTime() - notBefore.getTime()).toBe(60_000);
        expect(sentAt.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('the first send right after adding an address is not refused (nothing was mailed yet)', async () => {
        // createAddress mints a token (EW-711 #44) but never mails it, and
        // never stamps verificationSentAt, so the claim succeeds.
        addresses.findByIdForUser.mockResolvedValue({
            ...row,
            createdAt: new Date(),
            verificationTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            verificationSentAt: null,
        });
        await expect(build().triggerVerification('user-1', 'addr-1')).resolves.toMatchObject({
            sent: true,
        });
    });

    it('a refused email answers 503, gives the cooldown back and keeps the earlier link working', async () => {
        const previous = new Date('2026-10-15T10:00:00Z');
        const earlierExpiry = new Date(Date.now() + 60 * 60 * 1000);
        addresses.findByIdForUser.mockResolvedValue({
            ...row,
            verificationSentAt: previous,
            verificationToken: 'earlier-token',
            verificationTokenExpiresAt: earlierExpiry,
        });
        mail.sendNotificationEmail.mockRejectedValue(new Error('Resend refused the email: x'));
        await expect(build().triggerVerification('user-1', 'addr-1')).rejects.toMatchObject({
            status: 503,
        });
        expect(addresses.update).toHaveBeenLastCalledWith('addr-1', {
            verificationSentAt: previous,
            verificationToken: 'earlier-token',
            verificationTokenExpiresAt: earlierExpiry,
        });
        expect(mail.sendNotificationEmail.mock.calls[0][3]).toEqual({ strict: true });
    });

    it('answers 503 when platform mail would only be logged (faker / no Resend key)', async () => {
        mail.canDeliver.mockReturnValue(false);
        await expect(build().triggerVerification('user-1', 'addr-1')).rejects.toMatchObject({
            status: 503,
        });
        expect(addresses.update).not.toHaveBeenCalled();
        expect(addresses.claimVerificationSend).not.toHaveBeenCalled();
        expect(mail.sendNotificationEmail).not.toHaveBeenCalled();
    });

    it('answers 503 rather than pretending to send when platform mail is not wired', async () => {
        await expect(build(false).triggerVerification('user-1', 'addr-1')).rejects.toMatchObject({
            status: 503,
        });
        expect(addresses.update).not.toHaveBeenCalled();
    });

    it("answers 404 for another account's address", async () => {
        addresses.findByIdForUser.mockResolvedValue(null);
        await expect(build().triggerVerification('user-2', 'addr-1')).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });

    const input = { agentId: 'agent-1', to: ['ada@x.com'], subject: 'Hi', bodyText: 'Hello' };

    it('refuses to send from an unverified address (403) before any provider is asked', async () => {
        await expect(build().sendMessage('user-1', input)).rejects.toMatchObject({
            status: 403,
            message: expect.stringContaining('nova@x.com'),
        });
        expect(facade.send).not.toHaveBeenCalled();
    });

    it('sends from a verified address', async () => {
        addresses.findByIdForUser.mockResolvedValue({ ...row, verified: true });
        await build().sendMessage('user-1', input);
        expect(facade.send).toHaveBeenCalled();
    });

    it('lets an operator switch the rule off with EMAIL_SENDER_VERIFICATION_REQUIRED=false', async () => {
        process.env.EMAIL_SENDER_VERIFICATION_REQUIRED = 'false';
        await build().sendMessage('user-1', input);
        expect(facade.send).toHaveBeenCalled();
    });
});

/** EW-P4-3 — the settings page lists disabled addresses; everything else active ones only. */
describe('EmailService.listAddresses (EW-P4-3)', () => {
    it('lists active addresses by default and every address with includeDisabled', async () => {
        const addresses = {
            findActiveByUser: jest.fn().mockResolvedValue([{ id: 'a' }]),
            findAllByUser: jest.fn().mockResolvedValue([{ id: 'a' }, { id: 'b-disabled' }]),
        };
        const service = new EmailService(
            addresses as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
        );
        await expect(service.listAddresses('user-1')).resolves.toEqual([{ id: 'a' }]);
        expect(addresses.findAllByUser).not.toHaveBeenCalled();
        await expect(
            service.listAddresses('user-1', 'outbound', { includeDisabled: true }),
        ).resolves.toHaveLength(2);
        expect(addresses.findAllByUser).toHaveBeenCalledWith('user-1', 'outbound');
    });
});
