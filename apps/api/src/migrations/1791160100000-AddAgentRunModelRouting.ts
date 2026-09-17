import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Model accounts (AW-16, phase 1) — `agent_runs.modelRouting`, the record of
 * what actually answered a Run.
 *
 * Entity: `packages/agent/src/entities/agent-run.entity.ts`.
 *
 * A nullable `text` column holding the `simple-json` routing record the AI
 * facade writes from the provider's response: provider, model, the Model
 * Account used (id and name, never its credentials), the requested effort and
 * the run timeout. No default and no backfill — a Run that predates this
 * migration genuinely has no routing record and must never appear to claim
 * one.
 *
 * Forward-only + idempotent (`findColumnByName` guard), portable
 * `TableColumn` DDL. `down()` drops exactly the one column `up()` added.
 */
export class AddAgentRunModelRouting1791160100000 implements MigrationInterface {
    name = 'AddAgentRunModelRouting1791160100000';

    private static readonly COLUMN = new TableColumn({
        name: 'modelRouting',
        type: 'text',
        isNullable: true,
    });

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('agent_runs');
        if (!table) return;
        if (!table.findColumnByName(AddAgentRunModelRouting1791160100000.COLUMN.name)) {
            await queryRunner.addColumn('agent_runs', AddAgentRunModelRouting1791160100000.COLUMN);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('agent_runs');
        const existing = table?.findColumnByName(AddAgentRunModelRouting1791160100000.COLUMN.name);
        if (existing) {
            await queryRunner.dropColumn('agent_runs', existing);
        }
    }
}
