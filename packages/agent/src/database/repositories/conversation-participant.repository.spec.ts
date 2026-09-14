import { IsNull, QueryFailedError } from 'typeorm';
import { ConversationParticipantRepository } from './conversation-participant.repository';

/**
 * Conversation participants — the behaviours the rest of the feature leans
 * on and that TypeORM does not give for free:
 *
 *  - `addIfAbsent` is idempotent AND race-safe: a lost race against
 *    `uq_conversation_participants` returns the winning row, never an error
 *    (two concurrent adds must agree on ONE participant);
 *  - a departure is `leftAt`, never a delete, and current-member reads
 *    exclude departed rows unless asked;
 *  - a non-unique database error is not swallowed.
 */
describe('ConversationParticipantRepository', () => {
    let repository: {
        find: jest.Mock;
        findOne: jest.Mock;
        create: jest.Mock;
        save: jest.Mock;
        update: jest.Mock;
        count: jest.Mock;
    };
    let participants: ConversationParticipantRepository;

    beforeEach(() => {
        repository = {
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn().mockResolvedValue(null),
            create: jest.fn((row: unknown) => row),
            save: jest.fn(async (row: unknown) => ({ id: 'p1', ...(row as object) })),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
            count: jest.fn().mockResolvedValue(0),
        };
        participants = new ConversationParticipantRepository(repository as any);
    });

    describe('addIfAbsent', () => {
        const input = {
            conversationId: 'c1',
            participantType: 'agent' as const,
            participantId: 'a1',
            tenantId: 't1',
            organizationId: 'o1',
        };

        it('inserts a member with the given scope when absent', async () => {
            const row = await participants.addIfAbsent(input);
            expect(repository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    conversationId: 'c1',
                    participantType: 'agent',
                    participantId: 'a1',
                    role: 'member',
                    tenantId: 't1',
                    organizationId: 'o1',
                    joinedAt: expect.any(Date),
                }),
            );
            expect(row.id).toBe('p1');
        });

        it('returns the existing row without inserting a second one', async () => {
            const existing = { id: 'p-existing', ...input };
            repository.findOne.mockResolvedValue(existing);
            await expect(participants.addIfAbsent(input)).resolves.toBe(existing);
            expect(repository.save).not.toHaveBeenCalled();
        });

        it('a lost race against the unique constraint returns the winner', async () => {
            const winner = { id: 'p-winner', ...input };
            repository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
            repository.save.mockRejectedValue(
                new QueryFailedError('INSERT', [], { code: '23505' } as any),
            );
            await expect(participants.addIfAbsent(input)).resolves.toBe(winner);
        });

        it('rethrows any other database error', async () => {
            repository.save.mockRejectedValue(new Error('connection lost'));
            await expect(participants.addIfAbsent(input)).rejects.toThrow('connection lost');
        });
    });

    it('lists current participants only, unless departed ones are asked for', async () => {
        await participants.listForConversation('c1');
        expect(repository.find).toHaveBeenLastCalledWith({
            where: { conversationId: 'c1', leftAt: IsNull() },
            order: { joinedAt: 'ASC' },
        });
        await participants.listForConversation('c1', { includeLeft: true });
        expect(repository.find).toHaveBeenLastCalledWith({
            where: { conversationId: 'c1' },
            order: { joinedAt: 'ASC' },
        });
    });

    it('lists the Conversations a participant is currently in', async () => {
        repository.find.mockResolvedValue([{ conversationId: 'c1' }, { conversationId: 'c2' }]);
        await expect(participants.listConversationsFor('agent', 'a1')).resolves.toEqual([
            'c1',
            'c2',
        ]);
        expect(repository.find).toHaveBeenCalledWith({
            where: { participantType: 'agent', participantId: 'a1', leftAt: IsNull() },
            select: ['conversationId'],
        });
    });

    it('marks a departure with leftAt and never deletes', async () => {
        await expect(participants.markLeft('c1', 'agent', 'a1')).resolves.toBe(true);
        expect(repository.update).toHaveBeenCalledWith(
            {
                conversationId: 'c1',
                participantType: 'agent',
                participantId: 'a1',
                leftAt: IsNull(),
            },
            { leftAt: expect.any(Date) },
        );
        repository.update.mockResolvedValueOnce({ affected: 0 });
        await expect(participants.markLeft('c1', 'agent', 'a1')).resolves.toBe(false);
    });

    it('moves the read position', async () => {
        const at = new Date('2026-09-01T00:00:00Z');
        await participants.markRead('c1', 'user', 'u1', 'm9', at);
        expect(repository.update).toHaveBeenCalledWith(
            { conversationId: 'c1', participantType: 'user', participantId: 'u1' },
            { lastReadMessageId: 'm9', lastReadAt: at },
        );
    });

    it('counts only current Agents', async () => {
        repository.count.mockResolvedValue(3);
        await expect(participants.countActiveAgents('c1')).resolves.toBe(3);
        expect(repository.count).toHaveBeenCalledWith({
            where: { conversationId: 'c1', participantType: 'agent', leftAt: IsNull() },
        });
    });
});
