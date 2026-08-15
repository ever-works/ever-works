import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Tasks upgrades — workflow Task Templates.
 *
 * `task_templates`      — a reusable multi-step workflow shape owned by
 *                         a user. Slug unique PER USER (each user gets
 *                         their own seeded defaults; global unique would
 *                         collide on the second user — same reasoning as
 *                         `uq_tasks_slug`).
 * `task_template_steps` — ordered steps; `position` is the key that
 *                         `dependsOn` (simple-json int[]) references.
 *                         Instantiation turns steps into sub-tasks,
 *                         dependsOn into `task_blocks` edges, agent
 *                         bindings into `task_assignees`, and
 *                         `requiresApproval` into `task_approvers` rows
 *                         — one transaction, see TaskTemplatesService.
 *
 * ## Deliberately NO scope XOR CHECK
 *
 * Same reasoning as 1784820000000-CreateWorkflows: `ScopeStampingSubscriber`
 * stamps `organizationId` on every insert for entities declaring both
 * scope columns, so ordinary rows carry BOTH and an XOR would abort on
 * real data.
 *
 * ## Portable DDL
 *
 * TypeORM `Table`/`TableIndex`/`TableForeignKey` API rather than raw
 * SQL: CI runs better-sqlite3, production runs Postgres. Forward-only
 * with idempotent guards (house pattern).
 */
export class CreateTaskTemplates1786860001000 implements MigrationInterface {
    name = 'CreateTaskTemplates1786860001000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('task_templates'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'task_templates',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'userId', type: 'uuid' },
                        { name: 'name', type: 'varchar', length: '200' },
                        { name: 'slug', type: 'varchar', length: '80' },
                        { name: 'description', type: 'text', isNullable: true },
                        // simple-json ⇒ text on every driver.
                        { name: 'labels', type: 'text', isNullable: true },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'now()' },
                        { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                    ],
                }),
                true,
            );

            await queryRunner.createIndex(
                'task_templates',
                new TableIndex({
                    name: 'uq_task_templates_slug',
                    columnNames: ['userId', 'slug'],
                    isUnique: true,
                }),
            );
            await queryRunner.createIndex(
                'task_templates',
                new TableIndex({
                    name: 'idx_task_templates_org',
                    columnNames: ['organizationId'],
                }),
            );

            // Guarded on the users table existing: this migration must not
            // explode on a fresh database bootstrap order.
            if (await queryRunner.hasTable('users')) {
                await queryRunner.createForeignKey(
                    'task_templates',
                    new TableForeignKey({
                        name: 'fk_task_templates_user',
                        columnNames: ['userId'],
                        referencedTableName: 'users',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    }),
                );
            }
        }

        if (!(await queryRunner.hasTable('task_template_steps'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'task_template_steps',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'templateId', type: 'uuid' },
                        { name: 'position', type: 'int' },
                        { name: 'title', type: 'varchar', length: '200' },
                        { name: 'prompt', type: 'text', isNullable: true },
                        { name: 'agentId', type: 'uuid', isNullable: true },
                        {
                            name: 'agentTemplateSlug',
                            type: 'varchar',
                            length: '80',
                            isNullable: true,
                        },
                        { name: 'requiresApproval', type: 'boolean', default: false },
                        // simple-json int[] of depended-on positions.
                        { name: 'dependsOn', type: 'text', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    ],
                }),
                true,
            );

            await queryRunner.createIndex(
                'task_template_steps',
                new TableIndex({
                    name: 'idx_task_template_steps_template',
                    columnNames: ['templateId', 'position'],
                }),
            );

            if (await queryRunner.hasTable('task_templates')) {
                await queryRunner.createForeignKey(
                    'task_template_steps',
                    new TableForeignKey({
                        name: 'fk_task_template_steps_template',
                        columnNames: ['templateId'],
                        referencedTableName: 'task_templates',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    }),
                );
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Destroys user-authored templates — acceptable only because it
        // removes the feature wholesale (see CreateWorkflows down note).
        if (await queryRunner.hasTable('task_template_steps')) {
            await queryRunner.dropTable('task_template_steps');
        }
        if (await queryRunner.hasTable('task_templates')) {
            await queryRunner.dropTable('task_templates');
        }
    }
}
