import { DataSource } from 'typeorm';
import { ENTITIES } from '../_entities-inventory';
import { Agent, AgentScope, AgentStatus } from '../../entities/agent.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { Conversation } from '../../entities/conversation.entity';
import { ConversationMessage } from '../../entities/conversation-message.entity';
import { ConversationParticipant } from '../../entities/conversation-participant.entity';
import { User } from '../../entities/user.entity';
import { AgentRunRepository } from './agent-run.repository';
import { ConversationParticipantRepository } from './conversation-participant.repository';
import { ConversationRepository } from './conversation.repository';
import { ConversationService } from '../../conversations/conversation.service';
import {
    ConversationMessageService,
    agentReplyClientMessageId,
} from '../../conversations/conversation-message.service';

/**
 * The REAL SQL behind named Conversations, against a real (better-sqlite3,
 * synchronize) schema. The unit specs mock TypeORM, so they cannot notice a
 * partial unique index that stops refusing a repeated client id, an unread
 * join that counts the reader's own messages, a list that leaks another
 * Organization's rows, or an in-flight lookup whose subquery matches nothing.
 */
describe('named Conversations — repository integration (better-sqlite3)', () => {
    const ORG = '33333333-3333-4333-8333-333333333333';
    const OTHER_ORG = '66666666-6666-4666-8666-666666666666';
    const TENANT = '44444444-4444-4444-8444-444444444444';

    let dataSource: DataSource;
    let conversations: ConversationRepository;
    let participants: ConversationParticipantRepository;
    let runs: AgentRunRepository;
    let userId: string;
    let agentId: string;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();

        conversations = new ConversationRepository(
            dataSource.getRepository(Conversation),
            dataSource.getRepository(ConversationMessage),
        );
        participants = new ConversationParticipantRepository(
            dataSource.getRepository(ConversationParticipant),
        );
        runs = new AgentRunRepository(dataSource.getRepository(AgentRun));

        const users = dataSource.getRepository(User);
        const user = await users.save(
            users.create({
                username: 'conversation-owner',
                email: 'conversation-owner@example.com',
                password: 'x',
            } as Partial<User>),
        );
        userId = user.id;
        const agents = dataSource.getRepository(Agent);
        const agent = await agents.save(
            agents.create({
                userId,
                organizationId: ORG,
                tenantId: TENANT,
                scope: AgentScope.TENANT,
                name: 'Nova',
                slug: 'nova',
                title: 'Research',
                status: AgentStatus.ACTIVE,
                permissions: {},
            } as Partial<Agent>),
        );
        agentId = agent.id;
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const openDirect = (organizationId: string | null, title?: string) =>
        conversations.create({
            userId,
            kind: 'direct',
            agentId,
            tenantId: TENANT,
            organizationId,
            ...(title ? { title, titleSource: 'user' as const } : {}),
        });

    it('new columns default so a legacy-shaped create reads as a direct thread', async () => {
        const legacy = await conversations.create({ userId, title: 'old style' });
        const row = await dataSource.getRepository(Conversation).findOneByOrFail({ id: legacy.id });
        expect(row.kind).toBe('direct');
        expect(row.agentId).toBeNull();
        expect(row.titleSource).toBeNull();
    });

    it('refuses a repeated client id in one Conversation, not across Conversations', async () => {
        const a = await openDirect(ORG);
        const b = await openDirect(ORG);
        const send = (conversationId: string, clientMessageId: string | null) =>
            conversations.insertMessage({
                conversationId,
                role: 'user',
                content: 'hi',
                authorType: 'user',
                authorId: userId,
                clientMessageId,
            });

        await send(a.id, 'client-1');
        await expect(send(a.id, 'client-1')).rejects.toThrow();
        await expect(send(b.id, 'client-1')).resolves.toBeDefined();
        await expect(send(a.id, null)).resolves.toBeDefined();
        await expect(send(a.id, null)).resolves.toBeDefined();
        await expect(conversations.findByClientMessageId(a.id, 'client-1')).resolves.toMatchObject({
            clientMessageId: 'client-1',
        });
    });

    it('lists only the active Organization, and tracks last activity on insert', async () => {
        const mine = await openDirect(ORG, 'In this org');
        const elsewhere = await openDirect(OTHER_ORG, 'In another org');
        await conversations.insertMessage({
            conversationId: mine.id,
            role: 'user',
            content: 'hello',
            authorType: 'user',
            authorId: userId,
        });

        const { conversations: rows } = await conversations.findSummariesByUser(
            userId,
            { kind: 'direct', agentId },
            { tenantId: TENANT, organizationId: ORG },
        );
        const ids = rows.map((row) => row.id);
        expect(ids).toContain(mine.id);
        expect(ids).not.toContain(elsewhere.id);
        expect(rows[0].id).toBe(mine.id);
        expect(rows[0].lastMessageAt).toBeInstanceOf(Date);

        await expect(
            conversations.findByIdForUser(elsewhere.id, userId, {
                tenantId: TENANT,
                organizationId: ORG,
            }),
        ).resolves.toBeNull();
    });

    it('counts unread Agent messages after the read position, never the reader’s own', async () => {
        const conversation = await openDirect(ORG);
        await participants.addIfAbsent({
            conversationId: conversation.id,
            participantType: 'user',
            participantId: userId,
            role: 'owner',
        });
        const insert = (authorType: 'user' | 'agent', content: string) =>
            conversations.insertMessage({
                conversationId: conversation.id,
                role: authorType === 'user' ? 'user' : 'assistant',
                content,
                authorType,
                authorId: authorType === 'user' ? userId : agentId,
            });

        await insert('user', 'question');
        const firstReply = await insert('agent', 'answer one');
        expect(
            (await conversations.unreadCountsFor(userId, [conversation.id])).get(conversation.id),
        ).toBe(1);

        await participants.markRead(
            conversation.id,
            'user',
            userId,
            firstReply.id,
            new Date(firstReply.createdAt.getTime() + 1),
        );
        expect(
            (await conversations.unreadCountsFor(userId, [conversation.id])).has(conversation.id),
        ).toBe(false);

        await new Promise((resolve) => setTimeout(resolve, 10));
        await insert('agent', 'answer two');
        expect(
            (await conversations.unreadCountsFor(userId, [conversation.id])).get(conversation.id),
        ).toBe(1);
    });

    it('legacy appends store model turns as system-authored and read them through for the owner', async () => {
        const legacy = await conversations.create({ userId, title: 'assistant thread' });
        const unread = async () =>
            (await conversations.unreadCountsFor(userId, [legacy.id])).get(legacy.id) ?? 0;

        // No participant row yet (the thread predates participants): nothing counts.
        await conversations.appendMessages([
            { conversationId: legacy.id, role: 'user', content: 'hi' },
            { conversationId: legacy.id, role: 'assistant', content: 'hello' },
        ]);
        const stored = await dataSource
            .getRepository(ConversationMessage)
            .find({ where: { conversationId: legacy.id }, order: { createdAt: 'ASC' } });
        expect(stored.map((row) => [row.role, row.authorType])).toEqual([
            ['user', 'user'],
            ['assistant', 'system'],
        ]);
        expect(await unread()).toBe(0);

        // The owner joins later: history from before they joined is not unread.
        await new Promise((resolve) => setTimeout(resolve, 5));
        await participants.addIfAbsent({
            conversationId: legacy.id,
            participantType: 'user',
            participantId: userId,
            role: 'owner',
        });
        expect(await unread()).toBe(0);

        // The person's own client keeps appending: the replies it persisted
        // were shown to them, so they stay read.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const appended = await conversations.appendMessages([
            { conversationId: legacy.id, role: 'user', content: 'more' },
            { conversationId: legacy.id, role: 'assistant', content: 'sure' },
        ]);
        expect(await unread()).toBe(0);
        const owner = await participants.findOne(legacy.id, 'user', userId);
        expect(owner?.lastReadMessageId).toBe(appended[1].id);

        // Something the person did not persist themselves is unread.
        await new Promise((resolve) => setTimeout(resolve, 5));
        await conversations.insertMessage({
            conversationId: legacy.id,
            role: 'assistant',
            content: 'from an Agent',
            authorType: 'agent',
            authorId: agentId,
        });
        expect(await unread()).toBe(1);
    });

    it('adds a participant once even when asked twice', async () => {
        const conversation = await openDirect(ORG);
        const input = {
            conversationId: conversation.id,
            participantType: 'agent' as const,
            participantId: agentId,
        };
        const first = await participants.addIfAbsent(input);
        const second = await participants.addIfAbsent(input);
        expect(second.id).toBe(first.id);
        await expect(participants.countActiveAgents(conversation.id)).resolves.toBe(1);
        await participants.markLeft(conversation.id, 'agent', agentId);
        await expect(participants.countActiveAgents(conversation.id)).resolves.toBe(0);
        await expect(
            participants.listForConversation(conversation.id, { includeLeft: true }),
        ).resolves.toHaveLength(1);
    });

    it('finds the live reply run for this Conversation and Agent only', async () => {
        const conversation = await openDirect(ORG);
        const other = await openDirect(ORG);
        const message = await conversations.insertMessage({
            conversationId: conversation.id,
            role: 'user',
            content: 'go',
            authorType: 'user',
            authorId: userId,
        });
        const run = await runs.createQueued({
            agentId,
            userId,
            triggerKind: 'conversation',
            conversationMessageId: message.id,
            tenantId: TENANT,
            organizationId: ORG,
        });
        expect(run.conversationMessageId).toBe(message.id);

        await expect(
            runs.findInFlightForConversationAgent(conversation.id, agentId, userId, {
                tenantId: TENANT,
                organizationId: ORG,
            }),
        ).resolves.toMatchObject({ id: run.id });
        await expect(
            runs.findInFlightForConversationAgent(other.id, agentId, userId),
        ).resolves.toBeNull();

        await runs.markFailed(run.id, 'done');
        await expect(
            runs.findInFlightForConversationAgent(conversation.id, agentId, userId),
        ).resolves.toBeNull();
    });

    it('pages messages newest-last and backwards from a message', async () => {
        const conversation = await openDirect(ORG);
        const ids: string[] = [];
        for (const content of ['one', 'two', 'three']) {
            const row = await conversations.insertMessage({
                conversationId: conversation.id,
                role: 'user',
                content,
                authorType: 'user',
                authorId: userId,
            });
            ids.push(row.id);
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const latest = await conversations.findMessagesPaged(conversation.id, 2);
        expect(latest.map((row) => row.content)).toEqual(['two', 'three']);
        const earlier = await conversations.findMessagesPaged(conversation.id, 2, ids[1]);
        expect(earlier.map((row) => row.content)).toEqual(['one']);
    });

    it('lets exactly one of two Retries claim a failed message', async () => {
        const conversation = await openDirect(ORG);
        const message = await conversations.insertMessage({
            conversationId: conversation.id,
            role: 'user',
            content: 'try again',
            authorType: 'user',
            authorId: userId,
            status: 'failed',
            failureCode: 'capacity_limited',
        });

        const claims = await Promise.all([
            conversations.claimFailedMessage(conversation.id, message.id),
            conversations.claimFailedMessage(conversation.id, message.id),
        ]);

        expect(claims.filter(Boolean)).toHaveLength(1);
        await expect(
            conversations.findMessageById(conversation.id, message.id),
        ).resolves.toMatchObject({ status: 'sent', failureCode: null });
        // A message that is no longer failed is never claimed again.
        await expect(conversations.claimFailedMessage(conversation.id, message.id)).resolves.toBe(
            false,
        );
    });

    it('leaves no Conversation behind when a participant cannot be stored', async () => {
        const refusedAgentId = '77777777-7777-4777-8777-777777777777';
        await dataSource.query(
            `CREATE TRIGGER refuse_participant BEFORE INSERT ON conversation_participants
             WHEN NEW."participantId" = '${refusedAgentId}'
             BEGIN SELECT RAISE(ABORT, 'participant insert refused'); END;`,
        );
        try {
            const service = new ConversationService(conversations, participants, {
                findByIdAndUser: async () => ({ id: refusedAgentId, status: 'active' }),
            } as any);

            await expect(
                service.create(
                    userId,
                    { agentId: refusedAgentId, title: 'Half made' },
                    { tenantId: TENANT, organizationId: ORG },
                ),
            ).rejects.toThrow(/participant insert refused/);

            const leftovers = await dataSource
                .getRepository(Conversation)
                .find({ where: { userId, agentId: refusedAgentId } });
            expect(leftovers).toHaveLength(0);
            const orphans = await dataSource.query(
                `SELECT p.id FROM conversation_participants p
                 LEFT JOIN conversations c ON c.id = p."conversationId"
                 WHERE c.id IS NULL`,
            );
            expect(orphans).toHaveLength(0);
        } finally {
            await dataSource.query('DROP TRIGGER IF EXISTS refuse_participant');
        }
    });

    it('creates a Conversation with its owner and Agent, stamped with its scope', async () => {
        const service = new ConversationService(conversations, participants, {
            findByIdAndUser: async () => ({ id: agentId, status: 'active' }),
        } as any);
        const created = await service.create(
            userId,
            { agentId },
            { tenantId: TENANT, organizationId: ORG },
        );
        const rows = await participants.listForConversation(created.id);
        expect(
            rows.map((row) => [row.participantType, row.role, row.organizationId]).sort(),
        ).toEqual([
            ['agent', 'member', ORG],
            ['user', 'owner', ORG],
        ]);
    });

    it('never moves a read position backward when an older read arrives late', async () => {
        const conversation = await openDirect(ORG);
        await participants.addIfAbsent({
            conversationId: conversation.id,
            participantType: 'user',
            participantId: userId,
            role: 'owner',
        });
        const insert = async (content: string) => {
            const row = await conversations.insertMessage({
                conversationId: conversation.id,
                role: 'assistant',
                content,
                authorType: 'agent',
                authorId: agentId,
            });
            await new Promise((resolve) => setTimeout(resolve, 5));
            return row;
        };
        const older = await insert('first');
        const newer = await insert('second');

        await expect(
            participants.markRead(conversation.id, 'user', userId, newer.id, newer.createdAt),
        ).resolves.toBe(true);
        // The delayed request for the older message lands after the newer one.
        await expect(
            participants.markRead(conversation.id, 'user', userId, older.id, older.createdAt),
        ).resolves.toBe(false);

        const owner = await participants.findOne(conversation.id, 'user', userId);
        expect(owner?.lastReadMessageId).toBe(newer.id);
        expect(
            (await conversations.unreadCountsFor(userId, [conversation.id])).has(conversation.id),
        ).toBe(false);

        // A later message still moves it forward.
        const latest = await insert('third');
        await expect(
            participants.markRead(conversation.id, 'user', userId, latest.id, latest.createdAt),
        ).resolves.toBe(true);
    });

    it('pages forward from a cursor through every message, ties and deleted anchors included', async () => {
        const conversation = await openDirect(ORG);
        const at = new Date('2026-09-10T10:00:00.000Z');
        const messages = dataSource.getRepository(ConversationMessage);
        // Seven rows, three of them sharing one timestamp.
        const stamps = [0, 1, 1, 1, 2, 3, 4].map((offset) => new Date(at.getTime() + offset));
        for (const [index, createdAt] of stamps.entries()) {
            await messages.save(
                messages.create({
                    conversationId: conversation.id,
                    role: 'user',
                    content: `m${index}`,
                    authorType: 'user',
                    authorId: userId,
                    createdAt,
                }),
            );
        }
        const expected = await messages
            .createQueryBuilder('m')
            .where('m.conversationId = :id', { id: conversation.id })
            .orderBy('m.createdAt', 'ASC')
            .addOrderBy('m.id', 'ASC')
            .getMany();
        expect(expected).toHaveLength(7);

        const walked: string[] = [];
        let cursor: { id: string; createdAt: Date } | null = null;
        for (let page = 0; page < 10; page += 1) {
            const rows = await conversations.findMessagesAfter(conversation.id, cursor, 2);
            walked.push(...rows.map((row) => row.id));
            if (rows.length < 2) break;
            const last = rows[rows.length - 1];
            cursor = { id: last.id, createdAt: last.createdAt };
        }
        expect(walked).toEqual(expected.map((row) => row.id));

        // The cursor still works once the message it points at is deleted.
        const anchor = expected[3];
        await conversations.deleteMessages(conversation.id, [anchor.id]);
        const after = await conversations.findMessagesAfter(
            conversation.id,
            { id: anchor.id, createdAt: anchor.createdAt },
            10,
        );
        expect(after.map((row) => row.id)).toEqual(expected.slice(4).map((row) => row.id));
    });

    it('orders the read position by (createdAt, id), so a tie never hides a message', async () => {
        const conversation = await openDirect(ORG);
        await participants.addIfAbsent({
            conversationId: conversation.id,
            participantType: 'user',
            participantId: userId,
            role: 'owner',
        });
        const messages = dataSource.getRepository(ConversationMessage);
        const at = new Date('2026-09-11T09:00:00.000Z');
        // Two Agent replies stored inside the same millisecond — one write
        // batch, one clock reading.
        const tied = [];
        for (const content of ['tie one', 'tie two']) {
            tied.push(
                await messages.save(
                    messages.create({
                        conversationId: conversation.id,
                        role: 'assistant',
                        content,
                        authorType: 'agent',
                        authorId: agentId,
                        createdAt: at,
                    }),
                ),
            );
        }
        const [earlier, later] = [...tied].sort((a, b) => (a.id < b.id ? -1 : 1));

        await expect(
            participants.markRead(conversation.id, 'user', userId, later.id, at),
        ).resolves.toBe(true);
        // A timestamp-only guard accepted this (`lastReadAt <= readAt`) and
        // pulled `lastReadMessageId` back to the smaller id.
        await expect(
            participants.markRead(conversation.id, 'user', userId, earlier.id, at),
        ).resolves.toBe(false);
        expect(
            (await participants.findOne(conversation.id, 'user', userId))?.lastReadMessageId,
        ).toBe(later.id);
        expect(
            (await conversations.unreadCountsFor(userId, [conversation.id])).has(conversation.id),
        ).toBe(false);

        // Read position at the EARLIER of the two: the later id shares the
        // timestamp and must still be counted unread.
        await dataSource
            .getRepository(ConversationParticipant)
            .update(
                { conversationId: conversation.id, participantType: 'user', participantId: userId },
                { lastReadMessageId: earlier.id, lastReadAt: at },
            );
        expect(
            (await conversations.unreadCountsFor(userId, [conversation.id])).get(conversation.id),
        ).toBe(1);
    });

    it('refuses an automatic title once the person has named the Conversation', async () => {
        const conversation = await openDirect(ORG);
        expect(await conversations.setName(conversation.id, userId, 'Quarterly plan')).toBe(true);

        // The automatic title was generated from a read taken before the
        // rename; the conditional write must drop it.
        await expect(
            conversations.updateTitle(
                conversation.id,
                userId,
                'Some model summary',
                { aiTitle: true },
                { onlyWhenNotUserTitled: true },
            ),
        ).resolves.toBe(false);
        expect(
            (await dataSource.getRepository(Conversation).findOneByOrFail({ id: conversation.id }))
                .title,
        ).toBe('Quarterly plan');

        // Clearing the name releases it again.
        expect(await conversations.setName(conversation.id, userId, null)).toBe(true);
        await expect(
            conversations.updateTitle(
                conversation.id,
                userId,
                'Some model summary',
                { aiTitle: true },
                { onlyWhenNotUserTitled: true },
            ),
        ).resolves.toBe(true);
        const titled = await dataSource
            .getRepository(Conversation)
            .findOneByOrFail({ id: conversation.id });
        expect(titled.title).toBe('Some model summary');
        expect(titled.metadata).toMatchObject({ aiTitle: true });
    });

    it('reads messages that can still change status by id, past the newest window', async () => {
        const conversation = await openDirect(ORG);
        const waiting = await conversations.insertMessage({
            conversationId: conversation.id,
            role: 'user',
            content: 'waiting for a reply',
            authorType: 'user',
            authorId: userId,
            status: 'sending',
        });
        for (let i = 0; i < 3; i += 1) {
            await conversations.insertMessage({
                conversationId: conversation.id,
                role: 'assistant',
                content: `noise ${i}`,
                authorType: 'agent',
                authorId: agentId,
            });
        }

        // By status: nothing watched yet, and the waiting message is still
        // found however much newer traffic sits on top of it.
        await expect(
            conversations.findUnsettledMessages(conversation.id, ['sending', 'failed'], [], 50),
        ).resolves.toMatchObject([{ id: waiting.id, status: 'sending' }]);

        // By id: once it settles it leaves the status set, and only the
        // watched id still finds it — which is how the stream learns it moved.
        await conversations.updateMessageStatus(waiting.id, 'sent');
        await expect(
            conversations.findUnsettledMessages(conversation.id, ['sending', 'failed'], [], 50),
        ).resolves.toEqual([]);
        await expect(
            conversations.findUnsettledMessages(
                conversation.id,
                ['sending', 'failed'],
                [waiting.id],
                50,
            ),
        ).resolves.toMatchObject([{ id: waiting.id, status: 'sent' }]);
        // No status and no watched id is not "everything".
        await expect(
            conversations.findUnsettledMessages(conversation.id, [], [], 50),
        ).resolves.toEqual([]);
    });

    it('stores one reply per Agent run, however many times the run is finalized', async () => {
        const conversation = await openDirect(ORG);
        const question = await conversations.insertMessage({
            conversationId: conversation.id,
            role: 'user',
            content: 'plan?',
            authorType: 'user',
            authorId: userId,
        });
        const service = new ConversationMessageService(
            conversations,
            {} as any,
            {} as any,
            {} as any,
        );
        const input = {
            runId: '88888888-8888-4888-8888-888888888888',
            userId,
            agentId,
            replyToMessageId: question.id,
            body: 'Here is the plan.',
        };

        const replies = await Promise.all([
            service.recordAgentReply(input),
            service.recordAgentReply(input),
        ]);
        const again = await service.recordAgentReply(input);

        expect(new Set([...replies, again].map((row) => row.id)).size).toBe(1);
        const stored = await dataSource.getRepository(ConversationMessage).find({
            where: {
                conversationId: conversation.id,
                clientMessageId: agentReplyClientMessageId(input.runId),
            },
        });
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({
            authorType: 'agent',
            authorId: agentId,
            replyToMessageId: question.id,
        });
    });
});
