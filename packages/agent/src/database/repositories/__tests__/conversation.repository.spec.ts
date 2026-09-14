import type { Repository } from 'typeorm';
import { ConversationRepository } from '../conversation.repository';
import { Conversation } from '../../../entities/conversation.entity';
import { ConversationMessage } from '../../../entities/conversation-message.entity';

type MockedConv = jest.Mocked<
    Pick<
        Repository<Conversation>,
        'create' | 'save' | 'findOne' | 'findAndCount' | 'update' | 'delete'
    >
>;
type MockedMsg = jest.Mocked<Pick<Repository<ConversationMessage>, 'create' | 'save'>>;

describe('ConversationRepository', () => {
    let convRepo: MockedConv;
    let msgRepo: MockedMsg;
    let service: ConversationRepository;

    beforeEach(() => {
        convRepo = {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            findAndCount: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
        };
        msgRepo = {
            create: jest.fn(),
            save: jest.fn(),
        };
        service = new ConversationRepository(
            convRepo as unknown as Repository<Conversation>,
            msgRepo as unknown as Repository<ConversationMessage>,
        );
    });

    describe('create', () => {
        it('creates and saves a conversation with the provided input', async () => {
            const created = {} as Conversation;
            const saved = { id: 'c1' } as Conversation;
            convRepo.create.mockReturnValueOnce(created);
            convRepo.save.mockResolvedValueOnce(saved);

            const result = await service.create({
                userId: 'u1',
                title: 'Hi',
                providerId: 'openai',
                model: 'gpt-4',
            });

            expect(result).toBe(saved);
            expect(convRepo.create).toHaveBeenCalledWith({
                userId: 'u1',
                title: 'Hi',
                providerId: 'openai',
                model: 'gpt-4',
            });
            expect(convRepo.save).toHaveBeenCalledWith(created);
        });

        it('forwards an input with only userId (other fields optional)', async () => {
            convRepo.create.mockReturnValueOnce({} as Conversation);
            convRepo.save.mockResolvedValueOnce({ id: 'c1' } as Conversation);

            await service.create({ userId: 'u1' });

            expect(convRepo.create).toHaveBeenCalledWith({ userId: 'u1' });
        });
    });

    describe('findById', () => {
        it('queries by id with messages relation ordered ASC, no userId scope when userId omitted', async () => {
            const row = { id: 'c1' } as Conversation;
            convRepo.findOne.mockResolvedValueOnce(row);

            await expect(service.findById('c1')).resolves.toBe(row);

            expect(convRepo.findOne).toHaveBeenCalledWith({
                where: { id: 'c1' },
                relations: ['messages'],
                order: { messages: { createdAt: 'ASC' } },
            });
        });

        it('scopes by userId when provided (cross-user safety)', async () => {
            convRepo.findOne.mockResolvedValueOnce(null);

            await service.findById('c1', 'u1');

            expect(convRepo.findOne).toHaveBeenCalledWith({
                where: { id: 'c1', userId: 'u1' },
                relations: ['messages'],
                order: { messages: { createdAt: 'ASC' } },
            });
        });

        it('treats empty-string userId as omitted (the && short-circuits)', async () => {
            convRepo.findOne.mockResolvedValueOnce(null);

            await service.findById('c1', '');

            expect(convRepo.findOne).toHaveBeenCalledWith({
                where: { id: 'c1' },
                relations: ['messages'],
                order: { messages: { createdAt: 'ASC' } },
            });
        });

        it('returns null when no row matches', async () => {
            convRepo.findOne.mockResolvedValueOnce(null);
            await expect(service.findById('missing')).resolves.toBeNull();
        });
    });

    describe('findByUser', () => {
        it('paginates with default limit=50/offset=0 and returns {conversations, total}', async () => {
            const rows = [{ id: 'c1' } as Conversation];
            convRepo.findAndCount.mockResolvedValueOnce([rows, 1]);

            const result = await service.findByUser('u1');

            expect(result).toEqual({ conversations: rows, total: 1 });
            expect(convRepo.findAndCount).toHaveBeenCalledWith({
                where: { userId: 'u1' },
                order: { updatedAt: 'DESC' },
                take: 50,
                skip: 0,
                select: ['id', 'title', 'providerId', 'model', 'createdAt', 'updatedAt'],
            });
        });

        it('forwards explicit limit and offset', async () => {
            convRepo.findAndCount.mockResolvedValueOnce([[], 0]);

            await service.findByUser('u1', { limit: 10, offset: 20 });

            expect(convRepo.findAndCount).toHaveBeenCalledWith(
                expect.objectContaining({ take: 10, skip: 20 }),
            );
        });

        it('coerces 0 limit to default 50 via ?? short-circuit (0 ?? 50 = 0 — current behaviour)', async () => {
            convRepo.findAndCount.mockResolvedValueOnce([[], 0]);

            await service.findByUser('u1', { limit: 0 });

            // ?? does NOT coerce 0 — limit:0 is forwarded verbatim.
            expect(convRepo.findAndCount).toHaveBeenCalledWith(
                expect.objectContaining({ take: 0, skip: 0 }),
            );
        });
    });

    describe('appendMessage', () => {
        it('saves the message and touches the conversation updatedAt', async () => {
            const created = {} as ConversationMessage;
            const saved = { id: 'm1' } as ConversationMessage;
            msgRepo.create.mockReturnValueOnce(created);
            msgRepo.save.mockResolvedValueOnce(saved);
            convRepo.update.mockResolvedValueOnce({
                affected: 1,
                raw: {},
                generatedMaps: [],
            });

            const before = Date.now();
            const result = await service.appendMessage({
                conversationId: 'c1',
                role: 'user' as const,
                content: 'hi',
            });
            const after = Date.now();

            expect(result).toBe(saved);
            expect(msgRepo.create).toHaveBeenCalledWith({
                conversationId: 'c1',
                role: 'user' as const,
                content: 'hi',
            });
            expect(msgRepo.save).toHaveBeenCalledWith(created);
            const [convId, patch] = convRepo.update.mock.calls[0] as [string, { updatedAt: Date }];
            expect(convId).toBe('c1');
            expect(patch.updatedAt).toBeInstanceOf(Date);
            const t = patch.updatedAt.getTime();
            expect(t).toBeGreaterThanOrEqual(before);
            expect(t).toBeLessThanOrEqual(after);
        });
    });

    describe('appendMessages', () => {
        it('returns empty array without touching repos when input is empty', async () => {
            await expect(service.appendMessages([])).resolves.toEqual([]);
            expect(msgRepo.create).not.toHaveBeenCalled();
            expect(msgRepo.save).not.toHaveBeenCalled();
            expect(convRepo.update).not.toHaveBeenCalled();
        });

        it('saves messages sequentially with explicit createdAt = baseTime + i', async () => {
            jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            const baseTime = Date.now();

            const inputs = [
                {
                    conversationId: 'c1',
                    role: 'user' as const,
                    content: 'a',
                },
                {
                    conversationId: 'c1',
                    role: 'assistant' as const,
                    content: 'b',
                },
            ];

            // Capture the actual entity passed to create() for each call.
            const created: Array<Partial<ConversationMessage>> = [];
            msgRepo.create.mockImplementation((entity) => {
                const e = entity as Partial<ConversationMessage>;
                created.push(e);
                return e as ConversationMessage;
            });
            msgRepo.save
                .mockResolvedValueOnce({ id: 'm1' } as ConversationMessage)
                .mockResolvedValueOnce({ id: 'm2' } as ConversationMessage);
            convRepo.update.mockResolvedValueOnce({ affected: 1, raw: {}, generatedMaps: [] });

            const result = await service.appendMessages(inputs);

            expect(result).toEqual([{ id: 'm1' }, { id: 'm2' }]);
            expect(msgRepo.create).toHaveBeenCalledTimes(2);
            expect(msgRepo.save).toHaveBeenCalledTimes(2);
            expect(created[0].createdAt).toEqual(new Date(baseTime + 0));
            expect(created[1].createdAt).toEqual(new Date(baseTime + 1));

            // Conversation timestamp touched once at end with first message's conversationId.
            expect(convRepo.update).toHaveBeenCalledTimes(1);
            const [convId] = convRepo.update.mock.calls[0] as [string, { updatedAt: Date }];
            expect(convId).toBe('c1');

            jest.useRealTimers();
        });

        it('uses the FIRST message conversationId for the touch (cross-conversation appends are not supported)', async () => {
            const inputs = [
                { conversationId: 'c-first', role: 'user' as const, content: 'a' },
                { conversationId: 'c-other', role: 'user' as const, content: 'b' },
            ];
            msgRepo.create.mockImplementation((e) => e as ConversationMessage);
            msgRepo.save
                .mockResolvedValueOnce({ id: 'm1' } as ConversationMessage)
                .mockResolvedValueOnce({ id: 'm2' } as ConversationMessage);
            convRepo.update.mockResolvedValueOnce({ affected: 1, raw: {}, generatedMaps: [] });

            await service.appendMessages(inputs);

            expect(convRepo.update.mock.calls[0][0]).toBe('c-first');
        });
    });

    describe('updateTitle', () => {
        it('updates by composite (id, userId) key with title only when metadata omitted', async () => {
            convRepo.update.mockResolvedValueOnce({ affected: 1, raw: {}, generatedMaps: [] });

            await expect(service.updateTitle('c1', 'u1', 'New title')).resolves.toBeUndefined();

            expect(convRepo.update).toHaveBeenCalledWith(
                { id: 'c1', userId: 'u1' },
                { title: 'New title' },
            );
        });

        it('includes metadata when provided', async () => {
            convRepo.update.mockResolvedValueOnce({ affected: 1, raw: {}, generatedMaps: [] });

            await service.updateTitle('c1', 'u1', 'Title', { aiTitle: true });

            expect(convRepo.update).toHaveBeenCalledWith(
                { id: 'c1', userId: 'u1' },
                { title: 'Title', metadata: { aiTitle: true } },
            );
        });

        it('does NOT include metadata when explicitly undefined', async () => {
            convRepo.update.mockResolvedValueOnce({ affected: 1, raw: {}, generatedMaps: [] });

            await service.updateTitle('c1', 'u1', 'Title', undefined);

            expect(convRepo.update).toHaveBeenCalledWith(
                { id: 'c1', userId: 'u1' },
                { title: 'Title' },
            );
        });
    });

    describe('delete', () => {
        it('deletes by composite (id, userId) key and returns true when affected>0', async () => {
            convRepo.delete.mockResolvedValueOnce({ affected: 1, raw: {} });

            await expect(service.delete('c1', 'u1')).resolves.toBe(true);

            expect(convRepo.delete).toHaveBeenCalledWith({ id: 'c1', userId: 'u1' });
        });

        it('returns false when no row affected', async () => {
            convRepo.delete.mockResolvedValueOnce({ affected: 0, raw: {} });
            await expect(service.delete('c1', 'u1')).resolves.toBe(false);
        });

        it('coerces undefined affected to 0 (returns false)', async () => {
            convRepo.delete.mockResolvedValueOnce({ affected: undefined, raw: {} });
            await expect(service.delete('c1', 'u1')).resolves.toBe(false);
        });
    });

    describe('deleteAllByUser', () => {
        it('returns the affected count verbatim', async () => {
            convRepo.delete.mockResolvedValueOnce({ affected: 5, raw: {} });

            await expect(service.deleteAllByUser('u1')).resolves.toBe(5);

            expect(convRepo.delete).toHaveBeenCalledWith({ userId: 'u1' });
        });

        it('coerces undefined affected to 0', async () => {
            convRepo.delete.mockResolvedValueOnce({ affected: undefined, raw: {} });
            await expect(service.deleteAllByUser('u1')).resolves.toBe(0);
        });

        it('returns 0 when nothing was deleted', async () => {
            convRepo.delete.mockResolvedValueOnce({ affected: 0, raw: {} });
            await expect(service.deleteAllByUser('u1')).resolves.toBe(0);
        });
    });
});

