import { randomUUID } from 'crypto';
import {
    MigrationInterface,
    QueryRunner,
    Table,
    TableColumn,
    TableForeignKey,
    TableIndex,
} from 'typeorm';

/**
 * Named Conversations with Agents, phase 1 — Conversation kind, the addressed
 * Agent, a person-owned name, per-message author and send status, and the
 * `conversation_participants` table.
 *
 * Entities:
 *   `packages/agent/src/entities/conversation.entity.ts`
 *   `packages/agent/src/entities/conversation-message.entity.ts`
 *   `packages/agent/src/entities/conversation-participant.entity.ts`
 *   `packages/agent/src/entities/agent-run.entity.ts` (`conversationMessageId`)
 *
 * ## `conversations` — six columns
 *
 * `kind` defaults to `'direct'` and every other column lands NULL, so each
 * existing Conversation reads as the assistant thread it always was: direct,
 * no Agent, no context, no recorded name source. `agentId` → `agents` is
 * SET NULL: deleting an Agent never deletes a Conversation it was in.
 *
 * ## `conversation_messages` — eight columns
 *
 * `status` defaults to `'sent'`, which is what every stored message was.
 * `authorType` defaults to `'user'`; the backfill below then records every
 * turn the model wrote (any `role` but `'user'`) as `'system'`-authored, so an
 * old assistant reply is never shown as written by the person. There is no
 * Agent id to name for those rows, which is what `'system'` means here.
 * `uq_conversation_messages_client_id` is partial
 * (`clientMessageId IS NOT NULL`), so legacy rows without a client id never
 * collide, while a retried send with the same id is refused by the database.
 *
 * ## `agent_runs.conversationMessageId`
 *
 * The reply run behind a Conversation message. SET NULL on message delete so
 * the run and its cost survive the Conversation being deleted.
 *
 * ## `conversation_participants`
 *
 * One row per (Conversation, participant type, participant id), UNIQUE — the
 * constraint concurrent group creation relies on. CASCADE from
 * `conversations`: a deleted Conversation takes its participants with it.
 *
 * ## Backfill
 *
 *  - `authorType = 'system'` for every model-written message (see above);
 *  - one `owner` participant per existing Conversation, from its `userId`,
 *    stamped with the Conversation's scope, whose read position is the
 *    newest message — history that existed before this migration never
 *    shows as unread after deploy;
 *  - `lastMessageAt` = the newest message time;
 *  - `titleSource = 'auto'` where the stored metadata records a model title.
 *
 * Forward-only + idempotent (`hasTable` / `findColumnByName` / name guards,
 * and the owner backfill skips Conversations that already have one). Portable
 * `Table` / `TableColumn` DDL and query-builder SQL, because production runs
 * Postgres while CI runs better-sqlite3. `down()` removes exactly what `up()`
 * added, in reverse.
 */
export class AddConversationKindAndParticipants1791120000000 implements MigrationInterface {
    name = 'AddConversationKindAndParticipants1791120000000';

    private static readonly BACKFILL_BATCH = 500;

    private static readonly CONVERSATION_COLUMNS = [
        new TableColumn({ name: 'kind', type: 'varchar', length: '24', default: "'direct'" }),
        new TableColumn({ name: 'agentId', type: 'uuid', isNullable: true }),
        new TableColumn({ name: 'titleSource', type: 'varchar', length: '8', isNullable: true }),
        new TableColumn({ name: 'contextType', type: 'varchar', length: '16', isNullable: true }),
        new TableColumn({ name: 'contextId', type: 'uuid', isNullable: true }),
        new TableColumn({ name: 'lastMessageAt', type: 'timestamp', isNullable: true }),
    ];

    private static readonly MESSAGE_COLUMNS = [
        new TableColumn({ name: 'authorType', type: 'varchar', length: '8', default: "'user'" }),
        new TableColumn({ name: 'authorId', type: 'uuid', isNullable: true }),
        new TableColumn({ name: 'mentions', type: 'text', isNullable: true }),
        new TableColumn({ name: 'attachments', type: 'text', isNullable: true }),
        new TableColumn({ name: 'status', type: 'varchar', length: '8', default: "'sent'" }),
        new TableColumn({ name: 'failureCode', type: 'varchar', length: '40', isNullable: true }),
        new TableColumn({
            name: 'clientMessageId',
            type: 'varchar',
            length: '64',
            isNullable: true,
        }),
        new TableColumn({ name: 'replyToMessageId', type: 'uuid', isNullable: true }),
    ];

