import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Two tables, one migration, because they are two halves of the same
 * story: what happens when an agent stops without finishing.
 *
 * ## `agent_escalations` (judgment layer G3)
 *
 * The structured record written whenever an agent GIVES UP — gate
 * exhausted, guardrail refusal, budget stop, merge refused, run parked,
 * queued too long. Read by the Task detail and the digest.
 *
 * Not folded into `activity_log`, deliberately: that table is
 * user+Work scoped with no `taskId`, no resolution state and a 500-char
 * `summary`, so reusing it would have meant adding all three to a table
 * every feature writes to. The columns here exist because an escalation
 * has to be *answerable*: `decisionNeeded` says what a human must decide,
 * `attempted` says what was already tried, and `status`/`resolvedBy*`
 * close it.
 *
 * `dedupKey` is UNIQUE and load-bearing: the writers are a Trigger.dev
 * task that can retry, a sweeper tick that re-scans the same rows, and a
 * webhook that can be redelivered. Without it one give-up would render as
 * five identical cards.
 *
 * ## `task_review_rejections` (orchestration M9)
 *
 * The **minimal durable review record** the rejection-feedback-on-resume
 * loop needed and the schema did not have: `task_reviewers.reviewState`
 * carries a three-value enum and no text, and the PR review loop kept
 * nothing locally. This table persists the words, so
 * `RunSteeringService.resume` can prepend them to the next run.
 *
 * Task-scoped rather than run-scoped because the rejected run is already
 * terminal and the resumed one is a NEW row (runs are immutable), so the
 * Task is the only stable join. `consumedByRunId` is the entire state
 * machine: NULL = pending replay, set = replayed exactly once (the claim
 * is CAS'd on `IS NULL`).
 *
 * Both tables: `uuid_generate_v4()` default + `now()` timestamps, matching
 * every sibling (`1783900000000-CreateFleetNodes`). Scope columns are raw
 * uuid references with no entity-level `@ManyToOne` (cycle avoidance per
 * EW-654). No FKs to `tasks`/`agent_runs`: both records are audit trail
 * that must SURVIVE the deletion of what they describe — an escalation
 * whose Task was deleted is still the answer to "why did nobody finish
 * this?".
 *
 * Forward-only + idempotent (`hasTable` guards).
 */
export class CreateEscalationsAndReviewRejections1784600000000 implements MigrationInterface {
    name = 'CreateEscalationsAndReviewRejections1784600000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('agent_escalations'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'agent_escalations',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'userId', type: 'uuid' },
                        { name: 'reasonCode', type: 'varchar', length: '32' },
                        { name: 'status', type: 'varchar', length: '16', default: `'open'` },
                        { name: 'runId', type: 'uuid', isNullable: true },
                        { name: 'taskId', type: 'uuid', isNullable: true },
                        { name: 'workId', type: 'uuid', isNullable: true },
                        { name: 'agentId', type: 'uuid', isNullable: true },
                        { name: 'summary', type: 'varchar', length: '500' },
                        { name: 'decisionNeeded', type: 'text' },
                        { name: 'attempted', type: 'text', isNullable: true },
                        { name: 'resolvedByUserId', type: 'uuid', isNullable: true },
                        { name: 'resolutionNote', type: 'text', isNullable: true },
                        { name: 'resolvedAt', type: 'timestamp', isNullable: true },
                        {
                            name: 'dedupKey',
                            type: 'varchar',
                            length: '200',
                            isNullable: true,
                            isUnique: true,
                        },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    ],
                }),
                true,
            );

            for (const index of [
                new TableIndex({
                    name: 'idx_agent_escalation_task_status',
                    columnNames: ['taskId', 'status'],
                }),
                new TableIndex({
                    name: 'idx_agent_escalation_work_status',
                    columnNames: ['workId', 'status'],
                }),
                new TableIndex({
                    name: 'idx_agent_escalation_user_status',
                    columnNames: ['userId', 'status'],
                }),
            ]) {
                await queryRunner.createIndex('agent_escalations', index);
            }
        }

        if (!(await queryRunner.hasTable('task_review_rejections'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'task_review_rejections',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'taskId', type: 'uuid' },
                        { name: 'workId', type: 'uuid', isNullable: true },
                        { name: 'runId', type: 'uuid', isNullable: true },
                        { name: 'source', type: 'varchar', length: '16' },
                        { name: 'reviewerUserId', type: 'uuid', isNullable: true },
                        {
                            name: 'reviewerLabel',
                            type: 'varchar',
                            length: '200',
                            isNullable: true,
                        },
                        { name: 'feedback', type: 'text' },
                        { name: 'prNumber', type: 'int', isNullable: true },
                        { name: 'prUrl', type: 'varchar', length: '500', isNullable: true },
                        { name: 'consumedByRunId', type: 'uuid', isNullable: true },
                        { name: 'consumedAt', type: 'timestamp', isNullable: true },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    ],
                }),
                true,
            );

            for (const index of [
                // The resume lookup: pending rejections for a Task.
                new TableIndex({
                    name: 'idx_task_review_rejection_task_consumed',
                    columnNames: ['taskId', 'consumedByRunId'],
                }),
                new TableIndex({
                    name: 'idx_task_review_rejection_work',
                    columnNames: ['workId'],
                }),
            ]) {
                await queryRunner.createIndex('task_review_rejections', index);
            }
        }

        // Notifications v2 — register the two attention event types the
        // M6 sweeper and the G3 escalation writer fan out on. Idempotent
        // by PK; the api-side `NotificationEventTypeBootstrapService`
        // upserts the same rows on every boot, so this INSERT only
        // matters for Postgres deployments that never run the bootstrap.
        if (await queryRunner.hasTable('notification_event_types')) {
            const rows: Array<[string, string, string, string]> = [
                [
                    'agent_run_queued_too_long',
                    'agent',
                    'Agent run queued too long',
                    'An agent run has been waiting for capacity longer than the configured bound. Nothing was cancelled.',
                ],
                [
                    'agent_run_escalated',
                    'agent',
                    'Agent needs a decision',
                    'An agent stopped without finishing (checks exhausted, guardrail refusal, budget stop or refused merge) and a human decision is required.',
                ],
            ];
            for (const [key, category, title, description] of rows) {
                await queryRunner.query(
                    `INSERT INTO notification_event_types
                       (key, category, title, description, urgent, "defaultChannels", source, "pluginId", "createdAt", "updatedAt")
                     VALUES ($1, $2, $3, $4, false, $5::jsonb, 'core', NULL, now(), now())
                     ON CONFLICT (key) DO NOTHING`,
                    [key, category, title, description, JSON.stringify(['in-app'])],
                );
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('notification_event_types')) {
            await queryRunner.query(
                `DELETE FROM "notification_event_types" WHERE "key" IN ('agent_run_queued_too_long', 'agent_run_escalated')`,
            );
        }
        if (await queryRunner.hasTable('task_review_rejections')) {
            await queryRunner.dropTable('task_review_rejections', true);
        }
        if (await queryRunner.hasTable('agent_escalations')) {
            await queryRunner.dropTable('agent_escalations', true);
        }
    }
}
