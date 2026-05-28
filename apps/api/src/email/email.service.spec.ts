// Stub the agent subpaths so their transitive `@ever-works/agent/database` →
// `database.config.ts` (api-only `@src/config`) is never pulled into this spec.
jest.mock('@ever-works/agent/database', () => ({
    TenantEmailAddressRepository: class TenantEmailAddressRepository {},
    AgentEmailAssignmentRepository: class AgentEmailAssignmentRepository {},
    EmailMessageRepository: class EmailMessageRepository {},
}));
jest.mock('@ever-works/agent/facades', () => ({
    EmailFacadeService: class EmailFacadeService {},
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
 */
describe('EmailService.sendMessage authorization', () => {
    let addresses: {
        findByIdForUser: jest.Mock;
        findById: jest.Mock;
    };
    let assignments: { findPrimaryOutboundForAgent: jest.Mock };
    let messages: Record<string, jest.Mock>;
    let emailFacade: { send: jest.Mock };
    let service: EmailService;

    beforeEach(() => {
        addresses = {
            findByIdForUser: jest.fn(),
            findById: jest.fn(),
        };
        assignments = { findPrimaryOutboundForAgent: jest.fn() };
        messages = {};
        emailFacade = { send: jest.fn().mockResolvedValue({ providerMessageId: 'pm-1' }) };
        service = new EmailService(
            addresses as never,
            assignments as never,
            messages as never,
            emailFacade as never,
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
            agentId: 'agent-foreign',
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
                agentId: 'agent-foreign',
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
});
