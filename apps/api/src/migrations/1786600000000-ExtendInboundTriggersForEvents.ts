import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Task Triggers — extends the inbound-trigger surface to fire from the
 * event-ingest spine, not just the signed webhook endpoint.
 *
 * ## 1. Additive columns on `inbound_triggers`
 *
 *   - `sourceType` varchar(16) NOT NULL DEFAULT 'webhook' — what fires
 *     the trigger: `'webhook'` (existing signed endpoint) or `'event'`
 *     (ingested-event matching). The default makes every existing row
 *     exactly what it always was.
 *   - `eventMatcher` text NULL — `simple-json` matcher
 *     (`{source?, kind?, workId?}`, trailing-`*` wildcards on
 *     source/kind) evaluated against drained `ingested_events` rows.
 *   - `taskDescriptionTemplate` text NULL — description template for
 *     spawned Tasks (safe `{{event.*}}` placeholders); NULL keeps the
 *     built-in payload-dump description.
 *   - `taskTemplateSlug` varchar(80) NULL — RESERVED linkage to
 *     `task_templates` (feature I, parallel branch). A string slug on
 *     purpose — no FK, resolved lazily at fire time through an optional
 *     lookup port, so this schema works standalone today and lights up
 *     when that table lands.
 *
 * ## 2. New table `inbound_trigger_fires`
 *
 * The idempotency ledger of the event-firing path: one row per
 * (trigger, event) fire, UNIQUE on that pair. The ingest drain retries
 * batches after partial failures, so the same event is offered to the
 * same trigger repeatedly — the insert-if-new claim on this index is
 * what makes "one event fires a trigger once" true across retries and
 * process crashes. `eventId` is deliberately NOT a FK to
 * `ingested_events` (the ledger must outlive event-row pruning);
 * `triggerId` cascades with its trigger.
 *
 * Entity: `packages/agent/src/entities/inbound-trigger-fire.entity.ts`.
 *
 * Forward-only with idempotent per-step guards (house pattern, mirrors
 * 1784800000000-AddTaskDelegationDepth + 1785000000000-CreateTermsAcceptance).
 * Built with TypeORM's portable APIs because CI/e2e run better-sqlite3
 * while production runs Postgres.
 */
export class ExtendInboundTriggersForEvents1786600000000 implements MigrationInterface {
    name = 'ExtendInboundTriggersForEvents1786600000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const triggers = await queryRunner.getTable('inbound_triggers');
        if (triggers) {
            if (!triggers.findColumnByName('sourceType')) {
                await queryRunner.query(
                    `ALTER TABLE "inbound_triggers" ADD COLUMN "sourceType" varchar(16) NOT NULL DEFAULT 'webhook'`,
                );
            }
            if (!triggers.findColumnByName('eventMatcher')) {
                await queryRunner.query(
                    `ALTER TABLE "inbound_triggers" ADD COLUMN "eventMatcher" text`,
                );
            }
            if (!triggers.findColumnByName('taskDescriptionTemplate')) {
                await queryRunner.query(
                    `ALTER TABLE "inbound_triggers" ADD COLUMN "taskDescriptionTemplate" text`,
                );
            }
            if (!triggers.findColumnByName('taskTemplateSlug')) {
                await queryRunner.query(
                    `ALTER TABLE "inbound_triggers" ADD COLUMN "taskTemplateSlug" varchar(80)`,
                );
            }
        }

        if (!(await queryRunner.hasTable('inbound_trigger_fires'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'inbound_trigger_fires',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'triggerId', type: 'uuid' },
                        // ingested_events.id as identity, not a FK — see header.
                        { name: 'eventId', type: 'varchar', length: '80' },
                        { name: 'taskId', type: 'uuid', isNullable: true },
                        { name: 'firedAt', type: 'timestamp', default: 'now()' },
                    ],
                }),
                true,
            );

            // THE idempotency guarantee — a trigger claims an event once.
            await queryRunner.createIndex(
                'inbound_trigger_fires',
                new TableIndex({
                    name: 'idx_inbound_trigger_fires_dedupe',
                    columnNames: ['triggerId', 'eventId'],
                    isUnique: true,
                }),
            );
            await queryRunner.createIndex(
                'inbound_trigger_fires',
                new TableIndex({
                    name: 'idx_inbound_trigger_fires_trigger',
                    columnNames: ['triggerId'],
                }),
            );
            await queryRunner.createForeignKey(
                'inbound_trigger_fires',
                new TableForeignKey({
                    name: 'fk_inbound_trigger_fires_trigger',
                    columnNames: ['triggerId'],
                    referencedTableName: 'inbound_triggers',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('inbound_trigger_fires')) {
            await queryRunner.dropTable('inbound_trigger_fires', true);
        }

        const triggers = await queryRunner.getTable('inbound_triggers');
        if (!triggers) return;
        // Safe to drop: `sourceType`/`eventMatcher`/templates are trigger
        // configuration the owner re-enters; reverting disables event
        // firing, it does not destroy evidence.
        for (const column of [
            'taskTemplateSlug',
            'taskDescriptionTemplate',
            'eventMatcher',
            'sourceType',
        ]) {
            if (triggers.findColumnByName(column)) {
                await queryRunner.query(
                    `ALTER TABLE "inbound_triggers" DROP COLUMN "${column}"`,
                );
            }
        }
    }
}