    private static readonly RUN_COLUMN = new TableColumn({
        name: 'conversationMessageId',
        type: 'uuid',
        isNullable: true,
    });

    private static readonly CONVERSATION_INDEXES = [
        new TableIndex({
            name: 'idx_conversations_user_kind_activity',
            columnNames: ['userId', 'kind', 'lastMessageAt'],
        }),
        new TableIndex({
            name: 'idx_conversations_agent_activity',
            columnNames: ['agentId', 'lastMessageAt'],
        }),
    ];

    private static readonly MESSAGE_INDEXES = [
        new TableIndex({
            name: 'idx_conversation_messages_status',
            columnNames: ['conversationId', 'status'],
        }),
        new TableIndex({
            name: 'uq_conversation_messages_client_id',
            columnNames: ['conversationId', 'clientMessageId'],
            isUnique: true,
            where: '"clientMessageId" IS NOT NULL',
        }),
    ];

    private static readonly RUN_INDEXES = [
        new TableIndex({
            name: 'idx_agent_runs_conversation_message',
            columnNames: ['conversationMessageId'],
        }),
    ];

    private static readonly PARTICIPANT_INDEXES = [
        new TableIndex({
            name: 'uq_conversation_participants',
            columnNames: ['conversationId', 'participantType', 'participantId'],
            isUnique: true,
        }),
        new TableIndex({
            name: 'idx_conversation_participants_target',
            columnNames: ['participantType', 'participantId', 'conversationId'],
        }),
    ];

    private static readonly CONVERSATION_FK = new TableForeignKey({
        name: 'fk_conversations_agent',
        columnNames: ['agentId'],
        referencedTableName: 'agents',
        referencedColumnNames: ['id'],
        onDelete: 'SET NULL',
    });

    private static readonly RUN_FK = new TableForeignKey({
        name: 'fk_agent_runs_conversation_message',
        columnNames: ['conversationMessageId'],
        referencedTableName: 'conversation_messages',
        referencedColumnNames: ['id'],
        onDelete: 'SET NULL',
    });

    private static readonly PARTICIPANT_FK = new TableForeignKey({
        name: 'fk_conversation_participants_conversation',
        columnNames: ['conversationId'],
        referencedTableName: 'conversations',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
    });

