import {
    MigrationInterface,
    QueryRunner,
    Table,
    TableColumn,
    TableForeignKey,
    TableIndex,
} from 'typeorm';

/**
 * Agent email (AW-05, P1) — the schema behind approve-before-send and the
 * send ceilings.
 *
 * Entities:
 *   `packages/agent/src/entities/agent-inbox.entity.ts`
 *   `packages/agent/src/entities/email-message.entity.ts` (lifecycle columns)
 *   `packages/agent/src/entities/organization.entity.ts` (`emailSendPolicy`)
 *
 * ## `agent_inboxes` — one Agent's mail policy
 *
 * Whether what the Agent writes waits for a person (`mode`) and the
 * per-inbox ceilings. Not a column group on `agents` (every Agent would
 * carry eight nullable mail columns it never uses) and not on
 * `agent_email_assignments` (one row per direction and one address may be
 * assigned to several Agents — the policy is about the Agent, exactly once,
 * hence `uq_agent_inboxes_agent`).
 *
 * Absence of a row is meaningful: the Agent keeps sending exactly as it did
 * before this table existed, bounded only by ceilings someone explicitly
 * configured (operator env, organization policy) — with none, unbounded. A
 * created row defaults to `draft-review` and turns the Agent's per-Agent
 * limits on.
 *
 * Each `*Cap` column: NULL = inherit (organization, then the operator's
 * platform value, then the recommended number), `0` = explicitly no ceiling,
 * positive = that ceiling. Counts are never stored — they are read from
 * `email_messages` at send time. No policy is written here: every existing
 * deployment starts with no inbox rows and no organization policy, so no
 * ceiling is enforced until someone configures one.
 *
 * FKs: `userId` / `agentId` CASCADE (the policy has no meaning without
 * either); `emailAddressId` SET NULL (deleting a pinned address falls back
 * to the Agent's outbound assignment, it does not delete the policy).
 *
 * ## `email_messages` lifecycle columns
 *
 * `status` is where a message is in its life. Before this migration an
 * outbound row was only ever written after a provider accepted it, so every
 * existing row is backfilled `sent` (outbound) or `received` (inbound) —
 * the true history. A held draft is `draft` with no `sentAt`, so it never
 * spends capacity. `approvalId` / `approvedById` / `approvedAt` record the
 * person who released it; `failureReason` why a send did not go out.
 * Deliberately no FKs on the approval columns: they are audit, and must
 * outlive the proposal row they point at.
 *
 * The two indices serve the send-ceiling windows, read on every send:
 * "how much has this Agent / this account sent since T?".
 *
 * ## `organizations.email_send_policy`
 *
 * `simple-json` (`text`), NULL on every existing row = inherit the platform
 * defaults, the same shape as `digest_settings` next door.
 *
 * Forward-only, idempotent (existence guards everywhere) and portable
 * `Table` / `TableColumn` DDL, because production runs Postgres while CI
 * runs better-sqlite3. The backfill is batched and guarded on `IS NULL`, so
 * a re-run after a partial failure picks up where it stopped.
 */
export class AddAgentEmailSendPolicy1791050000000 implements MigrationInterface {
    name = 'AddAgentEmailSendPolicy1791050000000';

    private static readonly BACKFILL_BATCH = 5_000;

    private static readonly MESSAGE_COLUMNS = [
        new TableColumn({ name: 'status', type: 'varchar', length: '16', isNullable: true }),
        new TableColumn({ name: 'approvalId', type: 'uuid', isNullable: true }),
        new TableColumn({ name: 'approvedById', type: 'uuid', isNullable: true }),
        new TableColumn({ name: 'approvedAt', type: 'timestamp', isNullable: true }),
        new TableColumn({
            name: 'failureReason',
            type: 'varchar',
            length: '500',
            isNullable: true,
        }),
    ];

    private static readonly MESSAGE_INDICES = [
        new TableIndex({
            name: 'idx_email_messages_agent_direction_sent',
            columnNames: ['agentId', 'direction', 'sentAt'],
        }),
        new TableIndex({
            name: 'idx_email_messages_user_direction_sent',
            columnNames: ['userId', 'direction', 'sentAt'],
        }),
    ];

    private static readonly ORGANIZATION_COLUMN = new TableColumn({
        name: 'email_send_policy',
        type: 'text',
        isNullable: true,
    });

