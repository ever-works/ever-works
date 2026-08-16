import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * The `inbox_items` table — the Inbox (operator message center).
 *
 * ## Why
 *
 * One surface where agents / works / the system put messages FOR the
 * human: blocking questions (`ask_human` parks the run until the reply
 * resumes it), approval requests mirroring pending action proposals,
 * escalation mirrors, and plain system notices — with unread state,
 * archive, and the recorded answer (free text and/or a structured
 * option id).
 *
 * The fragments already existed (agent_escalations,
 * agent_action_proposals, notifications, parked runs) but none carries
 * an unread flag, a structured option list AND the recorded answer.
 * Inbox rows are written ADDITIVELY alongside those records — the
 * fragment rows stay the system of record for their own lifecycle.
 *
 * ## Shape
 *
 * Cross-links (`agentId` / `agentRunId` / `taskId` / `workId` /
 * `escalationId` / `proposalId`) are raw nullable uuids with NO FKs,
 * matching `agent_escalations`: an inbox item must survive the
 * deletion of what it describes — "what did the agent ask me last
 * week?" is still a valid question after the run is gone. Scope
 * columns follow EW-651 Tier C (nullable tenantId/organizationId, no
 * entity-level @ManyToOne).
 *
 * `options` / dates use the portable column shapes (`text` simple-json
 * + `timestamp`) because CI and the e2e stack run better-sqlite3 while
 * production runs Postgres.
 *
 * Also seeds the four `inbox_*` notification event keys on Postgres —
 * the api-side `NotificationEventTypeBootstrap` upserts the same rows
 * on every boot, so this INSERT only matters for deployments that
 * never run the bootstrap. Forward-only + idempotent (`hasTable`
 * guards), house pattern per 1785000000000-CreateTermsAcceptance.
 */
export class CreateInboxItems1786870000000 implements MigrationInterface {
    name = 'CreateInboxItems1786870000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('inbox_items'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'inbox_items',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'userId', type: 'uuid' },
                        { name: 'kind', type: 'varchar', length: '16' },
                        { name: 'title', type: 'varchar', length: '300' },
                        { name: 'body', type: 'text' },
                        { name: 'options', type: 'text', isNullable: true },
                        { name: 'sourceType', type: 'varchar', length: '24' },
                        { name: 'agentId', type: 'uuid', isNullable: true },
                        { name: 'agentRunId', type: 'uuid', isNullable: true },
                        { name: 'taskId', type: 'uuid', isNullable: true },
                        { name: 'workId', type: 'uuid', isNullable: true },
                        { name: 'escalationId', type: 'uuid', isNullable: true },
                        { name: 'proposalId', type: 'uuid', isNullable: true },
                        { name: 'status', type: 'varchar', length: '16', default: `'open'` },
                        { name: 'unread', type: 'boolean', default: true },
                        { name: 'answeredAt', type: 'timestamp', isNullable: true },
                        { name: 'answerText', type: 'text', isNullable: true },
                        {
                            name: 'answerOptionId',
                            type: 'varchar',
                            length: '64',
                            isNullable: true,
                        },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'now()' },
                        { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                    ],
                }),
                true,
            );

            for (const index of [
                // The inbox list: one user's messages by status, unread first.
                new TableIndex({
                    name: 'idx_inbox_items_user_status_unread',
                    columnNames: ['userId', 'status', 'unread'],
                }),
                // Producer dedup: at most one item mirrors an escalation…
                new TableIndex({
                    name: 'idx_inbox_items_escalation',
                    columnNames: ['escalationId'],
                }),
                // …or a proposal.
                new TableIndex({
                    name: 'idx_inbox_items_proposal',
                    columnNames: ['proposalId'],
                }),
            ]) {
                await queryRunner.createIndex('inbox_items', index);
            }
        }

        // Notifications v2 — register the inbox fanout event keys.
        // Idempotent by PK; the api-side bootstrap upserts the same rows
        // on every boot (SQLite/CI never runs this branch).
        if (await queryRunner.hasTable('notification_event_types')) {
            const rows: Array<[string, string, string, string, boolean]> = [
                [
                    'inbox_question',
                    'agent',
                    'Agent asked a question',
                    'An agent paused its run on a blocking question and is waiting for your reply in the Inbox.',
                    true,
                ],
                [
                    'inbox_approval_requested',
                    'agent',
                    'Approval requested',
                    'An agent proposed a side-effectful action and is waiting for your approval in the Inbox.',
                    false,
                ],
                [
                    'inbox_escalation',
                    'agent',
                    'Agent escalation in your Inbox',
                    'An agent stopped without finishing and the escalation is waiting in your Inbox.',
                    false,
                ],
                [
                    'inbox_notice',
                    'system',
                    'Inbox notice',
                    'The platform filed a notice in your Inbox.',
                    false,
                ],
            ];
            for (const [key, category, title, description, urgent] of rows) {
                await queryRunner.query(
                    `INSERT INTO notification_event_types
                       (key, category, title, description, urgent, "defaultChannels", source, "pluginId", "createdAt", "updatedAt")
                     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'core', NULL, now(), now())
                     ON CONFLICT (key) DO NOTHING`,
                    [key, category, title, description, urgent, JSON.stringify(['in-app'])],
                );
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('notification_event_types')) {
            await queryRunner.query(
                `DELETE FROM "notification_event_types" WHERE "key" IN ('inbox_question', 'inbox_approval_requested', 'inbox_escalation', 'inbox_notice')`,
            );
        }
        if (await queryRunner.hasTable('inbox_items')) {
            await queryRunner.dropTable('inbox_items', true);
        }
    }
}
