import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ConversationService } from '../conversation.service';

const SCOPE = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
};

describe('ConversationService', () => {
    let conversations: Record<string, jest.Mock>;
    let participants: Record<string, jest.Mock>;
    let agents: { findByIdAndUser: jest.Mock };
    let contexts: { resolve: jest.Mock };
    let service: ConversationService;

    beforeEach(() => {
        conversations = {
            create: jest.fn(async (input) => ({ id: 'c1', createdAt: new Date(), ...input })),
            findByIdForUser: jest.fn(),
            findSummariesByUser: jest.fn().mockResolvedValue({ conversations: [], total: 0 }),
            unreadCountsFor: jest.fn().mockResolvedValue(new Map()),
            firstMessagePreviews: jest.fn().mockResolvedValue(new Map()),
            setName: jest.fn().mockResolvedValue(true),
            findMessageById: jest.fn(),
        };
        participants = {
            addIfAbsent: jest.fn(async (input) => input),
            listForConversation: jest.fn().mockResolvedValue([]),
            markRead: jest.fn().mockResolvedValue(true),
        };
        agents = { findByIdAndUser: jest.fn().mockResolvedValue({ id: 'a1', status: 'active' }) };
        contexts = {
            resolve: jest.fn().mockResolvedValue({ type: 'mission', id: 'm1', label: 'M' }),
        };
        service = new ConversationService(
            conversations as any,
            participants as any,
            agents as any,
            contexts as any,
        );
    });

    describe('create', () => {
        it('opens a direct Conversation addressed at a visible Agent and seeds both participants', async () => {
            const created = await service.create('u1', { agentId: 'a1' }, SCOPE);

            expect(agents.findByIdAndUser).toHaveBeenCalledWith('a1', 'u1', SCOPE);
            expect(conversations.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'u1',
                    kind: 'direct',
                    agentId: 'a1',
                    tenantId: SCOPE.tenantId,
                    organizationId: SCOPE.organizationId,
                }),
            );
            expect(created.id).toBe('c1');
            expect(participants.addIfAbsent).toHaveBeenCalledWith(
                expect.objectContaining({
                    participantType: 'user',
                    participantId: 'u1',
                    role: 'owner',
                }),
            );
            expect(participants.addIfAbsent).toHaveBeenCalledWith(
                expect.objectContaining({
                    participantType: 'agent',
                    participantId: 'a1',
                    role: 'member',
                }),
            );
        });

        it('refuses an Agent the caller cannot see with the same 404 as a missing one', async () => {
            agents.findByIdAndUser.mockResolvedValue(null);
            await expect(service.create('u1', { agentId: 'a-foreign' }, SCOPE)).rejects.toThrow(
                NotFoundException,
            );
            expect(conversations.create).not.toHaveBeenCalled();
        });

        it('refuses kinds that cannot be opened here', async () => {
            for (const kind of ['group', 'organization_channel', 'agent_pair'] as const) {
                await expect(service.create('u1', { kind })).rejects.toThrow(BadRequestException);
            }
            expect(conversations.create).not.toHaveBeenCalled();
        });

        it('requires context type and id together, and a context the caller can see', async () => {
            await expect(
                service.create('u1', { contextType: 'mission', contextId: null }),
            ).rejects.toThrow(BadRequestException);

            contexts.resolve.mockResolvedValueOnce(null);
            await expect(
                service.create('u1', { contextType: 'mission', contextId: 'm-hidden' }, SCOPE),
            ).rejects.toThrow(NotFoundException);

            await service.create('u1', { contextType: 'mission', contextId: 'm1' }, SCOPE);
            expect(contexts.resolve).toHaveBeenLastCalledWith('u1', 'mission', 'm1', SCOPE);
            expect(conversations.create).toHaveBeenCalledWith(
                expect.objectContaining({ contextType: 'mission', contextId: 'm1' }),
            );
        });

        it('a name given at creation belongs to the person', async () => {
            await service.create('u1', { agentId: 'a1', title: '  Launch plan  ' });
            expect(conversations.create).toHaveBeenCalledWith(
                expect.objectContaining({ title: 'Launch plan', titleSource: 'user' }),
            );
        });
    });

    describe('assertParticipant', () => {
        it('answers a Conversation the caller may not read exactly like a missing one', async () => {
            conversations.findByIdForUser.mockResolvedValue(null);
            const error = await service.assertParticipant('c-other', 'u1', SCOPE).catch((e) => e);
            expect(error).toBeInstanceOf(NotFoundException);
            expect(error.message).toBe('Not Found');
            expect(conversations.findByIdForUser).toHaveBeenCalledWith('c-other', 'u1', SCOPE);
        });
    });

    describe('rename', () => {
        beforeEach(() => {
            conversations.findByIdForUser.mockResolvedValue({
                id: 'c1',
                userId: 'u1',
                kind: 'direct',
            });
        });

        it('sets a trimmed name owned by the person', async () => {
            const result = await service.rename('c1', 'u1', '  Q3 launch ', SCOPE);
            expect(conversations.setName).toHaveBeenCalledWith('c1', 'u1', 'Q3 launch');
            expect(result).toMatchObject({ title: 'Q3 launch', titleSource: 'user' });
        });

        it('clears the name with null so automatic titling can run again', async () => {
            const result = await service.rename('c1', 'u1', null);
            expect(conversations.setName).toHaveBeenCalledWith('c1', 'u1', null);
            expect(result.titleSource).toBeNull();
        });

        it('caps names at 200 characters and refuses a blank one', async () => {
            await expect(service.rename('c1', 'u1', 'x'.repeat(201))).rejects.toThrow(
                /at most 200 characters\. This one is 201/,
            );
            await expect(service.rename('c1', 'u1', '   ')).rejects.toThrow(BadRequestException);
            await expect(service.rename('c1', 'u1', 'x'.repeat(200))).resolves.toBeDefined();
        });

        it('the organization channel and Agent pairs keep their own names', async () => {
            for (const kind of ['organization_channel', 'agent_pair']) {
                conversations.findByIdForUser.mockResolvedValueOnce({
                    id: 'c1',
                    userId: 'u1',
                    kind,
                });
                await expect(service.rename('c1', 'u1', 'mine')).rejects.toThrow(ConflictException);
            }
            expect(conversations.setName).not.toHaveBeenCalled();
        });
    });

    describe('list', () => {
        it('scopes the list, clamps the page and attaches unread counts', async () => {
            conversations.findSummariesByUser.mockResolvedValue({
                conversations: [
                    {
                        id: 'c1',
                        kind: 'direct',
                        agentId: 'a1',
                        title: null,
                        createdAt: 1,
                        updatedAt: 2,
                    },
                    {
                        id: 'c2',
                        kind: 'direct',
                        agentId: null,
                        title: 'Named',
                        createdAt: 1,
                        updatedAt: 2,
                    },
                ],
                total: 2,
            });
            conversations.unreadCountsFor.mockResolvedValue(new Map([['c1', 3]]));

            const result = await service.list('u1', { limit: 5000, kind: 'direct' }, SCOPE);

            expect(conversations.findSummariesByUser).toHaveBeenCalledWith(
                'u1',
                { limit: 200, offset: 0, kind: 'direct' },
                SCOPE,
            );
            expect(conversations.unreadCountsFor).toHaveBeenCalledWith('u1', ['c1', 'c2']);
            expect(conversations.firstMessagePreviews).toHaveBeenCalledWith(['c1', 'c2']);
            expect(result.total).toBe(2);
            expect(result.conversations.map((row) => [row.id, row.unreadCount, row.title])).toEqual(
                [
                    ['c1', 3, null],
                    ['c2', 0, 'Named'],
                ],
            );
        });

        it('defaults to fifty rows', async () => {
            await service.list('u1', {});
            expect(conversations.findSummariesByUser).toHaveBeenCalledWith(
                'u1',
                expect.objectContaining({ limit: 50, offset: 0 }),
                undefined,
            );
        });
    });

    describe('markRead', () => {
        it('moves the read position to a message of this Conversation', async () => {
            conversations.findByIdForUser.mockResolvedValue({
                id: 'c1',
                userId: 'u1',
                kind: 'direct',
            });
            const createdAt = new Date('2026-09-01T10:00:00.000Z');
            conversations.findMessageById.mockResolvedValue({
                id: 'm9',
                conversationId: 'c1',
                createdAt,
            });

            await service.markRead('c1', 'u1', 'm9', SCOPE);

            expect(participants.addIfAbsent).toHaveBeenCalledWith(
                expect.objectContaining({ participantId: 'u1', role: 'owner' }),
            );
            expect(participants.markRead).toHaveBeenCalledWith('c1', 'user', 'u1', 'm9', createdAt);
        });

        it('404s for a message from another Conversation', async () => {
            conversations.findByIdForUser.mockResolvedValue({
                id: 'c1',
                userId: 'u1',
                kind: 'direct',
            });
            conversations.findMessageById.mockResolvedValue(null);
            await expect(service.markRead('c1', 'u1', 'm-elsewhere')).rejects.toThrow(
                NotFoundException,
            );
            expect(participants.markRead).not.toHaveBeenCalled();
        });
    });
});
