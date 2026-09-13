jest.mock('@ever-works/agent/database', () => ({
    AgentEmailAssignmentRepository: class AgentEmailAssignmentRepository {},
    TenantEmailAddressRepository: class TenantEmailAddressRepository {},
    AgentRepository: class AgentRepository {},
}));

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AgentEmailAssignmentsService } from './agent-email-assignments.service';

/**
 * Agent email (AW-05) — the write path for Agent ↔ address assignments.
 * Both halves are owner-scoped: a foreign Agent or a foreign address is a
 * 404, never a way to send from somebody else's address.
 */
describe('AgentEmailAssignmentsService', () => {
    const address = {
        id: 'addr-1',
        userId: 'user-1',
        address: 'nova@x.com',
        direction: 'both',
        providerSettings: { apiKey: 'secret' },
    };
    let assignments: Record<string, jest.Mock>;
    let addresses: { findByIdForUser: jest.Mock };
    let agents: { findByIdAndUser: jest.Mock };
    let service: AgentEmailAssignmentsService;

    beforeEach(() => {
        assignments = {
            findByAgent: jest.fn().mockResolvedValue([]),
            findById: jest.fn().mockResolvedValue(null),
            create: jest.fn((entry) => entry),
            save: jest.fn(async (entry) => ({
                id: 'as-1',
                createdAt: new Date('2026-09-14T00:00:00Z'),
                ...entry,
            })),
            delete: jest.fn().mockResolvedValue(undefined),
        };
        addresses = { findByIdForUser: jest.fn().mockResolvedValue(address) };
        agents = {
            findByIdAndUser: jest.fn(async (id: string, userId: string) =>
                id === 'agent-1' && userId === 'user-1' ? { id } : null,
            ),
        };
        service = new AgentEmailAssignmentsService(
            assignments as never,
            addresses as never,
            agents as never,
        );
    });

    it('assigns an owned address with the documented defaults and never projects provider settings', async () => {
        const view = await service.create('user-1', 'agent-1', {
            emailAddressId: 'addr-1',
            direction: 'outbound',
        });
        expect(assignments.save).toHaveBeenCalledWith({
            agentId: 'agent-1',
            emailAddressId: 'addr-1',
            direction: 'outbound',
            priority: 100,
            dispatchMode: 'task-spawn',
        });
        expect(view).toEqual({
            id: 'as-1',
            agentId: 'agent-1',
            emailAddressId: 'addr-1',
            address: 'nova@x.com',
            direction: 'outbound',
            priority: 100,
            dispatchMode: 'task-spawn',
            createdAt: '2026-09-14T00:00:00.000Z',
        });
        expect(JSON.stringify(view)).not.toContain('secret');
    });

    it("refuses another account's Agent and another account's address alike", async () => {
        await expect(
            service.create('user-2', 'agent-1', {
                emailAddressId: 'addr-1',
                direction: 'outbound',
            }),
        ).rejects.toBeInstanceOf(NotFoundException);
        addresses.findByIdForUser.mockResolvedValue(null);
        await expect(
            service.create('user-1', 'agent-1', {
                emailAddressId: 'addr-x',
                direction: 'outbound',
            }),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(assignments.save).not.toHaveBeenCalled();
    });

    it('refuses to assign a receive-only address for sending', async () => {
        addresses.findByIdForUser.mockResolvedValue({ ...address, direction: 'inbound' });
        await expect(
            service.create('user-1', 'agent-1', {
                emailAddressId: 'addr-1',
                direction: 'outbound',
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a duplicate assignment with 409', async () => {
        assignments.findByAgent.mockResolvedValue([{ emailAddressId: 'addr-1' }]);
        await expect(
            service.create('user-1', 'agent-1', { emailAddressId: 'addr-1', direction: 'inbound' }),
        ).rejects.toBeInstanceOf(ConflictException);
    });

    it('lists only rows whose address the caller owns', async () => {
        assignments.findByAgent.mockResolvedValue([
            {
                id: 'as-1',
                agentId: 'agent-1',
                emailAddressId: 'addr-1',
                direction: 'inbound',
                priority: 100,
                dispatchMode: 'conversation',
                createdAt: new Date('2026-09-14T00:00:00Z'),
                emailAddress: address,
            },
            {
                id: 'as-2',
                agentId: 'agent-1',
                emailAddressId: 'addr-foreign',
                direction: 'outbound',
                priority: 1,
                dispatchMode: 'task-spawn',
                createdAt: new Date('2026-09-14T00:00:00Z'),
                emailAddress: { id: 'addr-foreign', userId: 'user-2', address: 'x@y.com' },
            },
        ]);
        const rows = await service.list('user-1', 'agent-1');
        expect(rows.map((row) => row.id)).toEqual(['as-1']);
        await expect(service.list('user-2', 'agent-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('removes an assignment only through an Agent the caller owns', async () => {
        assignments.findById.mockResolvedValue({ id: 'as-1', agentId: 'agent-1' });
        await expect(service.remove('user-2', 'as-1')).rejects.toBeInstanceOf(NotFoundException);
        expect(assignments.delete).not.toHaveBeenCalled();

        await service.remove('user-1', 'as-1');
        expect(assignments.delete).toHaveBeenCalledWith('as-1');

        assignments.findById.mockResolvedValue(null);
        await expect(service.remove('user-1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    });
});
