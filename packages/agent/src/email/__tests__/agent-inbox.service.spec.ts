import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AgentInboxService, toAgentInboxDto } from '../agent-inbox.service';

/**
 * Agent email (AW-05) — per-Agent inbox settings (mode + ceilings).
 * Owner-scoped: a foreign Agent, inbox or address is a 404.
 */
function makeHarness() {
    const store: Record<string, any>[] = [];
    const inboxes = {
        create: jest.fn((entry: Record<string, any>) => ({ ...entry })),
        save: jest.fn(async (row: Record<string, any>) => {
            if (!row.id) {
                if (store.some((existing) => existing.agentId === row.agentId)) {
                    throw new Error('UNIQUE constraint failed: agent_inboxes.agentId');
                }
                row.id = `inbox-${store.length + 1}`;
                row.createdAt = new Date('2026-09-01T00:00:00Z');
                row.updatedAt = row.createdAt;
                store.push(row);
            }
            return row;
        }),
        findByAgentForUser: jest.fn(
            async (agentId: string, userId: string) =>
                store.find((row) => row.agentId === agentId && row.userId === userId) ?? null,
        ),
        findByIdForUser: jest.fn(
            async (id: string, userId: string) =>
                store.find((row) => row.id === id && row.userId === userId) ?? null,
        ),
        listForUser: jest.fn(async (userId: string) =>
            store.filter((row) => row.userId === userId),
        ),
    };
    const addresses = {
        findByIdForUser: jest.fn(async (id: string, userId: string) =>
            id === 'addr-1' && userId === 'user-1' ? { id: 'addr-1' } : null,
        ),
    };
    const agents = {
        findOne: jest.fn(async ({ where }: { where: { id: string; userId: string } }) =>
            where.id === 'agent-1' && where.userId === 'user-1'
                ? { id: 'agent-1', userId: 'user-1', organizationId: 'org-1', tenantId: 'tenant-1' }
                : null,
        ),
    };
    const service = new AgentInboxService(inboxes as never, addresses as never, agents as never);
    return { service, store, inboxes, addresses };
}

describe('AgentInboxService', () => {
    it('creates settings once, in draft review, stamped with the Agent scope', async () => {
        const { service } = makeHarness();

        const first = await service.ensure('user-1', 'agent-1');
        const second = await service.ensure('user-1', 'agent-1', { mode: 'auto-send' });

        expect(first.created).toBe(true);
        expect(first.inbox).toMatchObject({
            agentId: 'agent-1',
            mode: 'draft-review',
            state: 'active',
            organizationId: 'org-1',
            tenantId: 'tenant-1',
        });
        // Idempotent: the second call returns the first row and changes nothing.
        expect(second.created).toBe(false);
        expect(second.inbox.id).toBe(first.inbox.id);
        expect(second.inbox.mode).toBe('draft-review');
    });

    it('returns the winner when two creates race on the unique Agent index', async () => {
        const { service, inboxes, store } = makeHarness();
        // Simulate the other request landing between our read and our insert.
        inboxes.findByAgentForUser.mockResolvedValueOnce(null);
        store.push({ id: 'inbox-9', userId: 'user-1', agentId: 'agent-1', mode: 'draft-review' });

        const outcome = await service.ensure('user-1', 'agent-1');

        expect(outcome).toMatchObject({ created: false, inbox: { id: 'inbox-9' } });
    });

    it("treats another account's Agent exactly like a missing one", async () => {
        const { service } = makeHarness();
        await expect(service.ensure('user-2', 'agent-1')).rejects.toBeInstanceOf(NotFoundException);
        await expect(service.findForAgent('user-2', 'agent-1')).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });

    it('applies ceilings with null = inherit and 0 = no ceiling, and drops garbage to inherit', async () => {
        const { service } = makeHarness();
        const { inbox } = await service.ensure('user-1', 'agent-1', {
            dailySendCap: 0,
            burstSendCap: 5,
            recipientBurstCap: -3,
        });
        expect(inbox).toMatchObject({ dailySendCap: 0, burstSendCap: 5, recipientBurstCap: null });

        const updated = await service.update('user-1', inbox.id, { dailySendCap: null });
        expect(updated.dailySendCap).toBeNull();
        expect(updated.burstSendCap).toBe(5);
    });

    it('clears a recorded pause when a ceiling changes, and leaves it on other edits', async () => {
        const { service } = makeHarness();
        const { inbox } = await service.ensure('user-1', 'agent-1');
        inbox.capPausedUntil = new Date('2026-09-14T13:00:00Z');

        await service.update('user-1', inbox.id, { mode: 'auto-send' });
        expect(inbox.capPausedUntil).not.toBeNull();

        await service.update('user-1', inbox.id, { dailySendCap: 500 });
        expect(inbox.capPausedUntil).toBeNull();
    });

    it('pins only an address the owner holds, and rejects an unknown mode', async () => {
        const { service } = makeHarness();
        const { inbox } = await service.ensure('user-1', 'agent-1', { emailAddressId: 'addr-1' });
        expect(inbox.emailAddressId).toBe('addr-1');

        await expect(
            service.update('user-1', inbox.id, { emailAddressId: 'addr-foreign' }),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
            service.update('user-1', inbox.id, { mode: 'whenever' as never }),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.update('user-2', inbox.id, {})).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });

    it('refuses to pin a disabled or receive-only address, and keeps the pin it had', async () => {
        const { service, addresses } = makeHarness();
        const { inbox } = await service.ensure('user-1', 'agent-1', { emailAddressId: 'addr-1' });

        addresses.findByIdForUser.mockResolvedValueOnce({
            id: 'addr-retired',
            direction: 'outbound',
            disabledAt: new Date('2026-09-01T00:00:00Z'),
        } as never);
        await expect(
            service.update('user-1', inbox.id, { emailAddressId: 'addr-retired' }),
        ).rejects.toBeInstanceOf(BadRequestException);

        addresses.findByIdForUser.mockResolvedValueOnce({
            id: 'addr-in',
            direction: 'inbound',
            disabledAt: null,
        } as never);
        await expect(
            service.update('user-1', inbox.id, { emailAddressId: 'addr-in' }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect((await service.findForAgent('user-1', 'agent-1'))?.emailAddressId).toBe('addr-1');
    });

    it('projects a row to the wire shape with ISO dates', async () => {
        const { service } = makeHarness();
        const { inbox } = await service.ensure('user-1', 'agent-1', { dailySendCap: 25 });
        expect(toAgentInboxDto(inbox as never)).toEqual({
            id: inbox.id,
            agentId: 'agent-1',
            emailAddressId: null,
            mode: 'draft-review',
            state: 'active',
            caps: {
                inboxDailySends: 25,
                inboxBurstSends: null,
                inboxBurstRecipients: null,
                recipientsPerMessage: null,
            },
            capPausedUntil: null,
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:00.000Z',
        });
    });
});
