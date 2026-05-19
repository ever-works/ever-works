import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Adds the durable control plane for the autonomous Work agent.
 *
 * EW-584 generates Work ideas. These tables sit above that layer and track
 * user-approved high-level goals, guardrails, live run state, and the audit
 * log that the UI can render while a worker plans/researches/writes.
 */
export class AddWorkAgentControlPlane1779700000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('work_agent_preferences'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'work_agent_preferences',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'userId', type: 'uuid', isUnique: true },
                        { name: 'enabled', type: 'boolean', default: false },
                        { name: 'autoApproveLowImpact', type: 'boolean', default: false },
                        { name: 'dailySuggestionsEnabled', type: 'boolean', default: true },
                        { name: 'guardrails', type: 'text' },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
            await queryRunner.createForeignKey(
                'work_agent_preferences',
                new TableForeignKey({
                    name: 'fk_work_agent_preferences_user',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }

        if (!(await queryRunner.hasTable('work_agent_goals'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'work_agent_goals',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'userId', type: 'uuid' },
                        { name: 'instruction', type: 'text' },
                        { name: 'status', type: 'varchar', default: "'pending'" },
                        { name: 'source', type: 'varchar', default: "'user'" },
                        { name: 'dryRun', type: 'boolean', default: false },
                        { name: 'guardrailsOverride', type: 'text', isNullable: true },
                        { name: 'agentPlanSummary', type: 'text', isNullable: true },
                        { name: 'approvalSummary', type: 'text', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
            await queryRunner.createForeignKey(
                'work_agent_goals',
                new TableForeignKey({
                    name: 'fk_work_agent_goals_user',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            await queryRunner.createIndex(
                'work_agent_goals',
                new TableIndex({
                    name: 'idx_work_agent_goals_user_status_created',
                    columnNames: ['userId', 'status', 'createdAt'],
                }),
            );
        }

        if (!(await queryRunner.hasTable('work_agent_runs'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'work_agent_runs',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'userId', type: 'uuid' },
                        { name: 'goalId', type: 'uuid' },
                        { name: 'status', type: 'varchar', default: "'queued'" },
                        { name: 'dryRun', type: 'boolean', default: false },
                        { name: 'progressPercent', type: 'int', default: 0 },
                        { name: 'summary', type: 'text' },
                        { name: 'startedAt', type: 'timestamp', isNullable: true },
                        { name: 'finishedAt', type: 'timestamp', isNullable: true },
                        { name: 'error', type: 'text', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
            await queryRunner.createForeignKey(
                'work_agent_runs',
                new TableForeignKey({
                    name: 'fk_work_agent_runs_user',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            await queryRunner.createForeignKey(
                'work_agent_runs',
                new TableForeignKey({
                    name: 'fk_work_agent_runs_goal',
                    columnNames: ['goalId'],
                    referencedTableName: 'work_agent_goals',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            await queryRunner.createIndex(
                'work_agent_runs',
                new TableIndex({
                    name: 'idx_work_agent_runs_user_status_created',
                    columnNames: ['userId', 'status', 'createdAt'],
                }),
            );
        }

        if (!(await queryRunner.hasTable('work_agent_run_logs'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'work_agent_run_logs',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'userId', type: 'uuid' },
                        { name: 'runId', type: 'uuid' },
                        { name: 'level', type: 'varchar', default: "'info'" },
                        { name: 'step', type: 'varchar', length: '80' },
                        { name: 'message', type: 'text' },
                        { name: 'metadata', type: 'text', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
            await queryRunner.createForeignKey(
                'work_agent_run_logs',
                new TableForeignKey({
                    name: 'fk_work_agent_run_logs_user',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            await queryRunner.createForeignKey(
                'work_agent_run_logs',
                new TableForeignKey({
                    name: 'fk_work_agent_run_logs_run',
                    columnNames: ['runId'],
                    referencedTableName: 'work_agent_runs',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            await queryRunner.createIndex(
                'work_agent_run_logs',
                new TableIndex({
                    name: 'idx_work_agent_run_logs_run_created',
                    columnNames: ['runId', 'createdAt'],
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable('work_agent_run_logs', true);
        await queryRunner.dropTable('work_agent_runs', true);
        await queryRunner.dropTable('work_agent_goals', true);
        await queryRunner.dropTable('work_agent_preferences', true);
    }
}