    public async up(queryRunner: QueryRunner): Promise<void> {
        const M = AddConversationKindAndParticipants1791120000000;

        await this.ensureColumns(queryRunner, 'conversations', M.CONVERSATION_COLUMNS);
        await this.ensureColumns(queryRunner, 'conversation_messages', M.MESSAGE_COLUMNS);
        await this.ensureColumns(queryRunner, 'agent_runs', [M.RUN_COLUMN]);

        const isPostgres = queryRunner.connection.options.type === 'postgres';
        if (!(await queryRunner.hasTable('conversation_participants'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'conversation_participants',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: isPostgres ? 'uuid_generate_v4()' : undefined,
                        },
                        { name: 'conversationId', type: 'uuid' },
                        { name: 'participantType', type: 'varchar', length: '8' },
                        { name: 'participantId', type: 'uuid' },
                        { name: 'role', type: 'varchar', length: '12', default: "'member'" },
                        { name: 'joinedAt', type: 'timestamp' },
                        { name: 'leftAt', type: 'timestamp', isNullable: true },
                        { name: 'lastReadMessageId', type: 'uuid', isNullable: true },
                        { name: 'lastReadAt', type: 'timestamp', isNullable: true },
                        { name: 'mutedAt', type: 'timestamp', isNullable: true },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }

        await this.ensureIndexes(queryRunner, 'conversations', M.CONVERSATION_INDEXES);
        await this.ensureIndexes(queryRunner, 'conversation_messages', M.MESSAGE_INDEXES);
        await this.ensureIndexes(queryRunner, 'agent_runs', M.RUN_INDEXES);
        await this.ensureIndexes(queryRunner, 'conversation_participants', M.PARTICIPANT_INDEXES);

        if (await queryRunner.hasTable('agents')) {
            await this.ensureForeignKey(queryRunner, 'conversations', M.CONVERSATION_FK);
        }
        await this.ensureForeignKey(queryRunner, 'agent_runs', M.RUN_FK);
        await this.ensureForeignKey(queryRunner, 'conversation_participants', M.PARTICIPANT_FK);

        await this.backfillAuthorTypes(queryRunner);
        await this.backfillOwners(queryRunner);
        await this.backfillLastMessageAt(queryRunner);
        await this.backfillTitleSource(queryRunner);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const M = AddConversationKindAndParticipants1791120000000;

        if (await queryRunner.hasTable('conversation_participants')) {
            await queryRunner.dropTable('conversation_participants', true, true, true);
        }

        await this.dropForeignKey(queryRunner, 'agent_runs', M.RUN_FK.name!);
        await this.dropForeignKey(queryRunner, 'conversations', M.CONVERSATION_FK.name!);

        await this.dropIndexes(queryRunner, 'agent_runs', M.RUN_INDEXES);
        await this.dropIndexes(queryRunner, 'conversation_messages', M.MESSAGE_INDEXES);
        await this.dropIndexes(queryRunner, 'conversations', M.CONVERSATION_INDEXES);

        await this.dropColumns(queryRunner, 'agent_runs', [M.RUN_COLUMN]);
        await this.dropColumns(queryRunner, 'conversation_messages', M.MESSAGE_COLUMNS);
        await this.dropColumns(queryRunner, 'conversations', M.CONVERSATION_COLUMNS);
    }

    /**
     * A legacy row has no author. The person wrote the `user` turns; every
     * other turn came from the model. Only rows still carrying the column
     * default are touched, so a re-run changes nothing.
     */
    private async backfillAuthorTypes(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `UPDATE conversation_messages SET "authorType" = 'system'
             WHERE "role" <> 'user' AND "authorType" = 'user' AND "authorId" IS NULL`,
        );
    }

    /**
     * One `owner` row per Conversation that has none yet, in batches so a
     * large history never becomes one giant statement. Re-running finds no
     * candidates, which is what makes the backfill idempotent.
     *
     * Each inserted owner has already read the Conversation's history: its
     * read position is set to the newest message. The value is copied inside
     * the database, not round-tripped through a JS `Date`, which would drop
     * sub-millisecond precision on Postgres and leave the newest message
     * unread.
     */
    private async backfillOwners(queryRunner: QueryRunner): Promise<void> {
        const batch = AddConversationKindAndParticipants1791120000000.BACKFILL_BATCH;
        for (;;) {
            const rows = await queryRunner.manager
                .createQueryBuilder()
                .select('c.id', 'id')
                .addSelect('c.userId', 'userId')
                .addSelect('c.tenantId', 'tenantId')
                .addSelect('c.organizationId', 'organizationId')
                .addSelect('c.createdAt', 'createdAt')
                .from('conversations', 'c')
                .where(
                    'NOT EXISTS (SELECT 1 FROM conversation_participants p WHERE p."conversationId" = c.id)',
                )
                .orderBy('c.createdAt', 'ASC')
                .limit(batch)
                .getRawMany<{
                    id: string;
                    userId: string;
                    tenantId: string | null;
                    organizationId: string | null;
                    createdAt: Date | string;
                }>();
            if (rows.length === 0) return;

            const now = new Date();
            const owners = rows.map((row) => ({
                id: randomUUID(),
                conversationId: row.id,
                participantType: 'user',
                participantId: row.userId,
                role: 'owner',
                joinedAt: row.createdAt ? new Date(row.createdAt) : now,
                tenantId: row.tenantId ?? null,
                organizationId: row.organizationId ?? null,
                createdAt: now,
                updatedAt: now,
            }));
            await queryRunner.manager
                .createQueryBuilder()
                .insert()
                .into('conversation_participants', [
                    'id',
                    'conversationId',
                    'participantType',
                    'participantId',
                    'role',
                    'joinedAt',
                    'tenantId',
                    'organizationId',
                    'createdAt',
                    'updatedAt',
                ])
                .values(owners)
                .execute();

            await queryRunner.manager
                .createQueryBuilder()
                .update('conversation_participants')
                .set({
                    lastReadAt: () =>
                        `(SELECT MAX(m."createdAt") FROM conversation_messages m
                          WHERE m."conversationId" = conversation_participants."conversationId")`,
                    lastReadMessageId: () =>
                        `(SELECT m.id FROM conversation_messages m
                          WHERE m."conversationId" = conversation_participants."conversationId"
                          ORDER BY m."createdAt" DESC, m.id DESC LIMIT 1)`,
                })
                .where('"id" IN (:...ownerIds)', { ownerIds: owners.map((owner) => owner.id) })
                .execute();

            if (rows.length < batch) return;
        }
    }

