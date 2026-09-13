// Stub the agent subpaths so their transitive `@ever-works/agent/database` →
// `database.config.ts` (api-only `@src/config`) is never pulled into this spec.
jest.mock('@ever-works/agent/database', () => ({
    TenantEmailAddressRepository: class TenantEmailAddressRepository {},
    AgentEmailAssignmentRepository: class AgentEmailAssignmentRepository {},
    EmailMessageRepository: class EmailMessageRepository {},
    AgentRepository: class AgentRepository {},
}));
jest.mock('@ever-works/agent/facades', () => ({
    EmailFacadeService: class EmailFacadeService {},
}));
jest.mock('@ever-works/agent/email', () => ({
    EmailDraftService: class EmailDraftService {},
}));
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
    const address = { id: 'addr-1', address: 'nova@x.com', userId: 'user-1', pluginId: 'postmark' };
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
