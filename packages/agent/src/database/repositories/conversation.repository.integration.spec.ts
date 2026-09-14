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

    it('previews each Conversation by the first message a person wrote, shortened', async () => {
        const first = await openDirect(ORG);
        const empty = await openDirect(ORG);
        await conversations.insertMessage({
            conversationId: first.id,
            role: 'assistant',
            content: 'An Agent spoke first',
            authorType: 'agent',
            authorId: agentId,
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        await conversations.insertMessage({
            conversationId: first.id,
            role: 'user',
            content: `Can you check   the pricing page?
${'x'.repeat(400)}`,
            authorType: 'user',
            authorId: userId,
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        await conversations.insertMessage({
            conversationId: first.id,
            role: 'user',
            content: 'A later question',
            authorType: 'user',
            authorId: userId,
        });

        const previews = await conversations.firstMessagePreviews([first.id, empty.id]);

        expect(previews.has(empty.id)).toBe(false);
        const preview = previews.get(first.id) ?? '';
        expect(preview.startsWith('Can you check the pricing page? x')).toBe(true);
        expect(preview.length).toBeLessThanOrEqual(160);
        expect(await conversations.firstMessagePreviews([])).toEqual(new Map());
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
});