    private async backfillLastMessageAt(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `UPDATE conversations SET "lastMessageAt" = (
                SELECT MAX(m."createdAt") FROM conversation_messages m
                WHERE m."conversationId" = conversations.id
            ) WHERE "lastMessageAt" IS NULL`,
        );
    }

    /**
     * `metadata` is `simple-json` (text on both drivers); the title service
     * writes `{"aiTitle":true}`. A text match keeps this portable.
     */
    private async backfillTitleSource(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `UPDATE conversations SET "titleSource" = 'auto'
             WHERE "titleSource" IS NULL AND "title" IS NOT NULL
               AND "metadata" LIKE '%"aiTitle":true%'`,
        );
    }

    private async ensureColumns(
        queryRunner: QueryRunner,
        tableName: string,
        columns: readonly TableColumn[],
    ): Promise<void> {
        for (const column of columns) {
            const table = await queryRunner.getTable(tableName);
            if (table && !table.findColumnByName(column.name)) {
                await queryRunner.addColumn(tableName, column);
            }
        }
    }

    private async dropColumns(
        queryRunner: QueryRunner,
        tableName: string,
        columns: readonly TableColumn[],
    ): Promise<void> {
        // `dropColumn` (not raw SQL) and a fresh `getTable` per drop: the
        // query runner rebuilds the table on drivers that cannot drop a
        // column in place, and each rebuild replaces the Table object.
        for (const column of [...columns].reverse()) {
            const table = await queryRunner.getTable(tableName);
            const existing = table?.findColumnByName(column.name);
            if (existing) {
                await queryRunner.dropColumn(tableName, existing);
            }
        }
    }

    private async ensureIndexes(
        queryRunner: QueryRunner,
        tableName: string,
        indexes: readonly TableIndex[],
    ): Promise<void> {
        for (const index of indexes) {
            const table = await queryRunner.getTable(tableName);
            if (table && !table.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.createIndex(tableName, index);
            }
        }
    }

    private async dropIndexes(
        queryRunner: QueryRunner,
        tableName: string,
        indexes: readonly TableIndex[],
    ): Promise<void> {
        for (const index of [...indexes].reverse()) {
            const table = await queryRunner.getTable(tableName);
            const existing = table?.indices.find((candidate) => candidate.name === index.name);
            if (existing) {
                await queryRunner.dropIndex(tableName, existing);
            }
        }
    }

    private async ensureForeignKey(
        queryRunner: QueryRunner,
        tableName: string,
        foreignKey: TableForeignKey,
    ): Promise<void> {
        const table = await queryRunner.getTable(tableName);
        if (table && !table.foreignKeys.some((existing) => existing.name === foreignKey.name)) {
            await queryRunner.createForeignKey(tableName, foreignKey);
        }
    }

    private async dropForeignKey(
        queryRunner: QueryRunner,
        tableName: string,
        name: string,
    ): Promise<void> {
        const table = await queryRunner.getTable(tableName);
        const existing = table?.foreignKeys.find((candidate) => candidate.name === name);
        if (existing) {
            await queryRunner.dropForeignKey(tableName, existing);
        }
    }
}