/**
 * Named Conversations — the reads and writes added beside the legacy methods.
 * The legacy projection above stays pinned; these pin the new ones: scoped
 * lists ordered by last activity, scoped single reads, name ownership,
 * newest-last paging and activity tracking on insert.
 */
describe('ConversationRepository — named Conversations', () => {
    const SCOPE = { tenantId: 't1', organizationId: 'o1' };
    let convRepo: Record<string, jest.Mock>;
    let msgRepo: Record<string, jest.Mock>;
    let queryBuilder: Record<string, jest.Mock>;
    let service: ConversationRepository;

    beforeEach(() => {
        queryBuilder = {};
        for (const method of [
            'select',
            'addSelect',
            'leftJoin',
            'where',
            'andWhere',
            'groupBy',
            'orderBy',
            'take',
        ]) {
            queryBuilder[method] = jest.fn(() => queryBuilder);
        }
        queryBuilder.getRawMany = jest.fn().mockResolvedValue([]);
        queryBuilder.getMany = jest.fn().mockResolvedValue([]);
        convRepo = {
            findAndCount: jest.fn().mockResolvedValue([[], 0]),
            findOne: jest.fn().mockResolvedValue(null),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
        };
        msgRepo = {
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn().mockResolvedValue(null),
            create: jest.fn((row: unknown) => row),
            save: jest.fn(async (row: unknown) => ({ id: 'm1', ...(row as object) })),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
            delete: jest.fn().mockResolvedValue({ affected: 1 }),
            createQueryBuilder: jest.fn(() => queryBuilder),
        };
        service = new ConversationRepository(convRepo as any, msgRepo as any);
    });

    it('lists one scope, newest activity first, with the named-list columns', async () => {
        await service.findSummariesByUser(
            'u1',
            { kind: 'direct', agentId: 'a1', limit: 10 },
            SCOPE,
        );

        const options = convRepo.findAndCount.mock.calls[0][0];
        expect(options.where).toEqual([
            { userId: 'u1', tenantId: 't1', organizationId: 'o1', kind: 'direct', agentId: 'a1' },
        ]);
        expect(options.order).toEqual({
            lastMessageAt: { direction: 'DESC', nulls: 'LAST' },
            updatedAt: 'DESC',
        });
        expect(options.take).toBe(10);
        expect(options.select).toEqual(
            expect.arrayContaining(['kind', 'agentId', 'titleSource', 'lastMessageAt']),
        );
    });

    it('reads one Conversation only inside the caller’s scope', async () => {
        await service.findByIdForUser('c1', 'u1', SCOPE);
        expect(convRepo.findOne).toHaveBeenCalledWith({
            where: [{ userId: 'u1', tenantId: 't1', organizationId: 'o1', id: 'c1' }],
        });
    });

    it('a set name is owned by the person; a cleared one resets the source', async () => {
        await service.setName('c1', 'u1', 'Launch');
        expect(convRepo.update).toHaveBeenLastCalledWith(
            { id: 'c1', userId: 'u1' },
            { title: 'Launch', titleSource: 'user' },
        );
        await service.setName('c1', 'u1', null);
        expect(convRepo.update).toHaveBeenLastCalledWith(
            { id: 'c1', userId: 'u1' },
            { title: null, titleSource: null },
        );
    });

    it('pages messages newest-last, and an unknown `before` returns nothing', async () => {
        queryBuilder.getMany.mockResolvedValue([{ id: 'm3' }, { id: 'm2' }]);
        await expect(service.findMessagesPaged('c1', 2)).resolves.toEqual([
            { id: 'm2' },
            { id: 'm3' },
        ]);
        expect(queryBuilder.orderBy).toHaveBeenCalledWith('m.createdAt', 'DESC');
        expect(queryBuilder.take).toHaveBeenCalledWith(2);

        msgRepo.findOne.mockResolvedValue(null);
        await expect(service.findMessagesPaged('c1', 2, 'm-unknown')).resolves.toEqual([]);
    });

    it('stores a message as sent by default and moves the Conversation’s activity', async () => {
        await service.insertMessage({
            conversationId: 'c1',
            role: 'user',
            content: 'hi',
            authorType: 'user',
            authorId: 'u1',
        });
        expect(msgRepo.create).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'sent', createdAt: expect.any(Date) }),
        );
        expect(convRepo.update).toHaveBeenCalledWith('c1', {
            updatedAt: expect.any(Date),
            lastMessageAt: expect.any(Date),
        });
    });

    it('counts unread Agent and system messages per Conversation', async () => {
        queryBuilder.getRawMany.mockResolvedValue([
            { conversationId: 'c1', count: '2' },
            { conversationId: 'c2', count: 0 },
        ]);
        const counts = await service.unreadCountsFor('u1', ['c1', 'c2']);
        expect([...counts.entries()]).toEqual([['c1', 2]]);
        expect(queryBuilder.andWhere).toHaveBeenCalledWith('m.authorType IN (:...authorTypes)', {
            authorTypes: ['agent', 'system'],
        });
        await expect(service.unreadCountsFor('u1', [])).resolves.toEqual(new Map());
    });

    it('legacy appends also move last activity', async () => {
        msgRepo.create.mockReturnValue({});
        msgRepo.save.mockResolvedValue({ id: 'm1' });
        await service.appendMessage({ conversationId: 'c1', role: 'assistant', content: 'x' });
        const [, patch] = convRepo.update.mock.calls[0];
        expect(patch.lastMessageAt).toBeInstanceOf(Date);
    });

    it('legacy appends record a model turn as system-authored, never as the person', async () => {
        await service.appendMessage({ conversationId: 'c1', role: 'assistant', content: 'x' });
        expect(msgRepo.create).toHaveBeenLastCalledWith(
            expect.objectContaining({ role: 'assistant', authorType: 'system' }),
        );

        await service.appendMessages([
            { conversationId: 'c1', role: 'user', content: 'q' },
            { conversationId: 'c1', role: 'assistant', content: 'a' },
            { conversationId: 'c1', role: 'tool', content: '{}' },
        ]);
        // A `user` turn keeps the column default, which is already `user`.
        expect(msgRepo.create.mock.calls.slice(-3).map(([row]) => row.authorType)).toEqual([
            undefined,
            'system',
            'system',
        ]);
    });

    it('a legacy append whose read bookkeeping fails still succeeds', async () => {
        // No `manager` on this mock: the read-position update throws inside.
        await expect(
            service.appendMessages([{ conversationId: 'c1', role: 'assistant', content: 'x' }]),
        ).resolves.toEqual([expect.objectContaining({ id: 'm1', authorType: 'system' })]);
    });
});