    public async up(queryRunner: QueryRunner): Promise<void> {
        await this.createAgentInboxes(queryRunner);

        const messages = await queryRunner.getTable('email_messages');
        if (messages) {
            for (const column of AddAgentEmailSendPolicy1791050000000.MESSAGE_COLUMNS) {
                if (!messages.findColumnByName(column.name)) {
                    await queryRunner.addColumn('email_messages', column);
                }
            }
            const withColumns = await queryRunner.getTable('email_messages');
            for (const index of AddAgentEmailSendPolicy1791050000000.MESSAGE_INDICES) {
                if (withColumns && !withColumns.indices.some((i) => i.name === index.name)) {
                    await queryRunner.createIndex('email_messages', index);
                }
            }
            // Always run: a previous attempt may have added `status` and then
            // stopped part-way through the backfill (without a wrapping
            // transaction), and the `IS NULL` guard makes a re-run pick up
            // exactly the rows it left. Skipping when the column already
            // existed would strand those rows with no lifecycle state.
            await this.backfillStatus(queryRunner, 'outbound', 'sent');
            await this.backfillStatus(queryRunner, 'inbound', 'received');
        }

        const organizations = await queryRunner.getTable('organizations');
        if (organizations && !organizations.findColumnByName('email_send_policy')) {
            await queryRunner.addColumn(
                'organizations',
                AddAgentEmailSendPolicy1791050000000.ORGANIZATION_COLUMN,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const organizations = await queryRunner.getTable('organizations');
        const policyColumn = organizations?.findColumnByName('email_send_policy');
        if (policyColumn) {
            await queryRunner.dropColumn('organizations', policyColumn);
        }

        const messages = await queryRunner.getTable('email_messages');
        if (messages) {
            for (const index of AddAgentEmailSendPolicy1791050000000.MESSAGE_INDICES) {
                const existing = messages.indices.find((i) => i.name === index.name);
                if (existing) {
                    await queryRunner.dropIndex('email_messages', existing);
                }
            }
            // Re-read between drops: on the sqlite driver every drop rebuilds
            // the table and the previous Table object goes stale.
            for (const column of AddAgentEmailSendPolicy1791050000000.MESSAGE_COLUMNS) {
                const table = await queryRunner.getTable('email_messages');
                const existing = table?.findColumnByName(column.name);
                if (existing) {
                    await queryRunner.dropColumn('email_messages', existing);
                }
            }
        }

        if (await queryRunner.hasTable('agent_inboxes')) {
            await queryRunner.dropTable('agent_inboxes', true);
        }
    }

    private async createAgentInboxes(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('agent_inboxes')) {
            return;
        }
        await queryRunner.createTable(
            new Table({
                name: 'agent_inboxes',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'userId', type: 'uuid' },
                    { name: 'agentId', type: 'uuid' },
                    { name: 'emailAddressId', type: 'uuid', isNullable: true },
                    { name: 'mode', type: 'varchar', length: '16', default: "'draft-review'" },
                    { name: 'state', type: 'varchar', length: '16', default: "'active'" },
                    { name: 'dailySendCap', type: 'int', isNullable: true },
                    { name: 'burstSendCap', type: 'int', isNullable: true },
                    { name: 'recipientBurstCap', type: 'int', isNullable: true },
                    { name: 'recipientsPerMessageCap', type: 'int', isNullable: true },
                    { name: 'capPausedUntil', type: 'timestamp', isNullable: true },
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'agent_inboxes',
            new TableIndex({
                name: 'uq_agent_inboxes_agent',
                columnNames: ['agentId'],
                isUnique: true,
            }),
        );
        await queryRunner.createIndex(
            'agent_inboxes',
            new TableIndex({
                name: 'idx_agent_inboxes_user_state',
                columnNames: ['userId', 'state'],
            }),
        );

        const foreignKeys: Array<{
            name: string;
            column: string;
            table: string;
            onDelete: string;
        }> = [
            {
                name: 'fk_agent_inboxes_user',
                column: 'userId',
                table: 'users',
                onDelete: 'CASCADE',
            },
            {
                name: 'fk_agent_inboxes_agent',
                column: 'agentId',
                table: 'agents',
                onDelete: 'CASCADE',
            },
            {
                name: 'fk_agent_inboxes_email_address',
                column: 'emailAddressId',
                table: 'tenant_email_addresses',
                onDelete: 'SET NULL',
            },
        ];
        for (const fk of foreignKeys) {
            // A hand-rolled database may be missing a referenced table; the
            // column still works without the constraint.
            if (!(await queryRunner.hasTable(fk.table))) continue;
            await queryRunner.createForeignKey(
                'agent_inboxes',
                new TableForeignKey({
                    name: fk.name,
                    columnNames: [fk.column],
                    referencedTableName: fk.table,
                    referencedColumnNames: ['id'],
                    onDelete: fk.onDelete,
                }),
            );
        }
    }

    /** Batched `status` backfill — ids first, so the UPDATE is portable across drivers. */
    private async backfillStatus(
        queryRunner: QueryRunner,
        direction: 'outbound' | 'inbound',
        status: 'sent' | 'received',
    ): Promise<void> {
        for (;;) {
            const rows = await queryRunner.manager
                .createQueryBuilder()
                .select('m.id', 'id')
                .from('email_messages', 'm')
                .where('m.direction = :direction', { direction })
                .andWhere('m.status IS NULL')
                .limit(AddAgentEmailSendPolicy1791050000000.BACKFILL_BATCH)
                .getRawMany<{ id: string }>();
            if (rows.length === 0) return;
            await queryRunner.manager
                .createQueryBuilder()
                .update('email_messages')
                .set({ status })
                .where('id IN (:...ids)', { ids: rows.map((row) => row.id) })
                .execute();
            if (rows.length < AddAgentEmailSendPolicy1791050000000.BACKFILL_BATCH) return;
        }
    }
}
