import { DataSource } from 'typeorm';
import { AddConversationKindAndParticipants1791120000000 } from '../1791120000000-AddConversationKindAndParticipants';

/**
 * Migration test for named Conversations with Agents, phase 1.
 *
 * Same in-memory better-sqlite3 harness as the sibling migration specs.
 * What matters:
 *
 *  - every existing Conversation reads as the assistant thread it was —
 *    `direct`, no Agent — and every existing message as a sent one, written
 *    by the person for a `user` turn and by `system` for a model turn;
 *  - every existing Conversation gets exactly one `owner` participant, scoped
 *    like the Conversation, and a re-run adds no second one;
 *  - that owner has already read the existing history, so nothing is unread
 *    after deploy;
 *  - `lastMessageAt` and the model-title marker are backfilled;
 *  - a client message id is stored at most once per Conversation, while legacy
 *    rows with no client id never collide;
 *  - `down()` removes exactly what `up()` added and keeps every row.
 */
describe('AddConversationKindAndParticipants1791120000000', () => {
    let dataSource: DataSource;
    const migration = new AddConversationKindAndParticipants1791120000000();

    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        await migration[direction](runner);
        await runner.release();
    };

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(`CREATE TABLE "agents" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`
            CREATE TABLE "conversations" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "title" varchar(200),
                "metadata" text,
                "tenantId" varchar,
                "organizationId" varchar,
                "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
                "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
            )
        `);
        await dataSource.query(`
            CREATE TABLE "conversation_messages" (
                "id" varchar PRIMARY KEY NOT NULL,
                "conversationId" varchar NOT NULL,
                "role" varchar(20) NOT NULL,
                "content" text NOT NULL,
                "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
            )
        `);
        await dataSource.query(`
            CREATE TABLE "agent_runs" (
                "id" varchar PRIMARY KEY NOT NULL,
                "agentId" varchar NOT NULL,
                "triggerKind" varchar(16) NOT NULL
            )
        `);
        await dataSource.query(
            `INSERT INTO "conversations" ("id", "userId", "title", "metadata", "tenantId", "organizationId", "createdAt")
             VALUES ('c1', 'u1', 'Model title', '{"aiTitle":true}', 't1', 'o1', '2026-01-01 10:00:00'),
                    ('c2', 'u1', 'First message', NULL, NULL, NULL, '2026-01-02 10:00:00'),
                    ('c3', 'u2', NULL, NULL, NULL, NULL, '2026-01-03 10:00:00')`,
        );
        await dataSource.query(
            `INSERT INTO "conversation_messages" ("id", "conversationId", "role", "content", "createdAt")
             VALUES ('m1', 'c1', 'user', 'hi', '2026-01-01 10:01:00'),
                    ('m2', 'c1', 'assistant', 'hello', '2026-01-01 10:05:00'),
                    ('m3', 'c2', 'user', 'plan', '2026-01-02 11:00:00')`,
        );
        await dataSource.query(
            `INSERT INTO "agent_runs" ("id", "agentId", "triggerKind") VALUES ('r1', 'a1', 'chat')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('reads every existing Conversation as a direct thread with no Agent', async () => {
        await run('up');

        const rows = await dataSource.query(
            `SELECT "id", "kind", "agentId", "contextType", "contextId", "title" FROM "conversations" ORDER BY "id"`,
        );
        expect(rows.map((row: { kind: string }) => row.kind)).toEqual([
            'direct',
            'direct',
            'direct',
        ]);
        expect(rows.every((row: { agentId: string | null }) => row.agentId === null)).toBe(true);
        expect(rows[0].title).toBe('Model title');
    });

    it('reads every existing message as a sent one, written by the person or, for a model turn, by the system', async () => {
        await run('up');

        const rows = await dataSource.query(
            `SELECT "id", "authorType", "authorId", "status", "clientMessageId", "mentions"
             FROM "conversation_messages" ORDER BY "id"`,
        );
        expect(rows).toHaveLength(3);
        for (const row of rows) {
            expect(row).toMatchObject({
                authorId: null,
                status: 'sent',
                clientMessageId: null,
                mentions: null,
            });
        }
        // m2 is the assistant's reply: never recorded as written by the person.
        expect(
            rows.map((row: { id: string; authorType: string }) => [row.id, row.authorType]),
        ).toEqual([
            ['m1', 'user'],
            ['m2', 'system'],
            ['m3', 'user'],
        ]);
        const [runRow] = await dataSource.query(
            `SELECT "conversationMessageId", "triggerKind" FROM "agent_runs"`,
        );
        expect(runRow).toEqual({ conversationMessageId: null, triggerKind: 'chat' });
    });

    it('gives every Conversation exactly one scoped owner, and a re-run adds none', async () => {
        await run('up');
        await run('up');

        const rows = await dataSource.query(
            `SELECT "conversationId", "participantType", "participantId", "role", "tenantId", "organizationId", "leftAt"
             FROM "conversation_participants" ORDER BY "conversationId"`,
        );
        expect(rows).toEqual([
            {
                conversationId: 'c1',
                participantType: 'user',
                participantId: 'u1',
                role: 'owner',
                tenantId: 't1',
                organizationId: 'o1',
                leftAt: null,
            },
            {
                conversationId: 'c2',
                participantType: 'user',
                participantId: 'u1',
                role: 'owner',
                tenantId: null,
                organizationId: null,
                leftAt: null,
            },
            {
                conversationId: 'c3',
                participantType: 'user',
                participantId: 'u2',
                role: 'owner',
                tenantId: null,
                organizationId: null,
                leftAt: null,
            },
        ]);
    });

    it('records every model turn as system-authored and leaves a re-run and later authored rows alone', async () => {
        await dataSource.query(
            `INSERT INTO "conversation_messages" ("id", "conversationId", "role", "content", "createdAt")
             VALUES ('m4', 'c2', 'system', 'be brief', '2026-01-02 10:59:00'),
                    ('m5', 'c2', 'tool', '{"ok":true}', '2026-01-02 10:59:30')`,
        );
        await run('up');
        // A message written after deploy with its own author keeps it.
        await dataSource.query(
            `INSERT INTO "conversation_messages" ("id", "conversationId", "role", "content", "authorType", "authorId")
             VALUES ('n1', 'c2', 'assistant', 'agent reply', 'agent', 'a1')`,
        );
        await run('up');

        const rows = await dataSource.query(
            `SELECT "id", "authorType" FROM "conversation_messages" ORDER BY "id"`,
        );
        expect(
            rows.map((row: { id: string; authorType: string }) => [row.id, row.authorType]),
        ).toEqual([
            ['m1', 'user'],
            ['m2', 'system'],
            ['m3', 'user'],
            ['m4', 'system'],
            ['m5', 'system'],
            ['n1', 'agent'],
        ]);
    });

    it('marks existing history read for each owner, so nothing is unread after deploy', async () => {
        await run('up');

        const owners = await dataSource.query(
            `SELECT "conversationId", "lastReadMessageId", "lastReadAt" FROM "conversation_participants"
             ORDER BY "conversationId"`,
        );
        expect(
            owners.map((row: { conversationId: string; lastReadMessageId: string | null }) => [
                row.conversationId,
                row.lastReadMessageId,
            ]),
        ).toEqual([
            ['c1', 'm2'],
            ['c2', 'm3'],
            ['c3', null],
        ]);
        expect(String(owners[0].lastReadAt)).toContain('2026-01-01 10:05:00');
        expect(owners[2].lastReadAt).toBeNull();

        // The unread rule, in SQL: system/Agent messages after the owner's
        // read position. Legacy history — including the assistant reply m2 —
        // counts nothing.
        const unread = `
            SELECT COUNT(m."id") AS "count" FROM "conversation_messages" m
            JOIN "conversation_participants" p
              ON p."conversationId" = m."conversationId" AND p."role" = 'owner'
            WHERE m."authorType" IN ('agent', 'system')
              AND ((p."lastReadAt" IS NOT NULL AND m."createdAt" > p."lastReadAt")
                OR (p."lastReadAt" IS NULL AND m."createdAt" >= p."joinedAt"))`;
        const [{ count: before }] = await dataSource.query(unread);
        expect(Number(before)).toBe(0);

        // A reply written after deploy is the first thing that is unread.
        await dataSource.query(
            `INSERT INTO "conversation_messages" ("id", "conversationId", "role", "content", "authorType", "authorId", "createdAt")
             VALUES ('n1', 'c1', 'assistant', 'new', 'agent', 'a1', '2026-02-01 09:00:00')`,
        );
        const [{ count: after }] = await dataSource.query(unread);
        expect(Number(after)).toBe(1);
    });

    it('backfills last activity and marks only model titles as automatic', async () => {
        await run('up');

        const rows = await dataSource.query(
            `SELECT "id", "lastMessageAt", "titleSource" FROM "conversations" ORDER BY "id"`,
        );
        expect(String(rows[0].lastMessageAt)).toContain('2026-01-01 10:05:00');
        expect(String(rows[1].lastMessageAt)).toContain('2026-01-02 11:00:00');
        expect(rows[2].lastMessageAt).toBeNull();
        expect(rows.map((row: { titleSource: string | null }) => row.titleSource)).toEqual([
            'auto',
            null,
            null,
        ]);
    });

    it('refuses a second participant row for the same Agent in one Conversation', async () => {
        await run('up');
        const insert = (id: string) =>
            dataSource.query(
                `INSERT INTO "conversation_participants" ("id", "conversationId", "participantType", "participantId", "role", "joinedAt")
                 VALUES ('${id}', 'c1', 'agent', 'a1', 'member', '2026-01-04 00:00:00')`,
            );
        await insert('p1');
        await expect(insert('p2')).rejects.toThrow();
    });

    it('stores a client message id once per Conversation, and never collides on legacy rows', async () => {
        await run('up');
        const insert = (id: string, conversationId: string, clientId: string | null) =>
            dataSource.query(
                `INSERT INTO "conversation_messages" ("id", "conversationId", "role", "content", "clientMessageId")
                 VALUES ('${id}', '${conversationId}', 'user', 'x', ${clientId === null ? 'NULL' : `'${clientId}'`})`,
            );
        await insert('n1', 'c1', 'client-1');
        await expect(insert('n2', 'c1', 'client-1')).rejects.toThrow();
        // The same client id in another Conversation is a different message.
        await expect(insert('n3', 'c2', 'client-1')).resolves.toBeDefined();
        // Legacy-shaped rows without a client id never collide.
        await expect(insert('n4', 'c1', null)).resolves.toBeDefined();
        await expect(insert('n5', 'c1', null)).resolves.toBeDefined();
    });

    it('creates every index it names', async () => {
        await run('up');
        const runner = dataSource.createQueryRunner();
        const conversations = await runner.getTable('conversations');
        const messages = await runner.getTable('conversation_messages');
        const runs = await runner.getTable('agent_runs');
        const participants = await runner.getTable('conversation_participants');
        await runner.release();

        const names = (table?: { indices: { name?: string }[] }) =>
            (table?.indices ?? []).map((index) => index.name).sort();
        expect(names(conversations)).toEqual(
            expect.arrayContaining([
                'idx_conversations_agent_activity',
                'idx_conversations_user_kind_activity',
            ]),
        );
        expect(names(messages)).toEqual(
            expect.arrayContaining([
                'idx_conversation_messages_status',
                'uq_conversation_messages_client_id',
            ]),
        );
        expect(names(runs)).toEqual(
            expect.arrayContaining(['idx_agent_runs_conversation_message']),
        );
        expect(names(participants)).toEqual([
            'idx_conversation_participants_target',
            'uq_conversation_participants',
        ]);
    });

    it('down() removes exactly what up() added and keeps every row', async () => {
        await run('up');
        await run('down');

        const runner = dataSource.createQueryRunner();
        expect(await runner.hasTable('conversation_participants')).toBe(false);
        const conversations = await runner.getTable('conversations');
        const messages = await runner.getTable('conversation_messages');
        const runs = await runner.getTable('agent_runs');
        await runner.release();

        expect(conversations?.columns.map((column) => column.name).sort()).toEqual([
            'createdAt',
            'id',
            'metadata',
            'organizationId',
            'tenantId',
            'title',
            'updatedAt',
            'userId',
        ]);
        expect(messages?.columns.map((column) => column.name).sort()).toEqual([
            'content',
            'conversationId',
            'createdAt',
            'id',
            'role',
        ]);
        expect(runs?.columns.map((column) => column.name).sort()).toEqual([
            'agentId',
            'id',
            'triggerKind',
        ]);
        const [{ count }] = await dataSource.query(
            `SELECT COUNT(*) AS "count" FROM "conversation_messages"`,
        );
        expect(Number(count)).toBe(3);
    });
});
